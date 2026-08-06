/**
 * Harvest one rep's quality metrics (PIPEFF-2 / AIO-821).
 *
 * Reads the arm's Neo4j and its seeded Postgres, prints ONE JSON object with the Q-metrics plus the
 * inputs the decision procedure requires (`personsLost`, `dupeEdges`, `episodes`). It measures; it
 * never judges — `decision.mjs` owns the verdicts, and the runner feeds it these objects verbatim.
 *
 * Env: NEO4J_URL · NEO4J_USER · NEO4J_PASSWORD · DATABASE_URL (the arm's battery Postgres)
 *      GROUP_ID (default `aios_team` — the one group the corpus lands in by selection)
 * Usage: npx tsx --conditions react-server scripts/graph-window-battery/harvest.ts
 */
import { Client } from "pg";
import { entityYield, dupeShare, crossChunkContinuity, peopleMetrics, memberPresence, episodicCount } from "./measure";

import { countFromBody } from "./corpus.mjs";

async function main(): Promise<void> {
  const GROUP_ID = process.env.GROUP_ID ?? "aios_team";

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  // The corpus as seeded — every projectable team-tier item in this database IS the corpus, by
  // construction of the seeder, so no re-selection here (a second draw could disagree with the pins).
  const { rows: items } = await pg.query<{ id: string; body: string }>(
    "select id, body from items where access = 'team' order by id"
  );
  const { rows: members } = await pg.query<{ display_name: string }>("select display_name from members");
  await pg.end();

  const episodes = items.reduce((s, r) => s + countFromBody(r.body), 0);
  const multiChunkItemIds = new Set(items.filter((r) => countFromBody(r.body) > 1).map((r) => r.id));
  const presence = memberPresence(members, items);

  const [q1, q3, q4, people, landed] = await Promise.all([
    entityYield(GROUP_ID, episodes),
    dupeShare(GROUP_ID),
    crossChunkContinuity(GROUP_ID, multiChunkItemIds),
    peopleMetrics(GROUP_ID, presence),
    episodicCount(GROUP_ID),
  ]);

  // One JSON object on stdout — the runner parses this, so nothing else may print to stdout.
  console.log(
    JSON.stringify(
      {
        group: GROUP_ID,
        episodes,
        episodicNodesLanded: landed,
        Q1: q1,
        Q2: people.recall,
        Q3: q3.share,
        Q4: q4,
        Q6: people.convergence,
        personsLost: people.personsLost,
        dupeEdges: q3.total,
        namesPresent: presence.size,
        convergenceNames: people.convergenceNames,
        multiChunkItems: multiChunkItemIds.size,
      },
      null,
      2
    )
  );
  process.exit(0);
}
void main();
