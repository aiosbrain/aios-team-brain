/**
 * What one graph episode actually costs to ingest — the baseline every efficiency lever is measured
 * against (PIPEFF-1 / AIO-820).
 *
 * WHY THIS EXISTS. Graph extraction bills ~38,000 input tokens to ingest an episode carrying at most
 * 2,500 characters (~625 tokens) of content — roughly 60x the source text. Three levers are proposed
 * against that (content-defined chunking, cutting the 10-episode repeated context, packing small
 * items), and each one's claim is a percentage. Percentages multiplied together are how a cost
 * estimate becomes a story, so no lever ships without a before/after on this script, run over a
 * comparable window.
 *
 * WHY IT READS `llm_usage` ALONE. The obvious denominator — episodes pushed, from
 * `graph_episodes ⋈ items` — produces a WRONG ratio, and did: the first baseline divided a 2-hour
 * billing window by a 1-hour projection window and got 10.1 tokens/char, when the honest figure is
 * ~61x. Extraction is ASYNCHRONOUS. Graphiti accepts an episode (202) and extracts it later, so a
 * billing window and a projection window cover different episodes. Two further traps in that join:
 * `chunk_shas` is LAST-STATE (a delta pass sends a subset the ledger never records), and
 * `projected_at` is overwritten by later pushes, so re-querying a historical window loses rows.
 *
 * So the denominator is `call_kind = 'extract_nodes'`. Numerator and denominator then come from the
 * same table, the same rows, the same window — the ratio cannot straddle a boundary even if the
 * window does.
 *
 * WHAT THE DENOMINATOR ACTUALLY COUNTS — attempts, not episodes. graphiti_core 0.29.3 fires
 * `extract_nodes` once per extraction ATTEMPT. There is no reflexion loop (0.13.2 had one) and no
 * per-episode fan-out, and it fires unconditionally even for content-free episodes — so the happy
 * path is one call per episode. But two retry layers can add attempts for the SAME episode:
 *   · `openai_base_client.py` — MAX_RETRIES=2 on pydantic validation failure. The invalid response
 *     arrived WITH a usage block, so the proxy metered it and the retry is a second row (with a
 *     longer prompt, since the error context is appended).
 *   · `client.py` — tenacity on RateLimitError / EmptyResponse / JSONDecodeError. Rate-limited
 *     attempts carry no usage and are never metered, so those don't distort; the other two do.
 * Retries push `extract_nodes` ABOVE episodes pushed, so the cross-check's SIGNED gap is the
 * retry-rate instrument: positive = retries, negative = the window caught a push it didn't bill.
 * A lever that changes prompt shape can change the validation-retry rate, so a before/after must
 * compare the signed gap as well as the ratio — otherwise a "token cut" may be a retry-rate shift.
 *
 * AND `llm_usage` IS LOSSY. `recordLlmUsage` is best-effort by contract, so a dropped row deflates
 * whichever side it belonged to. Negligible against a healthy database; not zero.
 *
 * TWO REFUSALS, so the instrument cannot lie quietly. A measurement tool that reports a plausible
 * wrong number is worse than one that reports nothing, because the wrong number is what gets quoted:
 *   1. DRAIN — if graph traffic is still flowing at either edge of the window, the window is
 *      straddling a burst and the ratio mixes populations. Refuse.
 *   2. CROSS-CHECK — compare the extract_nodes count against episodes pushed (`ingest_runs.meta.
 *      episodes`) over the same window. They should be close; a material divergence means the window
 *      caught one and not the other. Report the divergence instead of a ratio.
 *
 * Usage:
 *   DATABASE_URL=postgres://…  node scripts/graph-ingest-cost.mjs <sinceISO> <untilISO> [--drain=10]
 *   DATABASE_URL=…             node scripts/graph-ingest-cost.mjs --last=24h
 *
 * Pure node + `pg` (no tsx), so it runs anywhere the app does, including against prod read-only.
 */
import { Client } from "pg";

/** Minutes of quiet required at each edge before a window is trustworthy. Graphiti's queue drains at
 *  LLM speed (~1-30s per call), so a gap this size means the burst genuinely ended. */
