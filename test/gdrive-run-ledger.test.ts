import { describe, expect, it } from "vitest";
import { gdriveLedgerDisposition, type GdriveRunOutcome } from "@/lib/integrations/gdrive-run-ledger";
import { describeGdriveCoordinator, type GdriveRunRow } from "@/lib/integrations/gdrive-run-status";
import { classifyFailure, foldStreak } from "@/lib/ingest/failure-streak";

/**
 * AIO-1167 r37 — the two pure decisions behind the Drive run ledger and the Admin status line.
 * The real-Postgres counterparts are `gdrive-authority` (route → ledger → banner) and
 * `gdrive-admin-status` (per-connection query → status line).
 */

const ZERO: GdriveRunOutcome = {
  status: "partial", created: 0, updated: 0, unchanged: 0, removed: 0, failed: 0, authoritativeComplete: false,
};

describe("gdriveLedgerDisposition", () => {
  it.each<[string, GdriveRunOutcome, "success" | "failure" | "neutral"]>([
    ["authoritative completion", { ...ZERO, status: "complete", created: 3, authoritativeComplete: true }, "success"],
    // Self-contradictory: `complete` without the authoritative claim is never trusted to recover.
    ["completion that does not claim authority", { ...ZERO, status: "complete", created: 3 }, "failure"],
    ["completion with failed work", { ...ZERO, status: "complete", failed: 1, authoritativeComplete: true }, "failure"],
    ["the exact busy deferral", { ...ZERO, status: "deferred", error: "execution_busy" }, "neutral"],
    ["busy deferral that also failed work", { ...ZERO, status: "deferred", error: "execution_busy", failed: 1 }, "failure"],
    ["busy deferral that also wrote", { ...ZERO, status: "deferred", error: "execution_busy", created: 1 }, "failure"],
    ["deferral for another cause", { ...ZERO, status: "deferred", error: "rate_limited" }, "failure"],
    ["deferral with mixed causes", { ...ZERO, status: "deferred", error: "execution_busy, rate_limited" }, "failure"],
    ["healthy partial progress", { ...ZERO, created: 5 }, "neutral"],
    ["healthy partial with a rate-limit deferral", { ...ZERO, unchanged: 2, error: "rate_limited" }, "neutral"],
    ["partial that failed work", { ...ZERO, created: 5, failed: 1, error: "malformed_document" }, "failure"],
    ["outright failure", { ...ZERO, status: "failed", failed: 1, error: "provider_unavailable" }, "failure"],
    ["failure that reported no failed count", { ...ZERO, status: "failed" }, "failure"],
  ])("%s → %s", (_name, outcome, expected) => {
    expect(gdriveLedgerDisposition(outcome)).toBe(expected);
  });

  it("never classifies any partial or deferred outcome as success", () => {
    for (const status of ["partial", "deferred"] as const) {
      expect(gdriveLedgerDisposition({ ...ZERO, status, created: 9 })).not.toBe("success");
    }
  });
});

/**
 * The Admin ledger as the route writes it: each report becomes a row unless neutral, and the banner's
 * verdict is the real streak fold (`lib/ingest/failure-streak`) over those rows, newest first.
 */
function bannerAfter(reports: GdriveRunOutcome[]) {
  const rows = reports
    .map((outcome, n) => ({ disposition: gdriveLedgerDisposition(outcome), finishedAt: new Date(n * 60_000).toISOString() }))
    .filter((row) => row.disposition !== "neutral")
    .map((row) => ({ ok: row.disposition === "success", finishedAt: row.finishedAt }))
    .reverse();
  const streak = foldStreak(rows);
  return { failureClass: classifyFailure(streak), streakLength: streak.streakLength };
}

describe("only an authoritative completion clears a Drive failure streak", () => {
  const FAILED: GdriveRunOutcome = { ...ZERO, status: "failed", failed: 1, error: "provider_unavailable" };

  it("a complete report without the authoritative claim cannot clear a confirmed failure", () => {
    const nonAuthoritative: GdriveRunOutcome = { ...ZERO, status: "complete", created: 3, authoritativeComplete: false };
    expect(bannerAfter([FAILED, FAILED])).toEqual({ failureClass: "confirmed", streakLength: 2 });
    // It extends the streak rather than ending it: still loud, now three long.
    expect(bannerAfter([FAILED, FAILED, nonAuthoritative])).toEqual({ failureClass: "confirmed", streakLength: 3 });
  });

  it("the same report WITH the authoritative claim is what clears it (positive control)", () => {
    const authoritative: GdriveRunOutcome = { ...ZERO, status: "complete", created: 3, authoritativeComplete: true };
    expect(bannerAfter([FAILED, FAILED, authoritative])).toEqual({ failureClass: "ok", streakLength: 0 });
  });
});

const run = (over: Partial<GdriveRunRow>): GdriveRunRow => ({
  id: "r", integration_id: "i", trigger: "scheduler", status: "complete",
  created_at: "2026-10-23T10:00:00Z", started_at: "2026-10-23T10:00:00Z", finished_at: "2026-10-23T10:01:00Z",
  summary: {}, error: null, ...over,
});

describe("describeGdriveCoordinator", () => {
  it("names the absence of a connection", () => {
    expect(describeGdriveCoordinator({ integrationStatus: null, status: null }))
      .toEqual(["Connect Google Drive to begin reporting runs."]);
  });

  it("an enabled connection with no attempt says backlog and cursor age are unknown", () => {
    expect(describeGdriveCoordinator({ integrationStatus: "enabled", status: null }))
      .toEqual(["No coordinator attempt has been reported yet. Backlog and cursor age are unknown."]);
  });

  it("a paused connection with no history says only that it is paused", () => {
    expect(describeGdriveCoordinator({ integrationStatus: "disabled", status: null }))
      .toEqual(["Paused or disconnected; no work will be claimed."]);
  });

  it("puts the paused state first and labels the history", () => {
    const lines = describeGdriveCoordinator({
      integrationStatus: "disabled",
      status: { latestAttempt: run({ status: "failed", error: "provider_unavailable" }), latestReport: null, latestSuccess: null },
    });
    expect(lines[0]).toBe("Paused or disconnected; no work will be claimed.");
    expect(lines[1]).toMatch(/^Before the pause: last attempt scheduler · failed · /);
  });

  it("takes counts and backlog from the latest progress, never from a busy attempt", () => {
    const lines = describeGdriveCoordinator({
      integrationStatus: "enabled",
      status: {
        latestAttempt: run({ status: "deferred", error: "execution_busy", summary: { backlog: null } }),
        latestReport: run({ status: "partial", summary: { created: 2, backlog: 7, cursorAgeSeconds: 61.4 } }),
        latestSuccess: null,
      },
    });
    expect(lines[0]).toMatch(/· deferred · .* · execution_busy$/);
    expect(lines[1]).toBe("No proven complete success");
    expect(lines[2]).toMatch(/^Latest progress \(partial, .*\): 2 created, .* · backlog 7 · cursor age 61s$/);
  });

  it("an unknown backlog in the latest progress stays unknown", () => {
    const lines = describeGdriveCoordinator({
      integrationStatus: "enabled",
      status: { latestAttempt: run({}), latestReport: run({ summary: { backlog: null } }), latestSuccess: null },
    });
    expect(lines[2]).toMatch(/backlog unknown · cursor age unknown$/);
  });
});
