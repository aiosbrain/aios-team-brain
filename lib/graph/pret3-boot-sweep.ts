import "server-only";
import type { DbClient } from "@/lib/db/types";
import { runSql } from "@/lib/db/pg/pool";

/**
 * PRET-3's one-time post-activation sweep (Codex diff-review Highs 1-2 — the rollout races):
 * the slice's data migration runs at preDeploy while the OLD application still serves, so
 * (1) old code can write corrections-influenced `g:<slug>_external` cache rows AFTER a
 * migration-stamped wipe marker (blessing exactly the laundered rows the wipe targets), and
 * (2) a tier-keyed correction written in the deploy window is stranded until the next replay.
 * Running the wipe + a catch-up re-key HERE — marker-guarded, from the NEW code's first
 * scheduler tick — puts both strictly AFTER old writers are gone. Idempotent and multi-replica
 * safe: the marker insert is on-conflict-do-nothing, the delete and re-key are idempotent, and
 * a second replica racing the first merely repeats no-op statements.
 *
 * Best-effort with a LOUD failure (the caller records a failed ingest run): an unswept fleet
 * serves ≤ one TTL of pre-H1 external rows — bounded, but not silently acceptable.
 */
export async function runPret3BootSweep(db: DbClient): Promise<{ ran: boolean; error?: string }> {
  try {
    const marker = await runSql<{ name: string }>(
      "insert into migration_markers (name) values ('pret3_post_activation_sweep') on conflict (name) do nothing returning name",
      []
    );
    if (marker.rowCount === 0) return { ran: false }; // already swept (any replica, any boot)
    // 1. The pre-H1 external-row wipe: every external-shaped partition row written before THIS
    //    moment predates the corrections-free rule's activation on this fleet. Regenerable.
    await runSql("delete from arc_cache where group_key like 'g:%' and group_key like '%\\_external' escape '\\'", []);
    // 2. The catch-up re-key: tier-set corrections written by old code during the deploy window
    //    (same rules as the migration: newest eligible sibling, p:% and '' excluded, existing
    //    g: rows win). The migration's own replay converts earlier rows; this closes the gap
    //    between its preDeploy run and new-code activation.
    await runSql(
      `with eligible as (
         select distinct on (ac.team_id, ac.arc_id) ac.id, ac.team_id, ac.arc_id, p.graph_group_id
           from arc_corrections ac
           join projects p on p.team_id = ac.team_id and p.kind = 'system' and p.slug = 'general'
          where p.graph_group_id is not null
            and ac.group_key <> '' and ac.group_key not like 'g:%' and ac.group_key not like 'p:%'
          order by ac.team_id, ac.arc_id, ac.updated_at desc, ac.id desc)
       update arc_corrections ac set group_key = 'g:' || e.graph_group_id
         from eligible e
        where ac.id = e.id
          and not exists (select 1 from arc_corrections dup
                           where dup.team_id = e.team_id and dup.group_key = 'g:' || e.graph_group_id and dup.arc_id = e.arc_id)`,
      []
    );
    void db; // the adapter client is accepted for signature symmetry; the sweep is raw SQL by necessity (CTE + escape)
    return { ran: true };
  } catch (err) {
    return { ran: false, error: err instanceof Error ? err.message : String(err) };
  }
}
