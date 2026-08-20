import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";

/**
 * WHICH items still need partitioning — the candidate predicate (TICKSTALL-2 slice A,
 * `docs/design/backfill-sweep-o-backlog.md`).
 *
 * WHY. The sweep used to page EVERY item and call `reconcileItemContext` on each, relying on
 * reconcile being idempotent. Measured on prod that was ~1.3 s per item to re-confirm 2,672
 * already-finished items in order to fix 6 — a 13.5-minute average stage against a 30-minute tick,
 * and a cost proportional to how much is STORED rather than how much needs DOING.
 *
 * THE DANGEROUS DIRECTION, and why this file is mostly comment. A predicate that is wrong the "no
 * work" way SILENTLY SKIPS an item that needs partitioning, leaving it visible to NOBODY under an
 * enforced read (`lib/access/enforce` requires a current `include` into a granted project). That is
 * strictly worse than the slowness it replaces, and it is invisible. Two independent spec cold reads
 * rejected earlier definitions of this predicate; the arms below are what survived.
 *
 * `runSql`, not the query builder, because `NOT EXISTS` is not expressible through `lib/db/pg`'s
 * `eq`/`gt`/`in`/`is` surface and the alternative — fetch every id and filter in JS — is exactly the
 * O(corpus) read this exists to delete.
 */

/** One page of items needing reconcile, in `id` order for keyset paging. */
export interface CandidatePage {
  ids: string[];
}

/**
 * AUDIENCE IS `items.access`, NOT `project_context_units.audience` — the single most load-bearing
 * choice here, and the one a spec review caught.
 *
 * There are two audiences in this system: `items.access` (current) and `units.audience` (a MIRROR
 * that stays stale until reconcile re-mirrors it). The precise state this sweep exists to back up is
 * a tier flip whose `settleReclassification` fan-out failed — and that fan-out is best-effort by
 * design (`lib/ingest/reclassify`) — which leaves `items.access` flipped, `units.audience` STALE and
 * the membership sitting in the old system project. Keyed on the stale mirror, every arm below reads
 * "already correct" and the item is NEVER selected: for external→team that serves team content
 * through `external-shared` permanently.
 */
const CANDIDATE_SQL = `
with sys as (
  select
    (select id from projects where team_id = $1 and kind = 'system' and slug = $2 limit 1) as general_id,
    (select id from projects where team_id = $1 and kind = 'system' and slug = $3 limit 1) as external_id
),
scoped as (
  select i.id,
         case when i.access = 'external' then sys.external_id else sys.general_id end as target_id,
         case when i.access = 'external' then sys.general_id else sys.external_id end as opposite_id
    from items i cross join sys
   where i.team_id = $1
     and ($4::uuid is null or i.id > $4::uuid)
     and ($5::timestamptz is null or i.created_at < $5::timestamptz)
)
select s.id
  from scoped s
 where (
   -- ARM 1 — no item-grain context unit at all. unit_kind='item' matches reconcileItemUnit's own
   -- lookup, so "has a unit" here means the same row reconcile would find and update.
   not exists (
     select 1 from project_context_units u
      where u.team_id = $1 and u.source_item_id = s.id and u.unit_kind = 'item'
   )
   -- ARM 2 — no current INCLUDE membership in the TARGET system project. include specifically:
   -- the enforced read filters on it, so an exclude is invisible to readers while looking present.
   or not exists (
     select 1 from project_context_units u
       join project_context_memberships m
         on m.team_id = u.team_id and m.context_unit_id = u.id
      where u.team_id = $1 and u.source_item_id = s.id and u.unit_kind = 'item'
        and m.valid_to is null and m.decision = 'include' and m.project_id = s.target_id
   )
   -- ARM 3 — still a current membership in the OPPOSITE system project: a tier flip that was never
   -- moved. ANY decision, because reconcile's closeMembershipInto closes regardless of decision;
   -- narrowing this to 'include' would leave a stale exclude behind.
   or exists (
     select 1 from project_context_units u
       join project_context_memberships m
         on m.team_id = u.team_id and m.context_unit_id = u.id
      where u.team_id = $1 and u.source_item_id = s.id and u.unit_kind = 'item'
        and m.valid_to is null and m.project_id = s.opposite_id
   )
 )
 -- EXCLUDE-SHADOW EXCLUSION — NARROWED to EXPLICIT excludes (EXCLSHADOW-1). An AUTOMATIC
 -- (mode='auto') exclude in the target project is now REPAIRABLE (ensureIncludeMembership
 -- branches on the row and repairs close-first), so auto shadows are SELECTED and healed.
 -- An explicit (force_*) exclude is an operator's recorded decision the sweep must never
 -- overwrite (classification invariant 3) AND cannot repair — selecting it would burn ~1.3s
 -- of reconcile every tick forever and keep scanned off zero. Excluded and counted.
 -- KNOWN EDGE, stated not buried: a force-shadowed item that ALSO has an opposite-project
 -- membership keeps that membership, because we skip the whole item.
 and not exists (
   select 1 from project_context_units u
     join project_context_memberships m
       on m.team_id = u.team_id and m.context_unit_id = u.id
    where u.team_id = $1 and u.source_item_id = s.id and u.unit_kind = 'item'
      and m.valid_to is null and m.decision = 'exclude' and m.mode <> 'auto' and m.project_id = s.target_id
 )
 -- RETRACTED-UNIT EXCLUSION, same class as the shadow above and found by the same review.
 -- Enforced reads require state='active' (lib/access/enforce), but reconcileItemUnit never WRITES
 -- state — it only updates audience/sha/occurred_at on an existing row. So a retracted unit is
 -- invisible to readers AND unrepairable by the sweep: selecting it would burn a reconcile every
 -- tick and hold scanned off zero forever. Excluded and COUNTED, exactly like the exclude-shadow.
 -- Nothing writes 'retracted' today (enforce says so in its own comment), so this is latent.
 and not exists (
   select 1 from project_context_units u
    where u.team_id = $1 and u.source_item_id = s.id and u.unit_kind = 'item'
      and u.state <> 'active'
 )
 order by s.id
 limit $6`;

