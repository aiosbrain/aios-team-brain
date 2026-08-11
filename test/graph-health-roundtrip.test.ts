import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db/types";
import type { CensusRefusal, GroupCensus } from "@/lib/graph/extraction-health";

/**
 * The WRITE→READ round-trip of the graph_health ledger (review MEDIUM on the first cut of
 * ALARMFIX-1): every other test in this suite hands the machines already-parsed state, so a rename
 * at the WRITE site only (`meta.phase` → anything else) would leave them all green while the
 * blindness machine re-anchors every tick and never fires — the alarm's persistence would be
 * decorative. This file drives `runGraphHealthCheck` across multi-tick sequences against a ledger
 * fake that STORES what one tick inserts and returns it to the next, so the row a tick writes must
 * be the row the next tick can parse (`meta.phase` and `meta.groups` round-trip, through
 * `recordIngestRun`'s jsonb stringification and the read side's tolerant parse).
 */

vi.mock("@/lib/graph/neo4j", () => ({ neo4jConfigured: () => true }));
vi.mock("@/lib/auth/mailer", () => ({ mailerConfigured: () => false, sendOpsAlert: vi.fn() }));
vi.mock("@/lib/graph/extraction-health", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  groupCensuses: vi.fn(),
}));

import { groupCensuses } from "@/lib/graph/extraction-health";
import { runGraphHealthCheck, _resetUnreadableGraceForTests } from "@/lib/graph/extraction-alert";

const censusesMock = vi.mocked(groupCensuses);

const HOUR = 3_600_000;

/** A GroupCensus with a fabricated verdict — the runner consumes the derived object, so the tests
 *  control judgeable/polluted/refusal directly (the armed clamp is derivation-side, not here). */
const census = (
  group: string,
  verdict: { judgeable: boolean; polluted: boolean; refusal?: CensusRefusal | null },
  spanEpisodes = 60
): GroupCensus => ({
  group,
  signals: { recentNames: 100, recentSplit: 10, baselineNames: 100, baselineSplit: 1 },
  recentEpisodes: 20,
  baselineEpisodes: 40,
  spanEpisodes,
  pollution: {
    polluted: verdict.polluted,
    judgeable: verdict.judgeable,
    recentShare: 0.1,
    baselineShare: 0.01,
    reason: verdict.polluted ? "test pollution — check the Extraction model" : null,
    refusal: verdict.refusal ?? null,
  },
});

/** An ingest_runs fake that actually STORES inserts and serves them back newest-first — the seam
 *  under test. Only the surface the alert module touches. */
