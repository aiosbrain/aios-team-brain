import { describe, expect, it } from "vitest";
import { beatKey, resolveBeatClock } from "@/lib/ingest/pipeline-health";
import { BEAT_SCOPE_BY_SOURCE, beatScopeOf, INGEST_LEG_SOURCES } from "@/lib/ingest/leg-ledger";

/**
 * AUDITFIX-24 — spec `docs/design/auditfix24-staleness-beat-scope.md`.
 *
 * The staleness clock used to be `distinct on (source)` across `team_id = $1 or team_id is null`,
 * i.e. whichever partition happened to be newer. `resolveBeatClock` is the pure half of the fix, so
 * the two `undefined`s that carry the whole design are unit-checkable:
 *
 *   - a MISSING clock (no scheduler row in this leg's partition) must NOT age the leg;
 *   - a FAILED READ must NOT silence it.
 */

const TEAM_BEAT = "access_bootstrap"; // declared `team`
const GLOBAL_BEAT = "context_backfill_all"; // declared `global`
const NO_BEAT = "arcs"; // declared `none` — deliberately trigger:'api'
const UNDECLARED = "auto_flip"; // retired (PRET-6); rows survive, no writer does

const LEG_OWN = "2026-08-25T00:00:00.000Z";
const TEAM_ROW = "2026-08-25T10:00:00.000Z";
const GLOBAL_ROW = "2026-08-25T20:00:00.000Z";

/** Both partitions populated, with the GLOBAL row deliberately the newer of the two — the shape the
 *  old `distinct on (source)` read would have resolved to in every case. */
function bothPartitions(source: string): Map<string, string> {
  return new Map([
    [beatKey(source, false), TEAM_ROW],
    [beatKey(source, true), GLOBAL_ROW],
  ]);
}

describe("AUDITFIX-24: the beat resolves from the partition the poller writes", () => {
  it("AC6: a FAILED beat read falls back to the leg's own row — for every scope", () => {
    for (const source of [TEAM_BEAT, GLOBAL_BEAT, NO_BEAT, UNDECLARED]) {
      expect(
        resolveBeatClock({ beats: null, source, legFinishedAt: LEG_OWN }),
        `${source}: a beat read that FAILED must not invent staleness`
      ).toBe(LEG_OWN);
    }
  });

  it("a team-beat leg reads the TEAM row even when the instance-wide row is newer", () => {
    expect(resolveBeatClock({ beats: bothPartitions(TEAM_BEAT), source: TEAM_BEAT, legFinishedAt: LEG_OWN })).toBe(TEAM_ROW);
  });

  it("a team-beat leg with no row of its own resolves NO clock — not the fossil, not its own row", () => {
    // The defect, in one assertion: a brand-new team against a frozen instance-wide row.
    const onlyGlobal = new Map([[beatKey(TEAM_BEAT, true), GLOBAL_ROW]]);
    expect(resolveBeatClock({ beats: onlyGlobal, source: TEAM_BEAT, legFinishedAt: LEG_OWN })).toBeUndefined();
  });

  it("an instance-wide leg reads the GLOBAL row, and ignores a team row entirely", () => {
    expect(resolveBeatClock({ beats: bothPartitions(GLOBAL_BEAT), source: GLOBAL_BEAT, legFinishedAt: LEG_OWN })).toBe(GLOBAL_ROW);
    const onlyTeam = new Map([[beatKey(GLOBAL_BEAT, false), TEAM_ROW]]);
    expect(resolveBeatClock({ beats: onlyTeam, source: GLOBAL_BEAT, legFinishedAt: LEG_OWN })).toBeUndefined();
  });

  it("a `none` leg resolves no clock even when both partitions hold rows", () => {
    // `scan` takes its trigger from a client header and `pm_sync` from a caller parameter, so a
    // `scheduler` row IS expressible for a `none` leg. Scope is what stops it becoming a heartbeat.
    expect(resolveBeatClock({ beats: bothPartitions(NO_BEAT), source: NO_BEAT, legFinishedAt: LEG_OWN })).toBeUndefined();
  });

  it("AC9: an UNDECLARED source resolves from the instance-wide partition", () => {
    expect(beatScopeOf(UNDECLARED)).toBe("global");
    expect(resolveBeatClock({ beats: bothPartitions(UNDECLARED), source: UNDECLARED, legFinishedAt: LEG_OWN })).toBe(GLOBAL_ROW);
    // ⚠️ RESOLVER-LEVEL ONLY, and saying so is the point: no ledger-absent source has a finite
    // threshold today (`auto_flip` is null), so this default has no product-visible consequence. It
    // is defense-in-depth behind the ledger guard, not evidence of safety — an earlier draft offered
    // it as the latter and a review round called that out.
    expect(INGEST_LEG_SOURCES.includes(UNDECLARED)).toBe(false);
  });

  it("the fixtures name real declared scopes — otherwise every case above is vacuous", () => {
    // A renamed source or a re-declared scope would leave these tests passing about nothing.
    expect(BEAT_SCOPE_BY_SOURCE[TEAM_BEAT]).toBe("team");
    expect(BEAT_SCOPE_BY_SOURCE[GLOBAL_BEAT]).toBe("global");
    expect(BEAT_SCOPE_BY_SOURCE[NO_BEAT]).toBe("none");
  });
});
