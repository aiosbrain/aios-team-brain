import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TICKFIT-1 (Fable diff L3): `connector_cursors` has ONE legal writer — `lib/ingest/cursors.ts`.
 * The watermark's correctness rests on a cursor advancing ONLY after a fully-successful pass;
 * a second writer could advance it out of band and orphan a delta behind a skip. Same shape as
 * the other single-writer guards: scan app/lib/scripts for the table name outside the owner.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const OWNER = join("lib", "ingest", "cursors.ts");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mjs)$/.test(name)) yield p;
  }
}

describe("connector_cursors single writer", () => {
  it("no file outside lib/ingest/cursors.ts touches the table", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "lib", "scripts"]) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = file.slice(ROOT.length + 1);
        if (rel === OWNER) continue;
        if (readFileSync(file, "utf8").includes('from("connector_cursors")')) offenders.push(rel);
      }
    }
    expect(offenders, `connector_cursors touched outside the single writer:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(readFileSync(join(ROOT, OWNER), "utf8").includes('from("connector_cursors")')).toBe(true);
  });
});
