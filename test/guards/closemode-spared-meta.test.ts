import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CLOSEMODE-1 D4 — the scheduler's context-backfill meta writer names `spared` (design round 2 M1:
 * the nested writer is not callable from the dm tier, so its wiring is pinned at the source level;
 * the VALUE's journey is dm-pinned through reconcileItemContext → BackfillResult in
 * test/datamechanics/closemode-flip.datamechanics.test.ts AC1(f)).
 */
describe("scheduler context-backfill meta carries `spared`", () => {
  it("the recordIngestRun meta literal spreads o.spared (when non-zero)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "lib", "ingest", "scheduler.ts"), "utf8");
    const meta = src.split('source: "context_backfill"')[1]?.split("});")[0] ?? "";
    expect(meta).toMatch(/\.\.\.\(o\.spared \? \{ spared: o\.spared \} : \{\}\)/);
  });
});
