import "server-only";
import type { DbClient } from "@/lib/db/types";
import { runSql } from "@/lib/db/pg/pool";
import { EVERYONE_SLUG, EXTERNAL_SLUG } from "@/lib/access/groups";

/**
 * READ-ONLY coverage query over the §11 context substrate: which of a team's items have no
 * membership, i.e. exactly the rows an `enforcing` read would serve to nobody.
 *
 * It lives in its own module rather than inside its caller for a structural reason: the
 * access-chain single-writer guard flags any file that so much as NAMES `project_context_units` /
 * `project_context_memberships` while containing a write verb (the variable-table-name net). A
 * module that only reads them can never be that file, so the coverage question stays expressible
 * without adding an exemption that would also blunt the net for real writes.
 *
 * Kept deliberately separate from `backfillAllTeams`'s cheap count heuristic (`memberships >=
 * items`), which is a scheduler-tick optimization: counts can agree while a specific item is
 * uncovered (one item in two projects masks another in none). A caller about to change what a
 * whole team can see needs the per-item answer, not the aggregate.
 *
 * ## AUDITFIX-15A — this module is the ONE owner of "can anybody read this item?"
 *
 * It used to decide reachability from the existence of a `project_groups` GRANT. The oracle needs
 * more: an ELIGIBLE PRINCIPAL must hold a `group_members` row in a granted group
 * (`lib/access/oracle.ts:74-104`). **So a project granted only to a group nobody is in read as
 * covered while nobody could read it** — and `assessAccessHealth` turned that under-report into a
 * clean bill of health. Measured on prod 2026-08-22: `external-shared` is granted to `external`,
 * which has ZERO eligible members; harmless only because `everyone` also holds a grant.
 *
 * ⚠️ WHAT THIS ANSWERS, EXACTLY: "does NO eligible principal at all reach this item" — **universal
 * unreachability**, not access-health and not intended-audience correctness. Strip General's
 * `everyone` grant but leave a custom group holding one agent and every HUMAN goes blind while this
 * count stays 0. The per-human floor is a different question and lives in `assessAccessHealth`'s
 * other arms. Naming it more broadly would be a claim the query does not support.
 */

/** The bound on the unreachable set a single call will enumerate. Beyond it the count is a FLOOR
 *  (`truncated`), which is the only honest thing to say — the old paging loop had the same contract
 *  spelled as a batch guard. */
const MAX_UNREACHABLE = 5_000;

export interface CoverageResult {
  scanned: number;
  /** Items NO ELIGIBLE PRINCIPAL can reach — the full oracle chain, not "the project has a grant".
   *  ⚠️ This comment used to describe the grant-only predicate, i.e. the defect AUDITFIX-15A fixed;
   *  it contradicted the module header two screens up. */
  count: number;
  /** Up to `EXAMPLE_LIMIT` paths, so an operator sees WHAT would vanish, not only how much. */
  examples: string[];
  /** True when more than `MAX_UNREACHABLE` unreachable items exist — the count is a FLOOR, not the
   *  total. (It used to mean "the paging loop hit its batch guard"; the loop is gone, the floor
   *  contract is not.) */
  truncated: boolean;
}

const EXAMPLE_LIMIT = 5;

/**
 * THE definition. Every reader goes through this function — not through a second query that means
 * to say the same thing, which is how the two definitions drifted apart in the first place.
 *
 * Each conjunct cites the line it encodes, because the last version of this rule was PROSE and prose
 * is how a proxy predicate gets written twice:
 *
 *   unit        `unit_kind='item'` + `state='active'`         lib/access/enforce.ts:54-67
 *   membership  `decision='include'` + `valid_to is null`     lib/access/enforce.ts:76-87
 *   grant       a `project_groups` row                        lib/access/oracle.ts:98-104
 *   member      active, not a connector, human|agent          lib/access/eligibility.ts:28-30
 *   …if BUILTIN also `kind='human'` and a SANCTIONED slug     lib/access/eligibility.ts:38-40 + oracle.ts:84-95
 *
 * The built-in asymmetry is the clause a generic "is this an active principal" join gets wrong:
 * agents are NEVER auto-admitted by a built-in, so an agent in `everyone` grants nothing while the
 * same agent in a CUSTOM group grants reachability. A built-in with an unknown slug fails closed.
 *
 * NOT conjuncts, asserted by test so nobody re-adds them "for safety" and silently narrows what
 * counts as reachable: `members.tier` (the oracle never re-evaluates it — an explicit built-in row
 * is authoritative), `projects.kind` (`oracle.ts:98-104` does not consult it), membership `mode`.
 *
 * `runSql` because this is a five-way `NOT EXISTS`, which `lib/db/pg`'s `eq`/`in`/`is` surface
 * cannot express — the same justification `backfill-candidates.ts` carries. The module stays
 * READ-ONLY, which is what lets it name these tables at all without tripping the single-writer
 * guard's variable-table-name net.
 */
