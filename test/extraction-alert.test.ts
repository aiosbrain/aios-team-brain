import { describe, expect, it } from "vitest";
import {
  alarmKindOf,
  blindnessClearMails,
  classifyBlindnessTick,
  decideBlindnessAction,
  decidePollutionAction,
  latestGraphHealthOfKind,
  refusalRunsClock,
  UNJUDGEABLE_ALERT_HOURS,
  UNREADABLE_GRACE_MS,
  type BlindnessPhase,
  type PollutionGroupTick,
} from "@/lib/graph/extraction-alert";
import type { DbClient } from "@/lib/db/types";

/**
 * The two edge state machines behind the graph pollution alarm (AIO-693, re-armed by ALARMFIX-1):
 * the per-group POLLUTION machine with group memory on the recovery edge, and the BLINDNESS
 * meta-alarm whose persisted wall-clock pages when the pollution alarm has been unable to judge.
 *
 * Spec-first, from docs/design/dedupe-alarm-0293.md. Every named second-order bug in the spec is a
 * test here — they are regressions against designed-for holes, not hypotheticals.
 */

const HOUR = 3_600_000;
const ALERT_MS = UNJUDGEABLE_ALERT_HOURS * HOUR;

const judged = (group: string, polluted: boolean, spanEpisodes = 100): PollutionGroupTick => ({
  group,
  judgeable: true,
  polluted,
  spanEpisodes,
});
const refused = (group: string, spanEpisodes = 100): PollutionGroupTick => ({
  group,
  judgeable: false,
  polluted: false,
  spanEpisodes,
});

describe("decidePollutionAction — combined edges", () => {
  it("fires exactly on the ok→polluted edge, recording WHICH groups", () => {
    const d = decidePollutionAction({
      groups: [judged("t_team", true), judged("t_external", false)],
      priorPolluted: false,
      priorPollutedGroups: [],
    });
    expect(d.action).toBe("alert");
    expect(d.pollutedGroups).toEqual(["t_team"]);
  });

  it("stays silent while pollution persists (no mail per tick)", () => {
    expect(
      decidePollutionAction({
        groups: [judged("t_team", true)],
        priorPolluted: true,
        priorPollutedGroups: ["t_team"],
      }).action
    ).toBe("none");
  });

  it("recovers on the polluted→ok edge when every remembered group is judged-and-healthy", () => {
    expect(
      decidePollutionAction({
        groups: [judged("t_team", false), judged("t_external", false)],
        priorPolluted: true,
        priorPollutedGroups: ["t_team"],
      }).action
    ).toBe("recover");
  });

  it("stays silent while healthy", () => {
    expect(
      decidePollutionAction({
        groups: [judged("t_team", false)],
        priorPolluted: false,
        priorPollutedGroups: [],
      }).action
    ).toBe("none");
  });

  it("a fully-unjudgeable tick never fires and never clears — an outage is not a recovery", () => {
    for (const priorPolluted of [false, true]) {
      expect(
        decidePollutionAction({
          groups: [refused("t_team")],
          priorPolluted,
          priorPollutedGroups: priorPolluted ? ["t_team"] : [],
        }).action
      ).toBe("none");
    }
  });

  it("judgeable if ANY group judged, polluted if ANY judged group polluted", () => {
    const d = decidePollutionAction({
      groups: [refused("t_external"), judged("t_team", true)],
      priorPolluted: false,
      priorPollutedGroups: [],
    });
    expect(d.action).toBe("alert");
  });
});