const DEFAULT_DRAIN_MINUTES = 10;
/** Episode payload ceiling, mirroring lib/graph/project.ts CHUNK_CHARS. Content tokens ≈ chars / 4.
 *  NOTE: the projector reads `GRAPH_CHUNK_CHARS` from env, so a deployment that overrides it makes
 *  MULTIPLE wrong here — hence the assumed size is printed in the output rather than left implicit.
 *  Lazy CDC (`cdc1-2500`) will also mix configs across the corpus; at that point this becomes a
 *  weighted average and the footer stops being a sufficient caveat. */
const CHUNK_CHARS = Number(process.env.GRAPH_CHUNK_CHARS) > 0 ? Number(process.env.GRAPH_CHUNK_CHARS) : 2500;
const CHARS_PER_TOKEN = 4;
/** Above this relative gap the two episode counts describe different populations. */
const CROSS_CHECK_TOLERANCE = 0.15;

function parseArgs(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const drainRaw = flag("drain");
  const drainMinutes = drainRaw === undefined ? DEFAULT_DRAIN_MINUTES : Number(drainRaw);
  const last = flag("last");
  const positional = args.filter((a) => !a.startsWith("--"));
  // A NaN here would reach Postgres as the literal interval 'NaN minutes' and throw a syntax error
  // from deep inside a query, which reads as a tool bug rather than a bad flag.
  const drainValid = Number.isFinite(drainMinutes) && drainMinutes > 0;
  return { since: positional[0], until: positional[1], last, drainMinutes, drainValid };
}

/** `--last=24h|90m|7d` → an ISO window ending now. Convenience only; explicit bounds are preferred
 *  because a lever's before/after must compare the SAME window shape, not "whatever the last day was". */
export function resolveLastWindow(last, nowMs) {
  const m = /^(\d+)([mhd])$/.exec((last ?? "").trim());
  if (!m) return null;
  const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return { since: new Date(nowMs - Number(m[1]) * mult).toISOString(), until: new Date(nowMs).toISOString() };
}

/**
 * Is the window safe to report on? Pure, so both refusals are testable without a database.
 *
 * `leadingCalls` — graph calls in the drain window immediately BEFORE `since`. Non-zero means an
 * earlier burst was still extracting when our window opened, so its tokens land inside our numerator
 * while its episodes do not.
 * `trailingCalls` — graph calls in the drain window immediately before `until`. Non-zero means our
 * own burst had not finished when the window closed, so episodes we counted are still being billed.
 */
export function assessWindow({ leadingCalls, trailingCalls, forwardCalls, forwardUnknown, extractNodes, episodesPushed }) {
  const problems = [];
  if (leadingCalls > 0) {
    problems.push(
      `traffic at the LEADING edge (${leadingCalls} calls in the drain window before \`since\`) — an ` +
        `earlier burst was still extracting, so its tokens are in this window but its episodes are not`
    );
  }
  if (trailingCalls > 0) {
    problems.push(
      `traffic at the TRAILING edge (${trailingCalls} calls in the drain window before \`until\`) — ` +
        `this burst had not drained, so some episodes counted here are still being billed`
    );
  }
  // FORWARD drain. Both edge checks above look BACKWARD, which misses the case this deployment has
  // actually had: a graphiti worker stalls mid-queue, goes quiet for longer than the drain, then
  // resumes after `until`. Its episodes are counted here; its tokens are not. Silent, and it makes
  // the pipeline look cheaper than it is — the flattering direction, which is the dangerous one.
  if (forwardCalls > 0) {
    problems.push(
      `traffic AFTER the window (${forwardCalls} calls in the drain window following \`until\`) — ` +
        `extraction spilled past the close, so episodes counted here are billed outside it`
    );
  }
  if (forwardUnknown) {
    problems.push(
      "`until` is inside the drain window of now — the forward check cannot run yet, so a spill " +
        "past the close would be invisible. Re-run once the window has aged past the drain."
    );
  }
  if (extractNodes === 0) {
    problems.push("no `extract_nodes` calls in the window — nothing was extracted, so there is no ratio");
  }
  // The cross-check only means something when we have both numbers; a window with no projector runs
  // recorded (they are written at run END) simply cannot be cross-checked, which is not a failure.
  let crossCheck = null;
  if (extractNodes > 0 && episodesPushed !== null) {
    const gap = Math.abs(extractNodes - episodesPushed) / Math.max(extractNodes, episodesPushed);
    // SIGNED: positive means more extraction attempts than episodes pushed (retries); negative means
    // the window saw a push whose extraction it did not bill. Different diagnoses, so keep the sign.
    crossCheck = { extractNodes, episodesPushed, gap, signed: extractNodes - episodesPushed };
    if (gap > CROSS_CHECK_TOLERANCE) {
      problems.push(
        `episode counts disagree: ${extractNodes} extract_nodes calls vs ${episodesPushed} episodes ` +
          `pushed (${(gap * 100).toFixed(0)}% apart) — the window caught one and not the other`
      );
    }
  }
  return { trustworthy: problems.length === 0, problems, crossCheck };
}