const UNREACHABLE_SQL = `
select i.id, i.path
  from items i
 where i.team_id = $1
   and not exists (
     select 1
       from project_context_units u
       join project_context_memberships pcm
         on pcm.team_id = u.team_id and pcm.context_unit_id = u.id
       join project_groups pg
         on pg.team_id = pcm.team_id and pg.project_id = pcm.project_id
       join groups g on g.team_id = pg.team_id and g.id = pg.group_id
       join group_members gm on gm.team_id = g.team_id and gm.group_id = g.id
       join members m on m.id = gm.member_id
      where u.team_id = i.team_id
        and u.source_item_id = i.id
        and u.unit_kind = 'item'
        and u.state = 'active'
        and pcm.decision = 'include'
        and pcm.valid_to is null
        and m.status = 'active'
        and coalesce(m.is_connector, false) = false
        and m.kind in ('human', 'agent')
        and (
          g.is_builtin = false
          or (m.kind = 'human' and g.slug in ($2, $3))
        )
   )
 order by i.id
 limit $4`;

/** Items no eligible principal can reach, bounded. `null` on failure — never an empty result, which
 *  would read the same as "there are none" for a metric whose only job is finding an invisible hole. */
export async function unreachableItems(
  db: DbClient,
  teamId: string,
  limit: number
): Promise<{ rows: { id: string; path: string }[]; error?: undefined } | { rows?: undefined; error: string }> {
  void db; // the pooled adapter; this read is raw SQL for the NOT EXISTS above
  try {
    const res = await runSql<{ id: string; path: string }>(UNREACHABLE_SQL, [
      teamId,
      EVERYONE_SLUG,
      EXTERNAL_SLUG,
      limit,
    ]);
    return { rows: res.rows };
  } catch (e) {
    // CARRY THE CAUSE. A bare `catch {}` here left an on-call operator with "coverage read failed"
    // and nothing else while diagnosing a production DB problem — the old paged version named which
    // read failed. Swallowing it also violates the repo-wide never-silently-swallow rule.
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function findUnpartitionedItems(db: DbClient, teamId: string): Promise<CoverageResult> {
  // ONE OWNER (AUDITFIX-15A): this reader delegates to `unreachableItems` rather than carrying its
  // own idea of reachability. The previous version paged `items` and re-derived coverage in three
  // queries per page, which is how it came to disagree with the oracle at all — and how a fixture
  // proving "the two definitions agree" would have blessed the same defect twice.
  //
  // `truncated` keeps its meaning: the query is bounded, and hitting the bound means the count is a
  // FLOOR. A caller deciding what a whole team can see has to know it has one.
  const found = await unreachableItems(db, teamId, MAX_UNREACHABLE + 1);
  if (found.error !== undefined) throw new Error(`coverage read failed: ${found.error}`);
  const truncated = found.rows.length > MAX_UNREACHABLE;
  const rows = truncated ? found.rows.slice(0, MAX_UNREACHABLE) : found.rows;

  // `scanned` is the corpus size the answer is ABOUT. It was the paging loop's counter; now it is
  // asked directly, because a reader reporting "I looked at N" must not silently mean "N so far".
  const { count: scanned, error } = await db.from("items").select("id", { count: "exact", head: true }).eq("team_id", teamId);
  if (error) throw new Error(`items count failed: ${error.message}`);

  return {
    scanned: scanned ?? 0,
    count: rows.length,
    examples: rows.slice(0, EXAMPLE_LIMIT).map((r) => r.path),
    truncated,
  };
}