describe("decidePollutionAction — group memory on the recovery edge", () => {
  it("THE BUG: a small polluted group dipping under its minimum while the team group judges healthy must NOT mail 'recovered'", () => {
    // The one-quiet-Saturday false recovery, reintroduced one layer up: t_external alerted, then its
    // recent window fell under the name minimum (refusal, still has episode flow); t_team judges
    // healthy. Combined judged-healthy — but the group that alerted was never re-judged. The
    // combined verdict must be UNJUDGEABLE ("none"), not a recovery.
    const d = decidePollutionAction({
      groups: [judged("t_team", false), refused("t_external", 40)],
      priorPolluted: true,
      priorPollutedGroups: ["t_external"],
    });
    expect(d.action).toBe("none");
  });

  it("the release valve: a remembered group with ZERO ledger flow across the full span is released", () => {
    // A decommissioned external group (ended client project): nothing is being extracted into it,
    // so there is no ongoing pollution to recover FROM — holding the machine UNJUDGEABLE for it
    // would leave the card red until heat death, the slow-motion cry-wolf.
    const d = decidePollutionAction({
      groups: [judged("t_team", false), refused("t_external", 0)],
      priorPolluted: true,
      priorPollutedGroups: ["t_external"],
    });
    expect(d.action).toBe("recover");
  });

  it("a remembered group with NO ledger presence at all is quiet by the same definition", () => {
    // Team deleted → cascade removed its graph_episodes rows → the group vanishes from the census
    // enumeration entirely. Same valve, not a permanent hold.
    const d = decidePollutionAction({
      groups: [judged("t_team", false)],
      priorPolluted: true,
      priorPollutedGroups: ["gone_external"],
    });
    expect(d.action).toBe("recover");
  });

  it("an UNREADABLE ledger (spanEpisodes null) is not quiet — the valve must not open on missing data", () => {
    const d = decidePollutionAction({
      groups: [judged("t_team", false), { group: "t_external", judgeable: false, polluted: false, spanEpisodes: null }],
      priorPolluted: true,
      priorPollutedGroups: ["t_external"],
    });
    expect(d.action).toBe("none");
  });

  it("a legacy alert row with no recorded groups recovers on plain combined judged-healthy", () => {
    const d = decidePollutionAction({
      groups: [judged("t_team", false)],
      priorPolluted: true,
      priorPollutedGroups: [],
    });
    expect(d.action).toBe("recover");
  });
});

describe("refusalRunsClock — the taxonomy", () => {
  const base = { baselineEpisodes: 0, unreadableSinceMs: null, nowMs: 0 };

  it("predicate-suspect RUNS — episodes flow but the census reads nothing", () => {
    expect(refusalRunsClock("predicate-suspect", base)).toBe(true);
  });

  it("no-baseline PARKS on a young install (no baseline-window episode flow)…", () => {
    // A fresh install whose recent window clears the name minimum before its baseline fills would
    // otherwise get a "your alarm is blind" mail at ~week 2 while perfectly healthy.
    expect(refusalRunsClock("no-baseline", { ...base, baselineEpisodes: 0 })).toBe(false);
    expect(refusalRunsClock("no-baseline", { ...base, baselineEpisodes: null })).toBe(false);
  });

  it("…but RUNS when the ledger shows the baseline window HAD episode flow", () => {
    expect(refusalRunsClock("no-baseline", { ...base, baselineEpisodes: 12 })).toBe(true);
  });

  it("small-sample and graph-unconfigured PARK", () => {
    expect(refusalRunsClock("small-sample", base)).toBe(false);
    expect(refusalRunsClock("graph-unconfigured", base)).toBe(false);
  });

  it("graph-unreadable parks inside the 6h grace, then RUNS", () => {
    const now = Date.UTC(2026, 7, 7);
    expect(
      refusalRunsClock("graph-unreadable", {
        baselineEpisodes: 0,
        unreadableSinceMs: now - UNREADABLE_GRACE_MS + HOUR,
        nowMs: now,
      })
    ).toBe(false);
    expect(
      refusalRunsClock("graph-unreadable", {
        baselineEpisodes: 0,
        unreadableSinceMs: now - UNREADABLE_GRACE_MS,
        nowMs: now,
      })
    ).toBe(true);
    // No first-seen marker (readable a tick ago, or a fresh process) → still inside the grace.
    expect(refusalRunsClock("graph-unreadable", { ...base, nowMs: now })).toBe(false);
  });
});

describe("classifyBlindnessTick", () => {
  it("ANY judged group makes the tick judged, even beside a clock-running refusal", () => {
    expect(
      classifyBlindnessTick([
        { judgeable: true, clockRuns: false },
        { judgeable: false, clockRuns: true },
      ])
    ).toBe("judged");
  });

  it("no judged group + any running refusal = running; only parking refusals = parked", () => {
    expect(
      classifyBlindnessTick([
        { judgeable: false, clockRuns: true },
        { judgeable: false, clockRuns: false },
      ])
    ).toBe("running");
    expect(classifyBlindnessTick([{ judgeable: false, clockRuns: false }])).toBe("parked");
    expect(classifyBlindnessTick([])).toBe("parked"); // cold start: nothing to protect yet
  });
});

