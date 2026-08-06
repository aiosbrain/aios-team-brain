/**
 * Assemble one battery session's raw outputs and judge them (PIPEFF-2 / AIO-821).
 *
 * Inputs per arm-rep, produced by the runbook's harvest step:
 *   quality-<arm>-rep<N>.json   — harvest.ts output (Q-metrics + personsLost/dupeEdges/landed)
 *   cost-<arm>-rep<N>.txt       — scripts/graph-ingest-cost.mjs output, verbatim
 *
 * THE COST NUMBERS ARE PARSED FROM THE HARNESS'S OWN OUTPUT, AND THE PARSERS REFUSE. The harness is
 * the pre-registered instrument, so C1 and Q5 must come from what it printed — not from a second SQL
 * path that could quietly disagree with it. Text parsing is fragile by nature, so every extractor
 * throws when its line is missing rather than defaulting: a format drift in the harness becomes a
 * loud judge failure, never a zero that reads as a measurement. (That exact failure — a parser whose
 * pattern misses reporting 0% — already happened once in this battery and was caught only by a dry
 * run.)
 *
 * ── REP AGGREGATION FOR THE NON-BAND INPUTS — pre-registered here, before any readout existed ────
 *
 * The spec pins mean-of-two-reps for band metrics and W10's |rep1−rep2| as the noise unit, but is
 * silent on how two reps combine for the noise-free count clause and the session gates. Decided now,
 * in a commit, with the burden of proof on the change:
 *
 *   personsLost   → MAX of the two reps. The clause is a noise-free floor; losing a known person in
 *                   either rep is a loss, and averaging would let one clean rep launder the other.
 *   dupeEdges     → MIN of the two reps: BOTH must clear the 200-edge minimum the health module
 *                   refuses to judge under.
 *   dupeShare     → MEAN of W10's reps, matching the band-metric aggregation for the same quantity.
 *   armsCompleted → every rep of every arm must have landed exactly its expected episode count.
 *
 * Usage:  node scripts/graph-window-battery/judge.mjs <resultsDir>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assessSession, decide, MIN_UNIVERSE } from "./decision.mjs";
import { buildUniverse, nameConvergence } from "./q7.mjs";

const num = (s) => Number(String(s).replace(/,/g, ""));

/** Every extractor refuses rather than defaulting — see the header. */
export function parseCostText(text, label) {
  if (text.includes("REFUSING TO REPORT A RATIO")) {
    return { refused: true, crossCheckAvailable: !text.includes("cross-check unavailable") && !text.includes("cross-check UNAVAILABLE") };
  }
  const attempts = text.match(/episodes\s+([\d,]+)\s+\(extract_nodes calls/);
  if (!attempts) throw new Error(`${label}: no extract_nodes attempts line — harness format drifted?`);

  let crossCheckAvailable = true;
  let signed = null;
  let pushed = null;
  // Greedy middle: the line has two `·` separators and the sign is the LAST segment.
  const cc = text.match(/cross-check\s+([\d,]+)\s+pushed per ingest_runs.*·\s+(.+)$/m);
  if (cc) {
    pushed = num(cc[1]);
    const tail = cc[2];
    if (tail.startsWith("exact")) signed = 0;
    else {
      const m = tail.match(/^([+-][\d,]+)/);
      if (!m) throw new Error(`${label}: cross-check sign unparseable: "${tail}"`);
      signed = num(m[1]);
    }
  } else if (/cross-check\s+(unavailable|UNAVAILABLE)/.test(text)) {
    crossCheckAvailable = false;
  } else {
    throw new Error(`${label}: no cross-check line at all — harness format drifted?`);
  }

  const perEp = text.match(/input tok\s+[\d,]+\s+per episode\s+([\d,]+)/);
  if (!perEp) throw new Error(`${label}: no input-tokens-per-episode line — harness format drifted?`);

  return {
    refused: false,
    crossCheckAvailable,
    attempts: num(attempts[1]),
    episodesPushed: pushed,
    signedGap: signed,
    inputTokensPerEpisode: num(perEp[1]),
  };
}

function loadRep(dir, arm, rep) {
  const q = JSON.parse(readFileSync(join(dir, `quality-${arm}-rep${rep}.json`), "utf8"));
  const c = parseCostText(readFileSync(join(dir, `cost-${arm}-rep${rep}.txt`), "utf8"), `${arm} rep${rep}`);
  if (c.refused) return { q, c, refused: true };
  // Q5 in the decision's units: the signed gap as a FRACTION of episodes pushed.
  const q5 = c.episodesPushed > 0 ? c.signedGap / c.episodesPushed : NaN;
  return { q, c, refused: false, q5 };
}

/**
 * `items` = the corpus rows ({id, body}) from ANY arm's seeded Postgres — corpora are hash-identical
 * across arms, and Q7's universe needs the bodies to check literal recurrence.
 */
export function assemble(dir, items, arms = ["w10", "same", "w1"]) {
  const reps = {};
  for (const arm of arms) reps[arm] = [loadRep(dir, arm, 1), loadRep(dir, arm, 2)];

  // Q7 (Amendment 2): the universe comes from the UNION of the incumbent's reps, then every rep of
  // every arm is scored against that one fixed universe.
  const universe = buildUniverse([reps.w10[0].q.nameCounts, reps.w10[1].q.nameCounts], items);

  const metricReps = (arm) => ({
    Q1: reps[arm].map((r) => r.q.Q1),
    Q2: reps[arm].map((r) => r.q.Q2),
    Q4: reps[arm].map((r) => r.q.Q4),
    Q5: reps[arm].map((r) => r.q5),
    Q7: reps[arm].map((r) => nameConvergence(r.q.nameCounts, universe)),
    C1: reps[arm].map((r) => r.c.inputTokensPerEpisode),
  });

  const incumbent = metricReps("w10");
  const allReps = arms.flatMap((a) => reps[a]);

  const session = assessSession({
    incumbent,
    universeSize: universe.length,
    underpowered: [],
    armsCompleted: allReps.every((r) => !r.refused && r.q.episodicNodesLanded === r.q.episodes),
    harnessRefused: allReps.some((r) => r.refused),
    crossCheckAvailable: allReps.every((r) => r.c.crossCheckAvailable),
  });

  const verdict = decide({
    session,
    incumbent,
    arms: ["same", "w1"].map((arm) => ({
      name: arm.toUpperCase(),
      metrics: metricReps(arm),
      // Q2 v2's count clause over QUALIFYING names (present in ≥2 items), max of reps: the
      // noise-free floor takes the worse rep — see the header.
      extras: { personsLost: Math.max(reps[arm][0].q.qualifyingLost, reps[arm][1].q.qualifyingLost) },
    })),
  });

  // The per-name breakdown the spec requires: the aggregate can stay flat while the arm fragments
  // one name and the incumbent fragments another — auditable, not invisible.
  const perName = universe.map((name) => {
    const count = (arm, i) => reps[arm][i].q.nameCounts.find((r) => r.name === name)?.nodes ?? 0;
    return { name, w10: [count("w10", 0), count("w10", 1)], same: [count("same", 0), count("same", 1)], w1: [count("w1", 0), count("w1", 1)] };
  });

  return { session, verdict, incumbent, universe, perName, reps };
}

// CLI half, guarded so the parsers above are unit-testable without a results directory.
if (process.argv[1]?.includes("judge.mjs")) {
  const dir = process.argv[2];
  if (!dir || !process.env.DATABASE_URL) {
    console.error("usage: DATABASE_URL=<any arm's battery PG> node judge.mjs <resultsDir>");
    process.exit(1);
  }
  const { Client } = await import("pg");
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const { rows: items } = await pg.query("select id, body from items where access = 'team'");
  await pg.end();

  const { session, verdict, incumbent, universe, perName } = assemble(dir, items);
  console.log(JSON.stringify({ session, verdict, incumbent, universeSize: universe.length, perName }, null, 2));
  process.exitCode = verdict.outcome === "INVALID" ? 2 : 0;
}
