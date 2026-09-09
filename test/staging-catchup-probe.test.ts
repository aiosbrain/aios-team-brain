import { describe, expect, it, vi } from "vitest";
import { waitForExpectedReady, waitForImportedBoot } from "../scripts/staging-ops/importer.mjs";

const COMMIT = "d".repeat(40);
const maintenance = { readDeployment: async () => ({ status: "SUCCESS" }) };
// A short but not knife-edge budget with an instant sleep: long enough that a slow machine still
// enters the loop for the positive cases, short enough that the refusals return immediately.
const nowait = { timeoutMs: 250, sleep: async () => {} };

/** The health answer a CAUGHT-UP staging app gives: the journal never left `ready`. */
const readyBody = { ok: true, mode: "copy-ready", commit: COMMIT, refreshRunId: "run-9", postgres: "ready", graph: "readable" };

describe("B2 — catch-up is verified against the expected-ready contract", () => {
  it("accepts the ready answer a caught-up app actually gives", async () => {
    const fetchImpl = vi.fn(async () => Response.json(readyBody, { status: 200 }));
    await expect(waitForExpectedReady({
      ...nowait, fetchImpl, maintenance, deploymentId: "d1", commit: COMMIT,
      origin: "http://staging.test", token: "t".repeat(32), mode: "copy-ready", runId: "run-9",
    })).resolves.toBe(true);
  });

  it("is the probe the install path could never satisfy — the regression, stated directly", async () => {
    // Same 200/ready response, through the INSTALL waiter: it admits only 202-booted (or the
    // legacy 200 shape), so every catch-up "timed out" after a successful deploy and burned an
    // attempt, until the bounded budget was exhausted.
    const fetchImpl = vi.fn(async () => Response.json(readyBody, { status: 200 }));
    await expect(waitForImportedBoot({
      ...nowait, fetchImpl, maintenance, deploymentId: "d1", commit: COMMIT,
      origin: "http://staging.test", token: "t".repeat(32), mode: "copy-ready",
    })).rejects.toThrow(/boot probe/);
  });

  it("does not send the boot-probe header, because the app is not booting", async () => {
    const fetchImpl = vi.fn(async () => Response.json(readyBody, { status: 200 }));
    await waitForExpectedReady({
      ...nowait, fetchImpl, maintenance, deploymentId: "d1", commit: COMMIT,
      origin: "http://staging.test", token: "t".repeat(32), mode: "copy-ready", runId: "run-9",
    });
    expect(fetchImpl.mock.calls[0][1].headers["x-aios-staging-boot-probe"]).toBeUndefined();
    expect(fetchImpl.mock.calls[0][1].headers["x-aios-staging-health-token"]).toBe("t".repeat(32));
  });

  it.each([
    ["a different commit", { ...readyBody, commit: "e".repeat(40) }],
    ["a different mode", { ...readyBody, mode: "legacy-pg-only" }],
    ["a different refresh run", { ...readyBody, refreshRunId: "run-8" }],
    ["a not-ready body", { ...readyBody, ok: false }],
  ])("refuses %s", async (_label, body) => {
    const fetchImpl = vi.fn(async () => Response.json(body, { status: 200 }));
    await expect(waitForExpectedReady({
      ...nowait, fetchImpl, maintenance, deploymentId: "d1", commit: COMMIT,
      origin: "http://staging.test", token: "t".repeat(32), mode: "copy-ready", runId: "run-9",
    })).rejects.toThrow(/expected-ready probe for run run-9/);
  });

  it("refuses to run at all without the canonical mode and run identity to compare against", async () => {
    await expect(waitForExpectedReady({
      ...nowait, fetchImpl: vi.fn(), maintenance, deploymentId: "d1", commit: COMMIT,
      origin: "http://staging.test", token: "t".repeat(32), mode: null, runId: null,
    })).rejects.toThrow(/canonical mode and refresh run identity/);
  });

  it("still refuses a plain 200 during INSTALL, where booting is the only correct answer", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, commit: COMMIT }, { status: 200 }));
    await expect(waitForImportedBoot({
      ...nowait, fetchImpl, maintenance, deploymentId: "d1", commit: COMMIT,
      origin: "http://staging.test", token: "t".repeat(32), mode: "copy-ready",
    })).rejects.toThrow(/boot probe/);
  });
});
