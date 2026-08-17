#!/usr/bin/env node
/**
 * PRET-2 (spec docs/design/pret2-convergence-gated-flip.md §1.5) — the flip-day cost estimate,
 * run BEFORE any flip is enabled. Read-only; per still-permissive team it prices the first
 * arm-on-read wave: initiative partitions × the episodes their member items would fan out,
 * at the measured quiet-window per-episode rate.
 *
 * Chunk counts come from the TIER-GROUP ledger rows (`graph_episodes` under the built-in
 * pointer groups — the content that WOULD fan out); a permissive team's initiative partitions
 * hold no rows yet by design (PCCC-6a arm:false), so reading those would price zero.
 *
 * Preflight: DATABASE_URL must be readable (locally: the Railway public proxy, read-only —
 * CLAUDE.md §6). If unavailable, record "estimate: NOT RUN — no prod access" in the PR body.
 */
import pg from "pg";

const RATE_PER_EPISODE_USD = 0.0057; // measured quiet-window rate (docs/design/phase-c-per-project-graphs.md cost gate)

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("estimate: NOT RUN — DATABASE_URL is not set (no prod access). Record this line in the PR.");
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows: teams } = await client.query(
    `select t.id, t.slug from teams t where t.access_enforcement = 'permissive' order by t.slug`
  );
  if (teams.length === 0) {
    console.log("estimate: every team is already enforcing — flip-day cost is zero.");
    process.exit(0);
  }
  let grandEpisodes = 0;
  for (const t of teams) {
    // Initiative partitions: pointer-carrying, non-built-in projects.
    const { rows: initiatives } = await client.query(
      `select count(*)::int as n from projects p
        where p.team_id = $1 and p.graph_group_id is not null and p.kind <> 'system'`,
      [t.id]
    );
    // Episodes that would fan out: chunk counts of the team's ledger rows under the built-in
    // pointer groups, restricted to items holding a CURRENT initiative membership.
    const { rows: episodes } = await client.query(
      `select coalesce(sum(greatest(cardinality(ge.chunk_shas), 1)), 0)::int as n
         from graph_episodes ge
         join projects bp on bp.team_id = ge.team_id and bp.graph_group_id = ge.group_id and bp.kind = 'system'
         join project_context_units u on u.team_id = ge.team_id and u.source_item_id = ge.source_id and u.state = 'active'
         join project_context_memberships m on m.team_id = ge.team_id and m.context_unit_id = u.id and m.valid_to is null and m.decision = 'include'
         join projects ip on ip.id = m.project_id and ip.kind <> 'system'
        where ge.team_id = $1 and ge.source_table = 'items'`,
      [t.id]
    );
    const n = episodes[0]?.n ?? 0;
    grandEpisodes += n;
    console.log(
      `${t.slug}: ${initiatives[0]?.n ?? 0} initiative partition(s), ~${n} episode(s) would fan out → ~$${(n * RATE_PER_EPISODE_USD).toFixed(2)}`
    );
  }
  console.log(
    `TOTAL: ~${grandEpisodes} episodes → ~$${(grandEpisodes * RATE_PER_EPISODE_USD).toFixed(2)} at $${RATE_PER_EPISODE_USD}/episode ` +
      `(worst case; runtime stays budget-bounded by PPARC_SYNTH_BUDGET_PER_READ + GRAPH_FANOUT_PUSH_MAX_PER_PASS)`
  );
} finally {
  await client.end();
}
