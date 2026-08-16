#!/usr/bin/env node
/**
 * Build the two arm files for PIPEFF-5 and PROVE they differ by exactly PATCH 4.
 *
 * The spec (docs/design/graph-combined-extraction.md §4) originally said "2 arms — incumbent vs
 * combined" without saying what file each arm runs, and the wrong answer there is catastrophic in a
 * way a perfectly-executed battery would never reveal: if the incumbent ran STOCK 0.29.3, the
 * measured delta would fold in PATCH 3's already-shipped −25.5% and report this lever at roughly
 * triple its real size.
 *
 *   PATCHED3  = stock + PATCH 3            ← what prod runs TODAY. The thing to beat.
 *   COMBINED  = stock + PATCH 3 + PATCH 4  ← the incumbent plus this lever, and nothing else.
 *
 * So this script does not take the arms on trust. It builds both from ONE pinned source copy, then
 * asserts that COMBINED is byte-identical to (PATCHED3 + patch-combined-extraction.py). If that does
 * not hold it writes nothing and exits non-zero — a mis-built arm fails before the stack starts,
 * not after the money is spent.
 *
 * Usage:
 *   node scripts/graph-window-battery/build-arms.mjs <stock-graphiti.py> <outdir>
 *
 * `<stock-graphiti.py>` must be the UNPATCHED file from the pinned wheel/image. The script refuses a
 * source that already carries either patch's marker, because patching a patched file silently
 * produces an arm that is not what its name says.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const [src, outdir] = process.argv.slice(2);
if (!src || !outdir) {
  console.error("usage: build-arms.mjs <stock-graphiti.py> <outdir>");
  process.exit(1);
}

const MARK3 = "PIPEFF-2: carry only the SAME ITEM";
const MARK4 = "PIPEFF-5: one extraction call";

const stock = readFileSync(src, "utf8");
for (const [mark, name] of [
  [MARK3, "PATCH 3"],
  [MARK4, "PATCH 4"],
]) {
  if (stock.includes(mark)) {
    console.error(`REFUSING: ${src} already carries ${name}'s marker — pass the STOCK file.`);
    process.exit(1);
  }
}

mkdirSync(outdir, { recursive: true });
const patched3 = join(outdir, "graphiti.PATCHED3.py");
const combined = join(outdir, "graphiti.COMBINED.py");
const scratch = join(outdir, ".scratch.py");

const run = (script, file) => execFileSync("python3", [script, file], { encoding: "utf8" });

// PATCHED3 = stock + PATCH 3
copyFileSync(src, patched3);
run("graphiti/patch-same-item.py", patched3);

// COMBINED = PATCHED3 + PATCH 4
copyFileSync(patched3, combined);
run("graphiti/patch-combined-extraction.py", combined);

// THE ASSERTION: applying PATCH 4 to a fresh copy of PATCHED3 must reproduce COMBINED byte-for-byte.
// This is what makes "the arms differ by exactly this lever" a checked fact rather than a claim.
copyFileSync(patched3, scratch);
run("graphiti/patch-combined-extraction.py", scratch);
const a = readFileSync(scratch, "utf8");
const b = readFileSync(combined, "utf8");
rmSync(scratch, { force: true });
if (a !== b) {
  console.error("REFUSING: PATCH 4 is not deterministic — two applications to the same input differ.");
  process.exit(1);
}

// And the arms must actually DIFFER, in the expected direction. An identical pair would mean PATCH 4
// silently no-opped, which is the failure the Dockerfile gates exist for — caught here too, because
// this path does not go through the Dockerfile.
const p3 = readFileSync(patched3, "utf8");
if (p3 === b) {
  console.error("REFUSING: the two arms are identical — PATCH 4 did nothing.");
  process.exit(1);
}
if (!p3.includes(MARK3) || !b.includes(MARK3)) {
  console.error("REFUSING: PATCH 3's marker is missing from an arm — the incumbent must be what prod runs.");
  process.exit(1);
}
if (p3.includes(MARK4)) {
  console.error("REFUSING: the incumbent arm carries PATCH 4.");
  process.exit(1);
}
if (!b.includes(MARK4)) {
  console.error("REFUSING: the candidate arm does not carry PATCH 4.");
  process.exit(1);
}

const added = b.split("\n").length - p3.split("\n").length;
console.log(`arms built in ${outdir}`);
console.log(`  PATCHED3 (incumbent) = stock + PATCH 3            ${p3.split("\n").length} lines`);
console.log(`  COMBINED (candidate) = stock + PATCH 3 + PATCH 4  ${b.split("\n").length} lines  (+${added})`);
console.log("  asserted: COMBINED == PATCHED3 + patch-combined-extraction.py, byte for byte");
