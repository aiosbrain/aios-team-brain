/**
 * Count episodes per item using the projector's REAL chunker — PIPEFF-5 / AIO-868.
 *
 * WHY THIS EXISTS. `corpus.mjs`'s `countFromBody` estimates `ceil(chars / CHUNK_CHARS)`, which was
 * exact under the legacy byte-offset chunker. PIPEFF-3 moved the projector to content-defined
 * chunking (`cdc1`), whose count is not a function of `length(body)` and cannot be derived in SQL at
 * all. The estimate's own ⚠️ note said it now "UNDER-counts by ~5%".
 *
 * Measured on the 2026-08-16 draw: the estimate said **117**, the projector produced **164**. That is
 * a **40%** under-count, not 5% — so the `EPISODE_BUDGET` gate (90–120) was passing on a number that
 * has no relationship to what runs, and a battery priced against it would have overrun its envelope
 * while its own gate said "within range".
 *
 * The escape hatch `verifyCorpus(selection, bodyById, countFn)` was always there; nothing was using
 * it with the real function, because `seed-local.mjs` is plain node and `chunkContent` lives in a
 * `server-only` module. This script is that bridge: run under `tsx --conditions react-server` (the
 * same way `measure.ts` and `phase-a-predecessors.ts` already run), it imports the projector's own
 * `chunkContent` and prints the counts. **One implementation of the algorithm, no second copy to
 * drift** — which is the trap this suite already guards against once.
 *
 * Usage:  echo '{"<id>":"<body>",…}' | npx tsx --conditions react-server \
 *           scripts/graph-window-battery/count-chunks.ts
 * Out:    {"<id>": <episodes>, …}   on stdout, nothing else.
 */
import { chunkContent } from "@/lib/graph/project";

async function main(): Promise<void> {
  const raw = await new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });

  let bodies: Record<string, string>;
  try {
    bodies = JSON.parse(raw);
  } catch (err) {
    console.error(`count-chunks: stdin is not JSON — ${(err as Error).message}`);
    process.exit(1);
  }

  const out: Record<string, number> = {};
  for (const [id, body] of Object.entries(bodies)) {
    // Exactly what the projector does. `toEpisodes` chunks `item.body ?? ""` with this function, so
    // the count here is the count that will be pushed — that is the whole point of this file.
    out[id] = chunkContent(body ?? "").length;
  }
  process.stdout.write(JSON.stringify(out));
}

void main();
