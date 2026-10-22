/**
 * AUDITFIX-18 — a DIAGNOSTIC over the real tree. Not a control, and nothing asserts its output.
 *
 *   npx tsx test/guards/entry-surface-report.ts
 *
 * It prints the entry surfaces the graph discovers, each with its witness chain and its current
 * classification, plus every violation grouped by kind. The point is reviewability: the reviewed
 * `ENTRY_INVENTORY` is supposed to be written by READING what the graph found, and reading a
 * hundred keys out of a vitest diff is how a number gets pasted in instead.
 *
 * TEST-ONLY, like the modules it calls. It runs `analyseTreeWithSources` — the SAME
 * discovery-to-analysis seam the guard's real-tree criteria use — rather than a copy of the walk or
 * a hand-assembled call to the analyser, which is what this header used to have to warn about. That
 * matters beyond tidiness: the seam is what supplies the resolution-evidence host, so a diagnostic
 * that assembled its own call would print a DIFFERENT set of violations from the one the build
 * enforces. The guard remains the enforced artefact (its `AC9` pins the directory split against
 * `git ls-files`, its `AC18-05a` pins the extension list); this only prints.
 */

import { join } from "node:path";
import { analyseTreeWithSources } from "./entry-surface-discovery";
import { CANONICAL_WRITER_MODULE, COMPUTED_LOAD_EXCEPTIONS, ENTRY_INVENTORY } from "./entry-surface-graph";

const ROOT = join(import.meta.dirname, "..", "..");

const started = Date.now();
const { files, analysis: r } = analyseTreeWithSources(ROOT, ENTRY_INVENTORY, {
  exceptions: COMPUTED_LOAD_EXCEPTIONS,
});
const ms = Date.now() - started;

const lines: string[] = [];
lines.push(`# AUDITFIX-18 entry-surface report`);
// The timing now spans DISCOVERY AND ANALYSIS, because that is what the seam does in one call —
// and it is also the number worth reading, since the guard pays both.
lines.push(
  `walked ${files.length} sources · closure ${r.closure.length} · surfaces ${r.surfaces.length} · ${ms} ms (discover + analyse)`
);
lines.push("");
lines.push(`## surfaces (${r.surfaces.length}) — key · class · witness`);
for (const s of r.surfaces) {
  const rec = ENTRY_INVENTORY[s];
  lines.push(`${s}\t${rec ? rec.class : "«UNCLASSIFIED»"}\t${(r.witness[s] ?? []).join(" -> ")}`);
}
lines.push("");
lines.push(`## closure-only modules (${r.closure.length - r.surfaces.length - 1}) — traversed, no record needed`);
const surfaceSet = new Set(r.surfaces);
for (const c of r.closure) if (!surfaceSet.has(c) && c !== CANONICAL_WRITER_MODULE) lines.push(c);
lines.push("");
const byKind = new Map<string, string[]>();
for (const v of r.violations) byKind.set(v.kind, [...(byKind.get(v.kind) ?? []), v.message]);
lines.push(`## violations (${r.violations.length})`);
for (const [kind, msgs] of [...byKind].sort()) {
  lines.push(`### ${kind} (${msgs.length})`);
  for (const m of msgs) lines.push(`- ${m}`);
}
lines.push("");
lines.push(`## excludedRefs (${r.excludedRefs.length})`);
for (const e of r.excludedRefs) lines.push(`${e.at}\t${e.specifier}\t-> ${e.target}`);

process.stdout.write(`${lines.join("\n")}\n`);
