import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no types.
import { assemble } from "../scripts/graph-window-battery/judge.mjs";

/**
 * The judge's full assembly chain for PIPEFF-2 (AIO-821) — review-required (Amendment 2 conditions).
 *
 * The delta review found that `qualifyingLost` — Q2 v2's only remaining clause — appeared in zero
 * tests and `assemble()` was entirely untested, so a harvest bug that pinned it at 0 would have made
 * the gate permanently, silently vacuous: a clause that passes by never being able to fire. These
 * tests run a REAL loss through the whole chain (files → parsers → universe → decision), and pin the
 * vacuity guard that replaced the hardcoded `underpowered: []`.
 */

// Verbatim shape of a real harness run — total first, per-episode second, label last.
const COST = (tok: number) => `
window      2026-08-06T00:00:00Z → 2026-08-06T01:00:00Z   (drain 10m)
episodes    108   (extract_nodes calls — one per episode)
cross-check 108 pushed per ingest_runs · 0% apart · exact

calls        1,000        9.3 per episode
input tok    4,000,000   ${tok.toLocaleString("en-US")} per episode
output tok   150,000
cost         $1.00       $0.0100 per episode

MULTIPLE     60.0x the content a full episode carries
`;

const NAMES = Array.from({ length: 20 }, (_, i) => ({ name: `project alpha ${i}`, nodes: 1 }));

// Items in which every universe name recurs (≥2 bodies each), so the session clears its floor.
const ITEMS = Array.from({ length: 20 }, (_, i) => [
  { id: `a${i}`, body: `project alpha ${i} shipped` },
  { id: `b${i}`, body: `project alpha ${i} again` },
]).flat();

type Overrides = Partial<Record<"w10" | "same" | "w1", Partial<Record<1 | 2, Record<string, unknown>>>>>;

function writeSession(over: Overrides = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gwb-judge-"));
  const base = {
    episodes: 108,
    episodicNodesLanded: 108,
    Q1: 6.3,
    Q2: 1.0,
    Q4: 0.5,
    personsLost: 0,
    qualifyingLost: 0,
    namesPresent: 3,
    convergenceNames: 1,
    multiChunkItems: 11,
    nameCounts: NAMES,
    dupeEdges: 600,
    group: "aios_team",
  };
  const tokens = { w10: 40_000, same: 25_000, w1: 26_000 } as const;
  for (const arm of ["w10", "same", "w1"] as const) {
    for (const rep of [1, 2] as const) {
      writeFileSync(join(dir, `quality-${arm}-rep${rep}.json`), JSON.stringify({ ...base, ...over[arm]?.[rep] }));
      writeFileSync(join(dir, `cost-${arm}-rep${rep}.txt`), COST(tokens[arm] + rep * 10));
    }
  }
  return dir;
}

describe("assemble — the full chain from result files to a verdict", () => {
  it("ships a clean session (the baseline every mutation below leans on)", () => {
    const r = assemble(writeSession(), ITEMS);
    expect(r.verdict.outcome).toBe("SHIP");
    expect(r.verdict.winner).toBe("SAME");
    expect(r.universe.length).toBeGreaterThanOrEqual(15);
  });

  it("a qualifying person lost in EITHER rep fails Q2 through the whole chain — max of reps, no averaging", () => {
    // The loss is in rep 2 only. Mean-of-reps would read 0.5 "people" and a tolerance could swallow
    // it; the pre-registered max-of-reps cannot.
    const r = assemble(writeSession({ same: { 2: { qualifyingLost: 1 } } }), ITEMS);
    const same = r.verdict.arms.find((a: { name: string }) => a.name === "SAME");
    const q2 = same.results.find((x: { key: string }) => x.key === "Q2");
    expect(q2.verdict).toBe("FAIL");
    expect(q2.absoluteBreach).toMatch(/1 qualifying people lost/);
    expect(same.ships).toBe(false);
    // Arm order still holds: W1 is clean, so W1 ships — SAME's loss does not kill the session.
    expect(r.verdict.winner).toBe("W1");
  });

  it("flags Q2 unpowered when NO member name qualifies — an empty members seed must not read as a pass", () => {
    // convergenceNames = 0 in both incumbent reps ⇒ the count clause has nothing it could ever fire
    // on. The old hardcoded `underpowered: []` read exactly this as fine.
    const dir = writeSession({ w10: { 1: { convergenceNames: 0 }, 2: { convergenceNames: 0 } } });
    const r = assemble(dir, ITEMS);
    expect(r.verdict.outcome).toBe("INVALID");
    expect(r.session.problems.join(" ")).toMatch(/Q2 is UNDERPOWERED/);
  });

  it("goes INVALID when the universe is below its floor, even with clean arms", () => {
    // Items in which no name recurs — the universe empties and the differential question has no
    // evidence. A session without a universe is a power failure, not a pass.
    const r = assemble(writeSession(), [{ id: "solo", body: "nothing recurs here" }]);
    expect(r.verdict.outcome).toBe("INVALID");
    expect(r.session.problems.join(" ")).toMatch(/recurring names/);
  });

  it("reports the per-name breakdown for every universe name — the audit trail the spec requires", () => {
    const r = assemble(writeSession(), ITEMS);
    expect(r.perName).toHaveLength(r.universe.length);
    for (const row of r.perName) {
      expect(row).toHaveProperty("w10");
      expect(row).toHaveProperty("same");
      expect(row).toHaveProperty("w1");
    }
  });
});