/**
 * Items needing reconcile, `id`-ordered after `afterId`, bounded by `createdBefore` and `limit`.
 *
 * DEFERRED, with the reason (review): `backfillTeamContext` already resolves the two system project
 * ids and this SQL re-resolves them, so the two could drift apart — which is exactly the bug this
 * slice fixed in `resolveSystemProjectIds` (it lacked `kind='system'`). Binding the resolved uuids as
 * parameters would delete both the duplication and the NULL-system-projects case entirely. Not done
 * here because it is a structural change arriving after two rounds of folds, and the NULL direction
 * is already the SAFE one: with no system projects every membership comparison is NULL, so arm 2
 * matches nothing inside its NOT EXISTS and the whole corpus is selected — expensive and loud, not
 * silent. Unreachable through the only caller anyway (it gates on bootstrap + the resolver first).
 */
export async function selectCandidateItemIds(
  teamId: string,
  opts: { afterId?: string | null; createdBefore?: string | null; limit: number }
): Promise<CandidatePage> {
  const res = await runSql<{ id: string }>(CANDIDATE_SQL, [
    teamId,
    GENERAL_SLUG,
    EXTERNAL_SHARED_SLUG,
    opts.afterId ?? null,
    opts.createdBefore ?? null,
    opts.limit,
  ]);
  return { ids: res.rows.map((r) => r.id) };
}

const UNREPAIRABLE_SQL = `
with sys as (
  select
    (select id from projects where team_id = $1 and kind = 'system' and slug = $2 limit 1) as general_id,
    (select id from projects where team_id = $1 and kind = 'system' and slug = $3 limit 1) as external_id
)
select
  count(distinct i.id) filter (
    where m.id is not null and m.valid_to is null and m.decision = 'exclude' and m.mode <> 'auto'
      and m.project_id = (case when i.access = 'external' then sys.external_id else sys.general_id end)
  )::int as exclude_shadows,
  count(distinct i.id) filter (where u.state <> 'active')::int as retracted_units
  from items i
  cross join sys
  join project_context_units u
    on u.team_id = i.team_id and u.source_item_id = i.id and u.unit_kind = 'item'
  left join project_context_memberships m
    on m.team_id = u.team_id and m.context_unit_id = u.id
 where i.team_id = $1`;

/** The two states the sweep deliberately will NOT repair. `null` means the count could not be taken. */
export interface UnrepairableCounts {
  excludeShadows: number;
  retractedUnits: number;
}

/**
 * How many items sit in a state this sweep skips on purpose — the ONLY thing that makes those holes
 * visible, since the obvious prod check (`items` minus `project_context_units`) cannot see either:
 * both have a unit. Repair is EXCLSHADOW-1.
 *
 * Returns `null` on failure rather than zeros. An earlier version caught and returned 0, which made
 * "the metric could not be read" indistinguishable from "there are none" — the exact silent direction
 * this metric exists to prevent, and the reason a reviewer blocked it.
 */
export async function countUnrepairable(teamId: string): Promise<UnrepairableCounts | null> {
  try {
    const res = await runSql<{ exclude_shadows: number; retracted_units: number }>(UNREPAIRABLE_SQL, [
      teamId,
      GENERAL_SLUG,
      EXTERNAL_SHARED_SLUG,
    ]);
    const row = res.rows[0];
    if (!row) return { excludeShadows: 0, retractedUnits: 0 };
    return { excludeShadows: row.exclude_shadows ?? 0, retractedUnits: row.retracted_units ?? 0 };
  } catch {
    return null;
  }
}
