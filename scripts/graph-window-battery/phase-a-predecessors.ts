/**
 * Phase A, part 2 — the SIZE of the predecessor block each call carries (PIPEFF-2 / AIO-821).
 *
 * Part 1 (`phase-a-structural.mjs`) answered two of Phase A's three questions at zero cost: how much
 * of the window is same-item (57.1% is not), and how often a tie-pool rival displaces an item's own
 * chunks (4.9%). This is the third, and the only one that needs a run: the parent spec's ~6,250
 * tokens per call is DERIVED (625 tokens × 10 predecessors), never observed.
 *
 * It reads the tap's JSONL — the real request bodies, byte-for-byte as graphiti sent them — and for
 * each one reports how much of the prompt is predecessor content rather than the episode being
 * extracted.
 *
 * WHY THIS IS TypeScript AND THE REST OF THE BATTERY IS .mjs: so it can import the brain's own
 * `classifyGraphCall`. That call-kind table is derived from the runtime call graph and has already
 * been wrong once in a way that labelled ~80% of production spend `unknown`; a second copy here
 * would drift from it silently. `npx tsx` is how this repo already runs its TS scripts.
 *
 * Usage:
 *   npx tsx --conditions react-server scripts/graph-window-battery/phase-a-predecessors.ts <capture.jsonl>
 */
import { readFileSync } from "node:fs";
import { classifyGraphCall, UNKNOWN_GRAPH_CALL } from "@/lib/llm/graph-call-kind";

/** Rough but consistent: the same chars/4 the cost harness uses, so the two agree by construction. */
const CHARS_PER_TOKEN = 4;
const tokens = (s: string) => Math.round(s.length / CHARS_PER_TOKEN);

type Row = { arm: string; at: string; path: string; body: { messages?: { role: string; content: string }[] } };

/**
 * The section tag graphiti wraps the previous episodes in.
 *
 * TWO SPELLINGS, because graphiti_core 0.29.3 is not internally consistent: `extract_nodes` and
 * `dedupe_nodes` emit `<PREVIOUS MESSAGES>` (space) while `extract_edges` emits `<PREVIOUS_MESSAGES>`
 * (underscore). Verified by generating the prompts inside the deployed image, not by reading docs.
 */
export const PREV_TAGS = ["PREVIOUS MESSAGES", "PREVIOUS_MESSAGES"] as const;

/**
 * Split a prompt into predecessor content and everything else.
 *
 * AN UNMATCHED PROMPT IS REPORTED, NEVER ASSUMED TO CARRY NOTHING. The first version of this looked
 * for a JSON key `"previous_episodes"`, which these prompts do not contain — and it dutifully
 * reported **0% predecessors** on prompts that were ~75% predecessors. Against a paid session that
 * would have "measured" the ten-episode window as free and killed the lever on its own bug, with a
 * plausible number and no error. Hence `parsed`, surfaced per call kind rather than folded into a
 * zero that looks like a measurement.
 */
export function splitPrompt(content: string): { predecessors: number; episode: number; total: number; parsed: boolean } {
  const total = tokens(content);
  for (const tag of PREV_TAGS) {
    const open = content.indexOf(`<${tag}>`);
    if (open === -1) continue;
    const close = content.indexOf(`</${tag}>`, open);
    if (close === -1) continue;
    const predecessors = tokens(content.slice(open, close + tag.length + 3));
    return { predecessors, episode: total - predecessors, total, parsed: true };
  }
  return { predecessors: 0, episode: total, total, parsed: false };
}

type Agg = { calls: number; total: number; predecessors: number; unparsed: number };

/** Aggregate a capture file by call kind. Pure; exported so the report and its test share one path. */
export function summarise(rows: Row[]): Map<string, Agg> {
  const byKind = new Map<string, Agg>();
  for (const r of rows) {
    const kind = classifyGraphCall(r.body);
    const content = (r.body.messages ?? []).map((m) => m.content ?? "").join("\n");
    const { predecessors, total, parsed } = splitPrompt(content);
    const a = byKind.get(kind) ?? { calls: 0, total: 0, predecessors: 0, unparsed: 0 };
    a.calls++;
    a.total += total;
    a.predecessors += predecessors;
    if (!parsed) a.unparsed++;
    byKind.set(kind, a);
  }
  return byKind;
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: phase-a-predecessors.ts <capture.jsonl>");
    process.exit(1);
  }

  const rows: Row[] = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  if (rows.length === 0) {
    // A silent zero here is indistinguishable from a clean measurement, so it refuses.
    console.error(`${file} holds no captured calls — the tap was not in the path, or the run never started`);
    process.exit(1);
  }

  const byKind = summarise(rows);
  console.log(`\nPHASE A part 2 — predecessor block size, arm ${rows[0].arm}, ${rows.length} captured calls\n`);
  console.log("call kind               calls   avg input   avg predecessors   predecessor share");

  let totalIn = 0;
  let totalPred = 0;
  for (const [kind, a] of [...byKind.entries()].sort((x, y) => y[1].total - x[1].total)) {
    const share = a.total > 0 ? (a.predecessors / a.total) * 100 : 0;
    totalIn += a.total;
    totalPred += a.predecessors;
    const warn = a.unparsed > 0 ? `  ⚠ ${a.unparsed} unparsed` : "";
    console.log(
      `${kind.padEnd(22)}${String(a.calls).padStart(6)}${String(Math.round(a.total / a.calls)).padStart(12)}` +
        `${String(Math.round(a.predecessors / a.calls)).padStart(19)}${(share.toFixed(1) + "%").padStart(20)}${warn}`
    );
  }

  console.log(`\n  total input tokens        ${totalIn.toLocaleString()}`);
  console.log(`  of which predecessors     ${totalPred.toLocaleString()}  (${((totalPred / totalIn) * 100).toFixed(1)}%)`);
  console.log(`\n  The parent spec DERIVED ~6,250 predecessor tokens per extract call. The figure above is`);
  console.log(`  observed, and it is what the SAME arm's saving is measured against.`);

  // A rising `unknown` share means the deployed prompts have moved away from lib/llm/graph-call-kind —
  // the designed failure mode of that table, and a reason to distrust every row above.
  const unknown = byKind.get(UNKNOWN_GRAPH_CALL);
  if (unknown) {
    console.log(`\n  ⚠ ${unknown.calls} call(s) classified '${UNKNOWN_GRAPH_CALL}' — the prompt table has drifted from what is deployed.`);
  }
}

// Only when invoked as a script, so the parser above is unit-testable without producing a report.
if (process.argv[1]?.includes("phase-a-predecessors")) main();