describe("decideBlindnessAction — the persisted wall-clock", () => {
  const now = Date.UTC(2026, 7, 7);

  it("a running refusal after a judged/unknown state writes the anchor (no mail)", () => {
    expect(decideBlindnessAction({ tick: "running", latest: null, nowMs: now })).toBe("anchor");
    expect(
      decideBlindnessAction({ tick: "running", latest: { phase: "cleared", atMs: now - HOUR }, nowMs: now })
    ).toBe("anchor");
  });

  it("fires exactly when the anchor is ≥ 24h old", () => {
    expect(
      decideBlindnessAction({ tick: "running", latest: { phase: "anchor", atMs: now - ALERT_MS + HOUR }, nowMs: now })
    ).toBe("none");
    expect(
      decideBlindnessAction({ tick: "running", latest: { phase: "anchor", atMs: now - ALERT_MS }, nowMs: now })
    ).toBe("fire");
  });

  it("THE RE-MAIL LOOP (mutation: no `fired` phase): after the mail, ticks past hour 24 must NOT re-fire", () => {
    // Without the `fired` phase, every clock-running tick past hour 24 re-mails forever.
    expect(
      decideBlindnessAction({ tick: "running", latest: { phase: "fired", atMs: now - 3 * ALERT_MS }, nowMs: now })
    ).toBe("none");
  });

  it("THE STALE ANCHOR (mutation: no `cleared` phase): a judged tick voids the clock so a refusal weeks later cannot fire instantly", () => {
    // Step 1: the judged tick after an anchor must WRITE the cleared row…
    expect(
      decideBlindnessAction({ tick: "judged", latest: { phase: "anchor", atMs: now - 2 * HOUR }, nowMs: now })
    ).toBe("clear");
    // Step 2: …so a clock-running refusal three weeks later starts a NEW anchor instead of firing
    // instantly off the stale one. (Without `cleared`, `latest` would still be that ≥24h anchor.)
    const threeWeeks = now + 21 * 24 * HOUR;
    expect(
      decideBlindnessAction({
        tick: "running",
        latest: { phase: "cleared", atMs: now },
        nowMs: threeWeeks,
      })
    ).toBe("anchor");
  });

  it("a judged tick after a FIRE clears too — that is the recovery edge", () => {
    expect(
      decideBlindnessAction({ tick: "judged", latest: { phase: "fired", atMs: now - HOUR }, nowMs: now })
    ).toBe("clear");
  });

  it("a judged tick with no blindness history does nothing (no phantom cleared rows)", () => {
    expect(decideBlindnessAction({ tick: "judged", latest: null, nowMs: now })).toBe("none");
    expect(
      decideBlindnessAction({ tick: "judged", latest: { phase: "cleared", atMs: now - HOUR }, nowMs: now })
    ).toBe("none");
  });

  it("a PARKED tick changes nothing — even over a stale anchor, parking must mean parking", () => {
    // small-sample is a ledger-confirmed quiet state; if a parked tick could still fire off an old
    // anchor, the taxonomy's PARK verdict would be decorative at exactly the moment it matters.
    expect(
      decideBlindnessAction({ tick: "parked", latest: { phase: "anchor", atMs: now - 3 * ALERT_MS }, nowMs: now })
    ).toBe("none");
  });

  it("clearing mails ONLY when the spell actually fired — voiding a mere anchor is silent bookkeeping", () => {
    expect(blindnessClearMails("fired")).toBe(true);
    expect(blindnessClearMails("anchor")).toBe(false);
  });
});

