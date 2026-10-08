import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attributionRepairContinuation,
  describeManualRepair,
  describeRepairHandover,
  MANUAL_REPAIR_CONTROL,
  reportRepairHandover,
} from "@/lib/ingest/attribution-repair-report";
import type { AttributionRepairOutcome } from "@/lib/ingest/reconcile-attribution";
import { startAttributionRepairScheduler } from "@/lib/ingest/attribution-repair-scheduler";
import { readFileSync } from "node:fs";

/**
 * REPORTING an attribution repair that did not finish (AIO-1167, Stage-4 HOLD remediation).
 *
 * Spec. A bounded repair that ends `continuing` has saved its progress. What carries it on depends
 * on the deployment, and the Admin button and the post-mutation hooks must say which:
 *
 *   1. On a COPIED-STAGING runtime every in-process scheduler is suppressed, on purpose. Nothing
 *      there continues a repair in the background, so a partial or busy result must never say that
 *      it does. It says: progress is saved, background continuation is disabled, and an admin must
 *      run "Re-attribute content" again. Contention (another run holds the repair) is told apart
 *      from progress, and neither is told as completion.
 *   2. In a normal runtime the scheduler does continue it, and the message still says so.
 *   3. Completion reads the same everywhere.
 *   4. The report only reports: copied staging does not start the scheduler because of it.
 */

const outcome = (over: Partial<AttributionRepairOutcome>): AttributionRepairOutcome => ({
  scanned: 0, updated: 0, versionsUpdated: 0, contributionsUpdated: 0, revision: 7, partial: true,
  turn: "scanned", status: "continuing", busy: false, ...over,
});
const PARTIAL = outcome({ scanned: 10_000, updated: 9_400, versionsUpdated: 12 });
const BUSY = outcome({ busy: true, turn: "busy", revision: 0 });
/** A run that committed three batches, let go of the turn between them, and then found another owner. */
const BUSY_AFTER_PROGRESS = outcome({ scanned: 300, updated: 240, busy: true, turn: "busy" });
const COMPLETE = outcome({ scanned: 150, updated: 150, status: "complete", partial: false, turn: "complete" });

/** Anything that would read as "this will finish by itself". */
const PROMISES_BACKGROUND = /continuing in the background|continues? in the background|will (continue|resume|finish)|automatically|scheduler/i;

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;
const COPIED_STAGING = env({ STAGING_DATA_MODE: "copy-ready", INGEST_POLL_ENABLED: "true", ATTRIBUTION_REPAIR_POLL_ENABLED: "true" });
const NORMAL = env({});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("what continues an unfinished repair is a property of the deployment", () => {
  it("copied staging: nothing does, whatever the poll flags say", () => {
    expect(attributionRepairContinuation(COPIED_STAGING)).toBe("manual");
    // The trimming parser the rest of the policy uses, not a raw comparison.
    expect(attributionRepairContinuation(env({ STAGING_DATA_MODE: " copy-ready " }))).toBe("manual");
  });

  it("a normal runtime: the scheduler does — or the ingest backstop, while either poller runs", () => {
    expect(attributionRepairContinuation(NORMAL)).toBe("background");
    expect(attributionRepairContinuation(env({ ATTRIBUTION_REPAIR_POLL_ENABLED: "false" }))).toBe("background");
    expect(attributionRepairContinuation(env({ INGEST_POLL_ENABLED: "false" }))).toBe("background");
    // With BOTH pollers switched off there is, truthfully, no background continuation either.
    expect(attributionRepairContinuation(env({ ATTRIBUTION_REPAIR_POLL_ENABLED: "false", INGEST_POLL_ENABLED: "false" }))).toBe("manual");
  });

  it("reads the live environment by default", () => {
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    expect(attributionRepairContinuation()).toBe("manual");
    expect(describeManualRepair(PARTIAL)).not.toMatch(PROMISES_BACKGROUND);
    vi.stubEnv("STAGING_DATA_MODE", "");
    expect(attributionRepairContinuation()).toBe("background");
    expect(describeManualRepair(PARTIAL)).toContain("continuing in the background");
  });
});