function ledgerDb(): { db: DbClient; rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      let inserted: Record<string, unknown> | null = null;
      const builder = {
        select: () => builder,
        insert: (v: Record<string, unknown>) => {
          inserted = v;
          return builder;
        },
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        then: (resolve: (v: { data: unknown[] | null; error: null; count: null }) => unknown) => {
          if (inserted !== null) {
            rows.push({ table, ...inserted });
            return Promise.resolve({ data: null, error: null, count: null }).then(resolve);
          }
          const data = rows
            .filter((r) => r.table === "ingest_runs" && r.source === "graph_health")
            .sort(
              (a, b) => Date.parse(String(b.finished_at)) - Date.parse(String(a.finished_at))
            );
          return Promise.resolve({ data, error: null, count: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as DbClient, rows };
}

const tick = async (db: DbClient, censuses: GroupCensus[], nowMs: number) => {
  censusesMock.mockResolvedValueOnce(censuses);
  return runGraphHealthCheck(db, nowMs);
};

beforeEach(() => {
  censusesMock.mockReset();
  _resetUnreadableGraceForTests();
});

describe("blindness rows round-trip: the anchor a tick writes is the anchor the next tick reads", () => {
  const t0 = Date.UTC(2026, 7, 1);
  const suspect = () => [census("t_team", { judgeable: false, polluted: false, refusal: "predicate-suspect" })];
  const healthy = () => [census("t_team", { judgeable: true, polluted: false })];

  it("anchor → (quiet) → fire at 24h → debounced → cleared on the judged tick", async () => {
    const { db, rows } = ledgerDb();
    // Tick 1: first clock-running refusal after unknown — the anchor row is WRITTEN.
    expect((await tick(db, suspect(), t0)).blindness).toBe("anchor");
    // Tick 2, 1h later: the anchor must be READ BACK. The named write-site failure (meta.phase
    // renamed on write only) makes this tick re-anchor instead — and then hour 24 never arrives.
    expect((await tick(db, suspect(), t0 + HOUR)).blindness).toBe("none");
    // Tick 3, past 24h from the PERSISTED anchor: the mail fires.
    expect((await tick(db, suspect(), t0 + 25 * HOUR)).blindness).toBe("fire");
    // Tick 4: the fired row round-trips too — still blind, but edge-debounced.
    expect((await tick(db, suspect(), t0 + 26 * HOUR)).blindness).toBe("none");
    // Tick 5: first judged tick — cleared (recovery edge off the round-tripped fired row).
    expect((await tick(db, healthy(), t0 + 27 * HOUR)).blindness).toBe("clear");
    // The ledger holds exactly the three-phase audit trail, in order.
    const phases = rows.map((r) => JSON.parse(String(r.meta)).phase);
    expect(phases).toEqual(["anchor", "fired", "cleared"]);
  });
});

describe("pollution rows round-trip: groups written by alert/refresh are the memory the next tick holds", () => {
  const t0 = Date.UTC(2026, 7, 1);
  const g = (a: { judgeable: boolean; polluted: boolean; refusal?: CensusRefusal }, b: { judgeable: boolean; polluted: boolean; refusal?: CensusRefusal }) => [
    census("A", a),
    census("B", b),
  ];

  it("alert [A] → refresh joins B (no re-alert) → B's unjudged dip blocks recovery → recovery only when B re-judges healthy", async () => {
    const { db, rows } = ledgerDb();
    const P = { judgeable: true, polluted: true };
    const H = { judgeable: true, polluted: false };
    const dip = { judgeable: false, polluted: false, refusal: "small-sample" as const };
    // Tick 1: A pollutes → alert; the row records groups [A].
    expect((await tick(db, g(P, H), t0)).pollution).toBe("alert");
    // Tick 2: B joins mid-incident → refresh row with the UNION, not a second mail. Requires the
    // tick-1 row's meta.groups to have round-tripped (else priorPolluted reads clean → re-alert).
    expect((await tick(db, g(P, P), t0 + HOUR)).pollution).toBe("refresh");
    // Tick 3: B dips unjudged (live flow), A judges healthy. The refresh row's UNION is the memory
    // now — if meta.groups did not round-trip, this tick would falsely mail "recovered".
    expect((await tick(db, g(H, { ...dip }), t0 + 2 * HOUR)).pollution).toBe("none");
    // Tick 4: B re-judges healthy → the genuine recovery.
    expect((await tick(db, g(H, H), t0 + 3 * HOUR)).pollution).toBe("recover");
    // The refresh row carried the union and is a state row, not a second alert.
    const metas = rows.map((r) => JSON.parse(String(r.meta)));
    expect(metas[0].groups).toEqual(["A"]);
    expect([...metas[1].groups].sort()).toEqual(["A", "B"]);
    expect(metas[1].refresh).toBe(true);
  });
});

/**
 * CENSUSFLOOR-1 (code review MEDIUM): the PRODUCTION tick construction was unpinned against a
 * taxonomy bypass. `runBlindnessMachine` derives `clockRuns` per group via `refusalRunsClock`
 * (`lib/graph/extraction-alert.ts:496-502`); replacing that with `refusal !== null` leaves the whole
 * suite green — A5 composes the chain test-side, `refusalRunsClock`'s own tests are pure, and every
 * all-unjudgeable sequence in this file used `predicate-suspect` (which runs the clock either way),
 * while its one `small-sample` dip sits beside a judgeable group so the tick is `judged` regardless.
 *
 * That mutation ships EXACTLY the spurious page CENSUSFLOOR-1 exists to prevent: a healthy install
 * whose only refusal is a parked `small-sample` would anchor and then mail "the pollution alarm has
 * gone blind". Pinning the park here, at the production seam, over the full 25h the machine needs.
 */
describe("a parked refusal never runs the blindness clock — the production seam (CENSUSFLOOR-1)", () => {
  const t0 = Date.UTC(2026, 7, 1);
  const parked = { judgeable: false, polluted: false, refusal: "small-sample" as const };

  it("every group small-sample for 25h+ NEVER anchors and NEVER fires", async () => {
    const { db } = ledgerDb();
    // Hour 0 — a parked tick must not even anchor; anchoring is what makes the 24h clock start.
    expect((await tick(db, [census("A", parked), census("B", parked)], t0)).blindness).toBe("none");
    // Hour 25 — past UNJUDGEABLE_ALERT_HOURS. Still nothing: parked ticks change nothing, so there
    // is no anchor to fire off. If `clockRuns` ever stops consulting `refusalRunsClock`, this reads
    // "anchor" here and "fire" on the next tick.
    expect(
      (await tick(db, [census("A", parked), census("B", parked)], t0 + 25 * HOUR)).blindness
    ).toBe("none");
  });

  it("…while a clock-RUNNING refusal on the same shape does anchor — the pin is not vacuous", async () => {
    const { db } = ledgerDb();
    const suspect = { judgeable: false, polluted: false, refusal: "predicate-suspect" as const };
    expect((await tick(db, [census("A", suspect)], t0)).blindness).toBe("anchor");
  });
});