describe("the ~30h composition — grace and clock are SERIAL", () => {
  it("a rotted credential pages at unreadable-start + 6h grace + 24h clock", () => {
    const t0 = Date.UTC(2026, 7, 1); // Neo4j becomes unreadable; in-memory grace marker starts
    const tick = (nowMs: number, latest: { phase: BlindnessPhase; atMs: number } | null) => {
      const clockRuns = refusalRunsClock("graph-unreadable", {
        baselineEpisodes: 0,
        unreadableSinceMs: t0,
        nowMs,
      });
      return decideBlindnessAction({
        tick: classifyBlindnessTick([{ judgeable: false, clockRuns }]),
        latest,
        nowMs,
      });
    };
    // Inside the grace: parked, no anchor row — a transient restart leaves no ledger churn.
    expect(tick(t0 + 5 * HOUR, null)).toBe("none");
    // Grace expires: the clock starts (anchor written at ≈ t0+6h).
    expect(tick(t0 + UNREADABLE_GRACE_MS, null)).toBe("anchor");
    const anchor = { phase: "anchor" as const, atMs: t0 + UNREADABLE_GRACE_MS };
    // 23h into the clock: still quiet.
    expect(tick(t0 + UNREADABLE_GRACE_MS + ALERT_MS - HOUR, anchor)).toBe("none");
    // grace + 24h ≈ 30h after t0: the page goes out.
    const fireAt = t0 + UNREADABLE_GRACE_MS + ALERT_MS;
    expect(tick(fireAt, anchor)).toBe("fire");
    expect(fireAt - t0).toBe(30 * HOUR);
  });
});

describe("the per-kind ledger read", () => {
  it("legacy kindless rows read as POLLUTION", () => {
    expect(alarmKindOf({})).toBe("pollution");
    expect(alarmKindOf(undefined)).toBe("pollution");
    expect(alarmKindOf(null)).toBe("pollution");
    expect(alarmKindOf({ alarm: "pollution" })).toBe("pollution");
    expect(alarmKindOf({ alarm: "blindness" })).toBe("blindness");
  });

  // A minimal ingest_runs fake: newest-first rows, enough builder surface for the read.
  const fakeDb = (rows: Array<{ ok: boolean; meta: unknown; finished_at: string }>): DbClient => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (resolve: (v: { data: unknown[]; error: null; count: null }) => unknown) =>
        Promise.resolve({ data: rows, error: null, count: null }).then(resolve),
    };
    return { from: () => builder } as unknown as DbClient;
  };

  it("ISOLATION: a blindness `fired` row (ok:false) must not read as a polluted pollution prior", async () => {
    // The spec's named bug: without the discriminator, this ledger state would make the next healthy
    // pollution tick mail "graph extraction recovered" for an alert that never fired.
    const db = fakeDb([
      { ok: false, meta: { alarm: "blindness", phase: "fired" }, finished_at: "2026-08-06T00:00:00Z" },
    ]);
    expect(await latestGraphHealthOfKind(db, "pollution")).toBeNull();
    const blind = await latestGraphHealthOfKind(db, "blindness");
    expect(blind?.meta.phase).toBe("fired");
  });

  it("reads THROUGH newer rows of the other kind to the newest of the requested kind", async () => {
    const db = fakeDb([
      { ok: true, meta: { alarm: "blindness", phase: "anchor" }, finished_at: "2026-08-06T12:00:00Z" },
      { ok: false, meta: { alarm: "pollution", groups: ["t_team"] }, finished_at: "2026-08-01T00:00:00Z" },
    ]);
    const pol = await latestGraphHealthOfKind(db, "pollution");
    expect(pol?.ok).toBe(false);
    expect(pol?.meta.groups).toEqual(["t_team"]);
  });

  it("a legacy kindless failure row reads as the pollution prior (older installs / fixtures)", async () => {
    const db = fakeDb([{ ok: false, meta: {}, finished_at: "2026-07-01T00:00:00Z" }]);
    const pol = await latestGraphHealthOfKind(db, "pollution");
    expect(pol?.ok).toBe(false);
    expect(await latestGraphHealthOfKind(db, "blindness")).toBeNull();
  });

  it("tolerates jsonb arriving as a string — a driver quirk must not blind the read", async () => {
    const db = fakeDb([
      { ok: true, meta: JSON.stringify({ alarm: "blindness", phase: "cleared" }), finished_at: "2026-08-06T00:00:00Z" },
    ]);
    const blind = await latestGraphHealthOfKind(db, "blindness");
    expect(blind?.meta.phase).toBe("cleared");
  });
});