/** The headline numbers. Pure, so the arithmetic is pinned without a database. */
export function summarise({ rows, extractNodes }) {
  const totals = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + Number(r.calls),
      inputTokens: acc.inputTokens + Number(r.input_tokens),
      outputTokens: acc.outputTokens + Number(r.output_tokens),
      costUsd: acc.costUsd + Number(r.cost_usd),
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  );
  const per = (n) => (extractNodes > 0 ? n / extractNodes : null);
  const contentTokens = CHUNK_CHARS / CHARS_PER_TOKEN;
  const inputPerEpisode = per(totals.inputTokens);
  return {
    ...totals,
    episodes: extractNodes,
    callsPerEpisode: per(totals.calls),
    inputTokensPerEpisode: inputPerEpisode,
    usdPerEpisode: per(totals.costUsd),
    // The number the levers move: billed input tokens per token of content in a FULL episode. A
    // ceiling, not an average — a half-full episode reads worse, and honestly so.
    multipleOfContent: inputPerEpisode === null ? null : inputPerEpisode / contentTokens,
  };
}

const fmt = (n, d = 0) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));

async function main() {
  const { since, until, last, drainMinutes, drainValid } = parseArgs(process.argv);
  if (!drainValid) {
    console.error("--drain must be a positive number of minutes");
    process.exit(2);
  }
  const window = last ? resolveLastWindow(last, Date.now()) : { since, until };
  if (!window?.since || !window?.until) {
    console.error("usage: graph-ingest-cost.mjs <sinceISO> <untilISO> [--drain=10]   |   --last=24h");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (read-only queries only).");
    process.exit(2);
  }

  const client = new Client({ connectionString: url, ssl: /\bsslmode=require\b/.test(url) ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    const drain = `${drainMinutes} minutes`;
    // SEQUENTIAL, not Promise.all: a single `pg` Client multiplexes one connection, so concurrent
    // .query() calls are deprecated (and will throw in pg@9). Three cheap aggregates; latency is
    // irrelevant next to correctness here.
    const byKind = await client.query(
        `select coalesce(nullif(call_kind, ''), '(unlabelled)') as call_kind,
                count(*)::int as calls,
                sum(input_tokens)::bigint as input_tokens,
                sum(output_tokens)::bigint as output_tokens,
                sum(cost_usd)::numeric as cost_usd
           from llm_usage
          where source = 'graph' and created_at >= $1 and created_at < $2
          group by 1 order by 5 desc nulls last`,
      [window.since, window.until]
    );
    const edges = await client.query(
        `select
           (select count(*) from llm_usage
             where source='graph' and created_at >= $1::timestamptz - $3::interval and created_at < $1)::int as leading_calls,
           (select count(*) from llm_usage
             where source='graph' and created_at >= $2::timestamptz - $3::interval and created_at < $2)::int as trailing_calls,
           (select count(*) from llm_usage
             where source='graph' and created_at >= $2::timestamptz and created_at < $2::timestamptz + $3::interval)::int as forward_calls,
           (now() < $2::timestamptz + $3::interval) as forward_unknown`,
        [window.since, window.until, drain]
    );
    let runsError = null;
    const runs = await client
        .query(
          // ANCHORED ON `finished_at`, not `started_at` — found by running this against prod. A
          // projector run takes ~9 minutes and pushes its episodes as it goes, so a run that STARTED
          // before the window can push episodes that extract entirely inside it. Anchoring on
          // `started_at` made the cross-check report "0 episodes pushed" for a window containing 169
          // extractions, refusing a window that was in fact clean. The push completes by
          // `finished_at`, and extraction follows the push, so that is the edge that belongs to the
          // same causal event as the tokens.
          `select coalesce(sum((meta->>'episodes')::int), 0)::int as episodes, count(*)::int as runs
             from ingest_runs
            where source = 'graph_project' and finished_at >= $1 and finished_at < $2`,
          [window.since, window.until]
        )
        // A real SQL error here (renamed table/column) would otherwise masquerade as "no runs to
        // compare against" and silently disarm one of the two refusals — permanently, and quietly,
        // which is the one thing this tool exists not to do. Capture it and SAY so.
        .catch((err) => {
          runsError = err instanceof Error ? err.message : String(err);
          return null;
        });

    const rows = byKind.rows;
    const extractNodes = Number(rows.find((r) => r.call_kind === "extract_nodes")?.calls ?? 0);
    // A window with no recorded runs cannot be cross-checked (runs are written at END), which is
    // different from a window whose runs pushed zero episodes.
    const episodesPushed = runs && Number(runs.rows[0].runs) > 0 ? Number(runs.rows[0].episodes) : null;

    const verdict = assessWindow({
      leadingCalls: Number(edges.rows[0].leading_calls),
      trailingCalls: Number(edges.rows[0].trailing_calls),
      forwardCalls: Number(edges.rows[0].forward_calls),
      forwardUnknown: edges.rows[0].forward_unknown === true,
      extractNodes,
      episodesPushed,
    });
    const s = summarise({ rows, extractNodes });

    console.log(`\nwindow      ${window.since} → ${window.until}   (drain ${drainMinutes}m)`);
    console.log(`episodes    ${fmt(s.episodes)}   (extract_nodes calls — one per episode)`);
    if (verdict.crossCheck) {
      const sign = verdict.crossCheck.signed > 0 ? `+${verdict.crossCheck.signed} attempts over pushes (retries)` : verdict.crossCheck.signed < 0 ? `${verdict.crossCheck.signed} — pushes this window did not bill` : "exact";
      console.log(`cross-check ${fmt(verdict.crossCheck.episodesPushed)} pushed per ingest_runs · ${(verdict.crossCheck.gap * 100).toFixed(0)}% apart · ${sign}`);
    } else if (runsError) {
      console.log(`cross-check UNAVAILABLE — the ingest_runs query FAILED: ${runsError}`);
      console.log("            (one of the two refusals is disarmed; treat any ratio below with suspicion)");
    } else {
      console.log("cross-check unavailable — no projector runs finished inside this window");
    }

    if (!verdict.trustworthy) {
      console.log("\nREFUSING TO REPORT A RATIO:");
      for (const p of verdict.problems) console.log(`  · ${p}`);
      console.log("\nPick a window that opens and closes in quiet, or widen --drain.\n");
      process.exitCode = 1;
      return;
    }

    console.log(`\ncalls        ${fmt(s.calls)}        ${fmt(s.callsPerEpisode, 1)} per episode`);
    console.log(`input tok    ${fmt(s.inputTokens)}   ${fmt(s.inputTokensPerEpisode)} per episode`);
    console.log(`output tok   ${fmt(s.outputTokens)}`);
    console.log(`cost         $${fmt(s.costUsd, 2)}       $${fmt(s.usdPerEpisode, 4)} per episode`);
    console.log(`\nMULTIPLE     ${fmt(s.multipleOfContent, 1)}x the content a full episode carries`);
    console.log(`             (${CHUNK_CHARS} chars ≈ ${CHUNK_CHARS / CHARS_PER_TOKEN} tokens vs ${fmt(s.inputTokensPerEpisode)} billed)\n`);

    console.log("by call kind:");
    for (const r of rows) {
      const calls = Number(r.calls);
      console.log(
        `  ${r.call_kind.padEnd(22)} ${String(calls).padStart(6)} calls  ` +
          `${String(Math.round(Number(r.input_tokens) / calls)).padStart(7)} avg in  ` +
          `$${Number(r.cost_usd).toFixed(3).padStart(7)}  ` +
          `${(s.costUsd > 0 ? ((Number(r.cost_usd) / s.costUsd) * 100).toFixed(0) : "—").padStart(3)}%`
      );
    }
    console.log("");
  } finally {
    await client.end();
  }
}

// Only run when invoked directly, so the pure helpers above are importable by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
