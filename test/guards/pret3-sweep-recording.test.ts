import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The `pret3_sweep` leg can write at most a handful of rows in its entire life, so its recording
 * shape is not observable from behaviour in any cheap tier — but getting it wrong latches the loud
 * "N ingestion legs are broken" banner red on EVERY team, permanently.
 *
 * The hole (Fable review of #587): two failing marker-insert ticks reach a `confirmed` streak and go
 * loud; a later success used to write NOTHING, and the consumed marker forecloses every future row.
 * `failing` includes `confirmed` regardless of age, so no staleness threshold can undo that. The one
 * `ok:true` row is the only thing that clears it — and nothing else in the suite pins that it exists.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const src = readFileSync(join(ROOT, "lib/ingest/scheduler.ts"), "utf8");

/** The `runPret3BootSweep` block, so these assertions cannot be satisfied by some other leg's code. */
const block = (() => {
  const start = src.indexOf("runPret3BootSweep");
  expect(start, "the pret3 sweep call site must exist").toBeGreaterThan(-1);
  return src.slice(start, start + 1800);
})();

describe("guard: the pret3_sweep leg can always clear its own failure streak", () => {
  it("records a SUCCESS row when the sweep ran cleanly", () => {
    expect(block).toMatch(/else if \(s\.ran\)/);
    expect(block, "the success row must be ok:true on the pret3_sweep source").toMatch(
      /source: "pret3_sweep"[^}]*ok: true/
    );
  });

  it("records a FAILURE row when the sweep errored", () => {
    expect(block).toMatch(/if \(s\.error\)/);
    expect(block).toMatch(/source: "pret3_sweep"[^}]*ok: false/);
  });

  it("the two are MUTUALLY EXCLUSIVE — a post-marker failure sets BOTH `ran` and `error`", () => {
    // `if (s.error) … else if (s.ran)`, never two independent `if`s: the tick where the marker landed
    // and the work then threw has ran === true AND error set, and it must record the FAILURE only.
    // Two independent ifs would write an ok:true row alongside the ok:false one, and the newest-row
    // read could then report a failed sweep as healthy.
    const errorAt = block.indexOf("if (s.error)");
    const ranAt = block.indexOf("else if (s.ran)");
    expect(errorAt).toBeGreaterThan(-1);
    expect(ranAt).toBeGreaterThan(errorAt);
    expect(block.slice(errorAt, ranAt)).not.toMatch(/\n\s*if \(s\.ran\)/);
  });
});
