import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  foldStreak,
  FAILURES_TO_CONFIRM,
  type StreakRow,
} from "@/lib/ingest/failure-streak";

/**
 * BANNERFLAP-1 / AIO-866 — one transient failure is not an outage.
 *
 * The spec: `docs/design/pipeline-banner-failure-confirmation.md`. On 2026-08-11 a single
 * arc-synthesis failure at 19:48Z painted "2 ingestion legs are broken — the brain isn't getting fresh
 * data" across Pulse and Admin; the very next run, at 01:36Z, succeeded. Both alarm surfaces read
 * exactly ONE `ingest_runs` row per source and treated it as the verdict.
 *
 * These pin BOTH directions, because the naive version of this fix is a detection regression: the
 * blip must go quiet, and a real outage must stay loud.
 */

const at = (iso: string): string => new Date(iso).toISOString();
/** Rows arrive NEWEST FIRST, the order the streak query returns them in. */
const rows = (...specs: [ok: boolean, iso: string][]): StreakRow[] =>
  specs.map(([ok, iso]) => ({ ok, finishedAt: at(iso) }));

describe("classifyFailure — is the failure standing evidence, or a sample of size one?", () => {
  it("UNCONFIRMED: newest run failed, the one before it succeeded — the reported false positive", () => {
    // The 2026-08-11 incident in its exact shape. Note there is NO age in this fixture: the
    // classification is deliberately time-independent, so this stays quiet at any age. A time-based
    // escalation was the first design and it would have turned this red 2h later — 3h48m of the very
    // banner the slice exists to remove, since the healing run did not land until 01:36Z.
    const streak = foldStreak(rows([false, "2026-08-11T19:48:00Z"], [true, "2026-08-11T15:02:00Z"]));
    expect(classifyFailure(streak)).toBe("unconfirmed");
  });

  it("CONFIRMED: two consecutive failures, however recent — the direction that must not weaken", () => {
    const streak = foldStreak(rows([false, "2026-08-11T19:48:00Z"], [false, "2026-08-11T19:18:00Z"]));
    expect(classifyFailure(streak)).toBe("confirmed");
  });

  it("UNCONFIRMED when the leg's ONLY run ever is a failure — no earlier run to corroborate it", () => {
    // The row the first draft's classification table omitted entirely, leaving a builder to invent:
    // default-confirmed re-manufactures the flap for every new leg's first hiccup; default-ok is a
    // silent gap. Neither is derivable from "newest AND previous both failed".
    expect(classifyFailure(foldStreak(rows([false, "2026-08-11T19:48:00Z"])))).toBe("unconfirmed");
  });

  it("OK whenever the newest run succeeded, even on top of a long past streak", () => {
    const streak = foldStreak(
      rows([true, "2026-08-12T01:36:00Z"], [false, "2026-08-11T19:48:00Z"], [false, "2026-08-11T19:18:00Z"])
    );
    expect(classifyFailure(streak)).toBe("ok");
    expect(streak.streakLength).toBe(0);
    expect(streak.failingSince).toBeNull();
  });

  it("OK on no runs at all — 'nothing has ever run' is not a failure", () => {
    expect(classifyFailure(foldStreak([]))).toBe("ok");
  });

  it("confirms at exactly FAILURES_TO_CONFIRM, not one before it", () => {
    // Boundary, derived from the constant rather than a literal 2 — if the threshold is ever raised,
    // this test follows it instead of silently pinning the old value.
    const failures = Array.from({ length: FAILURES_TO_CONFIRM }, (_, i): [boolean, string] => [
      false,
      `2026-08-11T${String(10 + i).padStart(2, "0")}:00:00Z`,
    ]).reverse();
    expect(classifyFailure(foldStreak(rows(...failures)))).toBe("confirmed");
    expect(classifyFailure(foldStreak(rows(...failures.slice(0, FAILURES_TO_CONFIRM - 1))))).toBe(
      "unconfirmed"
    );
  });
});

describe("foldStreak — failingSince is the OLDEST failure in the streak", () => {
  it("walks past a streak of THREE to the oldest, not the second-oldest and not the newest", () => {
    // A streak of exactly two cannot tell those apart, which is why the fixture is longer: the first
    // draft specified a two-row read, and its criterion was green-by-construction against it while
    // the graph projector 422'ing for weeks (~144 rows at a 30m cadence) would have been reported as
    // "failing for 30 minutes".
    const streak = foldStreak(
      rows(
        [false, "2026-08-11T19:48:00Z"],
        [false, "2026-08-11T19:18:00Z"],
        [false, "2026-08-11T18:48:00Z"],
        [true, "2026-08-11T18:18:00Z"]
      )
    );
    expect(streak.streakLength).toBe(3);
    expect(streak.failingSince).toBe(at("2026-08-11T18:48:00Z"));
    // Explicitly NOT the newest — the label says "failing since" and the newest run is what the
    // banner used to render under it.
    expect(streak.failingSince).not.toBe(at("2026-08-11T19:48:00Z"));
  });

  it("stops at the first success — an older failure before it is a DIFFERENT, healed streak", () => {
    const streak = foldStreak(
      rows(
        [false, "2026-08-11T19:48:00Z"],
        [true, "2026-08-11T19:18:00Z"],
        [false, "2026-08-10T09:00:00Z"] // last week's incident; must not extend today's streak
      )
    );
    expect(streak.streakLength).toBe(1);
    expect(streak.failingSince).toBe(at("2026-08-11T19:48:00Z"));
  });

  it("is null when the leg is not failing", () => {
    expect(foldStreak(rows([true, "2026-08-12T01:36:00Z"])).failingSince).toBeNull();
  });
});
