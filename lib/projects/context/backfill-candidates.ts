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
   -- ARM 1 — no context unit at all. Matches reconcileItemUnit's own lookup, which ignores state,
   -- so a retracted unit counts as missing rather than as done.
   not exists (
     select 1 from project_context_units u
      where u.team_id = $1 and u.source_item_id = s.id
   )
   -- ARM 2 — no current INCLUDE membership in the TARGET system project. include specifically:
   -- the enforced read filters on it, so an exclude is invisible to readers while looking present.
   or not exists (
     select 1 from project_context_units u
       join project_context_memberships m
         on m.team_id = u.team_id and m.context_unit_id = u.id
      where u.team_id = $1 and u.source_item_id = s.id
        and m.valid_to is null and m.decision = 'include' and m.project_id = s.target_id
   )
   -- ARM 3 — still a current membership in the OPPOSITE system project: a tier flip that was never
   -- moved. ANY decision, because reconcile's closeMembershipInto closes regardless of decision;
   -- narrowing this to 'include' would leave a stale exclude behind.
   or exists (
     select 1 from project_context_units u
       join project_context_memberships m
         on m.team_id = u.team_id and m.context_unit_id = u.id
      where u.team_id = $1 and u.source_item_id = s.id
        and m.valid_to is null and m.project_id = s.opposite_id
   )
 )
 -- EXCLUDE-SHADOW EXCLUSION. A current exclude in the target project makes reconcile a silent
 -- no-op (ensureIncludeMembership matches any current row regardless of decision), so selecting
 -- such an item would burn ~1.3 s of reconcile every tick forever and keep scanned off zero —
 -- poisoning the only signal that says the sweep has caught up. Detection instead of repair: the
 -- count below, and EXCLSHADOW-1 owns the fix.
 -- KNOWN EDGE, stated not buried: a shadow that ALSO has an opposite-project membership keeps that
 -- membership, because we skip the whole item. That is EXCLSHADOW-1's territory too.
 and not exists (
   select 1 from project_context_units u
     join project_context_memberships m
       on m.team_id = u.team_id and m.context_unit_id = u.id
    where u.team_id = $1 and u.source_item_id = s.id
      and m.valid_to is null and m.decision = 'exclude' and m.project_id = s.target_id
 )
 order by s.id
 limit $6`;

/** Items needing reconcile, `id`-ordered after `afterId`, bounded by `createdBefore` and `limit`. */
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

const SHADOW_COUNT_SQL = `
with sys as (
  select
    (select id from projects where team_id = $1 and kind = 'system' and slug = $2 limit 1) as general_id,
    (select id from projects where team_id = $1 and kind = 'system' and slug = $3 limit 1) as external_id
)
select count(*)::int as n
  from items i
  cross join sys
  join project_context_units u on u.team_id = i.team_id and u.source_item_id = i.id
  join project_context_memberships m on m.team_id = u.team_id and m.context_unit_id = u.id
 where i.team_id = $1
   and m.valid_to is null and m.decision = 'exclude'
   and m.project_id = (case when i.access = 'external' then sys.external_id else sys.general_id end)`;

/**
 * How many items are stuck in the exclude-shadow state — deliberately NOT repaired here, so this is
 * the only thing that makes them visible. Without it the hole is silent: the obvious prod check
 * (`items` minus `project_context_units`) cannot see it, because a shadowed item HAS a unit.
 *
 * Best-effort: a failure reports 0 rather than throwing, because a broken observability count must
 * not fail the sweep that is doing real work. It is a metric, not a gate.
 */
export async function countExcludeShadows(teamId: string): Promise<number> {
  try {
    const res = await runSql<{ n: number }>(SHADOW_COUNT_SQL, [teamId, GENERAL_SLUG, EXTERNAL_SHARED_SLUG]);
    return res.rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}