describe("the Admin button's message", () => {
  it("COPIED STAGING, partial: progress is saved, background continuation is disabled, an admin must run it again", () => {
    const message = describeManualRepair(PARTIAL, "manual");
    expect(message).toBe(
      "Re-attributed 9400 of 10000 item(s) + 12 version(s) so far; the repair is not complete. "
      + "Progress is saved, but background continuation is disabled on this deployment: "
      + "an admin must run Re-attribute content again to continue.",
    );
    expect(message).not.toMatch(PROMISES_BACKGROUND);
    expect(message).toContain(MANUAL_REPAIR_CONTROL);
  });

  it("COPIED STAGING, busy: contention is told apart from progress and from completion, and still promises nothing", () => {
    const message = describeManualRepair(BUSY, "manual");
    expect(message).toBe(
      "Another re-attribution run holds this team's repair right now, so this run stopped and the repair is not complete. "
      + "Progress is saved, but background continuation is disabled on this deployment: "
      + "an admin must run Re-attribute content again once that run has finished.",
    );
    expect(message).not.toMatch(PROMISES_BACKGROUND);
    // Not a progress report (no progress is known) and not a completion.
    expect(message).not.toMatch(/Re-attributed \d/);
    expect(message).not.toContain("to current identity mappings");
    expect(message).not.toBe(describeManualRepair(PARTIAL, "manual"));
  });

  it("ZERO-COUNTER busy makes no claim about the whole run, in either mode: the counters restart with a new revision, so zero does not prove no work", () => {
    // The outcome of a run that committed a batch at one revision, saw a newer revision replace it,
    // and then lost the new revision's turn is exactly this: busy, every counter zero.
    const afterReset = outcome({ busy: true, turn: "busy", revision: 8 });
    for (const zero of [BUSY, afterReset]) {
      for (const mode of ["manual", "background"] as const) {
        const message = describeManualRepair(zero, mode);
        expect(message, `${mode}: ${message}`).not.toMatch(/did nothing|nothing was|no work|no progress|unchanged|not started|never started/i);
        // It is still plainly contention, and still not a completion.
        expect(message).toMatch(/re-attribution (run holds this team's repair|is already running for this team)/i);
        expect(message).not.toContain("to current identity mappings");
      }
      expect(describeManualRepair(zero, "manual")).not.toMatch(PROMISES_BACKGROUND);
      expect(describeManualRepair(zero, "manual")).toContain("Progress is saved, but background continuation is disabled on this deployment");
    }
  });

  it("BUSY AFTER PROGRESS, copied staging: the committed work is reported, not discarded as 'did nothing' — and still nothing is promised", () => {
    const message = describeManualRepair(BUSY_AFTER_PROGRESS, "manual");
    expect(message).toBe(
      "Re-attributed 240 of 300 item(s) so far; another re-attribution run then took over this team's repair, and the repair is not complete. "
      + "Progress is saved, but background continuation is disabled on this deployment: "
      + "an admin must run Re-attribute content again once that run has finished.",
    );
    expect(message).not.toContain("did nothing");
    expect(message).not.toMatch(PROMISES_BACKGROUND);
    expect(message).not.toContain("to current identity mappings");
    // Three distinct facts, three distinct messages.
    expect(new Set([message, describeManualRepair(BUSY, "manual"), describeManualRepair({ ...BUSY_AFTER_PROGRESS, busy: false }, "manual")]).size).toBe(3);
    // Contention with no KNOWN progress stays a contention message, and reports no counters.
    expect(describeManualRepair(BUSY, "manual")).toContain("Another re-attribution run holds this team's repair right now");
    expect(describeManualRepair(BUSY, "manual")).not.toMatch(/Re-attributed \d/);
  });

  it("BUSY AFTER PROGRESS, normal runtime: the committed work is reported and the repair is still said to continue in the background", () => {
    const message = describeManualRepair(BUSY_AFTER_PROGRESS, "background");
    expect(message).toBe(
      "Re-attributed 240 of 300 item(s) so far; another re-attribution run then took over this team's repair, "
      + "and re-attribution is continuing in the background.",
    );
    expect(message).not.toContain("did nothing");
    expect(message).not.toContain("disabled");
    expect(message).not.toContain(MANUAL_REPAIR_CONTROL);
    expect(new Set([message, describeManualRepair(BUSY, "background"), describeManualRepair({ ...BUSY_AFTER_PROGRESS, busy: false }, "background")]).size).toBe(3);
  });

  it("any committed counter counts as progress — a run that only revisited rows, or only healed versions, did not 'do nothing'", () => {
    for (const counters of [{ scanned: 5 }, { updated: 1 }, { versionsUpdated: 2 }, { contributionsUpdated: 3 }]) {
      const busy = outcome({ ...counters, busy: true, turn: "busy" });
      expect(describeManualRepair(busy, "manual"), JSON.stringify(counters)).not.toContain("did nothing");
      expect(describeManualRepair(busy, "manual")).toContain("then took over this team's repair");
      expect(describeManualRepair(busy, "background")).toContain("then took over this team's repair");
    }
  });

  it("NORMAL runtime: partial and busy still say the repair continues in the background", () => {
    expect(describeManualRepair(PARTIAL, "background"))
      .toBe("Re-attributed 9400 of 10000 item(s) + 12 version(s) so far; re-attribution is continuing in the background.");
    expect(describeManualRepair(BUSY, "background"))
      .toBe("Re-attribution is already running for this team and is continuing in the background.");
    for (const message of [describeManualRepair(PARTIAL, "background"), describeManualRepair(BUSY, "background")]) {
      expect(message).not.toContain("disabled");
      expect(message).not.toContain(MANUAL_REPAIR_CONTROL);
    }
  });

  it("COMPLETION reads the same everywhere and never mentions continuation", () => {
    const message = "Re-attributed 150 of 150 item(s) to current identity mappings.";
    expect(describeManualRepair(COMPLETE, "manual")).toBe(message);
    expect(describeManualRepair(COMPLETE, "background")).toBe(message);
  });
});

describe("the post-mutation hooks' log line", () => {
  it("says nothing when the repair finished", () => {
    expect(describeRepairHandover("team-1", COMPLETE, "manual")).toBeNull();
    expect(describeRepairHandover("team-1", COMPLETE, "background")).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    reportRepairHandover("team-1", COMPLETE, "manual");
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("COPIED STAGING: a WARNING that the repair is not complete and an admin must run the manual repair — for a spent budget and for contention", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    reportRepairHandover("team-1", PARTIAL, "manual");
    reportRepairHandover("team-1", BUSY, "manual");
    expect(info).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      "[attribution] repair for team team-1 is NOT complete (its bounded budget ended): progress is saved, but background "
        + "continuation is disabled on this deployment — an admin must run Re-attribute content again",
      "[attribution] repair for team team-1 is NOT complete (another run holds its repair): progress is saved, but background "
        + "continuation is disabled on this deployment — an admin must run Re-attribute content again",
    ]);
    for (const [line] of warn.mock.calls) expect(line).not.toMatch(PROMISES_BACKGROUND);
  });

  it("NORMAL runtime: an informational line that it is continuing in the background", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    reportRepairHandover("team-1", PARTIAL, "background");
    reportRepairHandover("team-1", BUSY, "background");
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls.map(([line]) => line)).toEqual([
      "[attribution] repair for team team-1 is continuing in the background (its bounded budget ended)",
      "[attribution] repair for team team-1 is continuing in the background (another run holds its repair)",
    ]);
  });
});

