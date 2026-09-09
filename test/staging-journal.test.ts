import { describe, expect, it, vi } from "vitest";
import { acquireCoordinatorLock, acquireDataUseLock, transitionJournal, markReady, JOURNAL_STATES } from "../scripts/staging-ops/journal.mjs";

describe("durable refresh journal and session locks", () => {
  it("uses distinct session advisory locks and never treats elapsed time as ownership", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ acquired: true }] });
    await acquireCoordinatorLock({ query });
    await acquireDataUseLock({ query }, "exclusive");
    expect(query.mock.calls[0][0]).toContain("pg_try_advisory_lock");
    expect(query.mock.calls[1][0]).toContain("pg_try_advisory_lock");
    expect(query.mock.calls[0][1]).not.toEqual(query.mock.calls[1][1]);
    expect(JSON.stringify(JOURNAL_STATES)).not.toContain("expired");
  });

  it("uses compare-state updates and cannot declare ready from importing", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(transitionJournal({ query }, { runId: "r", from: ["ready"], to: "draining", patch: { candidateMode: "copy-ready" } })).rejects.toThrow(/refused/);
    expect(query.mock.calls[0][0]).toContain("candidate_mode");
    expect(query.mock.calls[0][1][6]).toBe("copy-ready");
    await expect(markReady({ query }, { runId: "r", objectId: "r--" + "b".repeat(64), digest: "b".repeat(64), commit: "a".repeat(40), mode: "copy-ready" })).rejects.toThrow(/before successful boot/);
  });
});