describe("the report reports; it does not change what runs", () => {
  it("copied staging still starts no scheduler: nothing is armed, before or after a manual-continuation report", () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
      vi.stubEnv("ATTRIBUTION_REPAIR_POLL_ENABLED", "true");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      startAttributionRepairScheduler();
      reportRepairHandover("team-1", PARTIAL);
      expect(describeManualRepair(BUSY)).not.toMatch(PROMISES_BACKGROUND);
      startAttributionRepairScheduler();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("both callers use this one report, and neither hard-codes a continuation promise", () => {
    const action = readFileSync("app/t/[team]/admin/members/actions.ts", "utf8");
    const hook = readFileSync("lib/ingest/reconcile-attribution.ts", "utf8");
    // The button's answer and both hooks' log lines come from here…
    expect(action).toContain("message: describeManualRepair(s)");
    expect(action).toContain("reportRepairHandover(teamId, outcome)");
    expect(hook).toContain("reportRepairHandover(teamId, await repairAttributionNow(db, teamId, teamSlug))");
    // …so no caller states, in code of its own, that a repair continues in the background.
    const code = (source: string) => source
      .split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n");
    for (const source of [action, hook]) expect(code(source)).not.toMatch(/background/i);
    // The manual action is still the trusted direct repair: it requests, with its full budget.
    expect(action).toContain("repairAttributionNow(adminClient(), ctx.teamId, teamSlug, { maxBatches: 100, request: true })");
  });
});
