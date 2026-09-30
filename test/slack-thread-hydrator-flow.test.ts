import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  claimDueSlackThread: vi.fn(), readSlackThreadSnapshot: vi.fn(), restartSlackThreadSnapshot: vi.fn(),
  writeSlackThreadSnapshot: vi.fn(), checkpointSlackThread: vi.fn(), releaseSlackThreadForRetry: vi.fn(),
  slackReservedRequest: vi.fn(), runContextTransaction: vi.fn(),
}));
vi.mock("@/lib/ingest/slack-thread-state", () => stubs);
vi.mock("@/lib/ingest/sources/slack-page-request", () => ({ slackReservedRequest: stubs.slackReservedRequest }));
vi.mock("@/lib/projects/context/transaction", () => ({ runContextTransaction: stubs.runContextTransaction }));

import { hydrateOneSlackThread } from "@/lib/ingest/slack-thread-hydrator";

const TEAM = "3f1a0b2c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ROOT = "1718900000.000100";
const claim = { scope: { teamId: TEAM, workspaceId: "T0UNIT001", channelId: "C0UNIT001", rootTs: ROOT },
  leaseOwner: "owner", leaseGeneration: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  attempts: 1, pageCursor: null, snapshotGeneration: 0 };
const input = { db: {} as never, teamId: TEAM, token: "synthetic-test-token",
  methodScope: { kind: "verified" as const, teamId: TEAM, workspaceId: "T0UNIT001", appId: "A0UNIT001" } };

beforeEach(() => {
  Object.values(stubs).forEach((stub) => stub.mockReset());
  stubs.claimDueSlackThread.mockResolvedValue(claim);
  stubs.writeSlackThreadSnapshot.mockResolvedValue("written");
  stubs.checkpointSlackThread.mockResolvedValue({ outcome: "checkpointed" });
  stubs.releaseSlackThreadForRetry.mockResolvedValue({ outcome: "released" });
  stubs.runContextTransaction.mockImplementation(async (_db, work) => work({}));
});

describe("inactive hydration failure decisions", () => {
  it("rejects its transaction when the snapshot writes but the checkpoint refuses", async () => {
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "ok", page: {
      messages: [{ ts: ROOT, text: "root" }], hasMore: true, nextCursor: "page-2" } });
    stubs.checkpointSlackThread.mockResolvedValue({ outcome: "refused" });
    let completedTransactions = 0;
    let inTransaction = false;
    stubs.runContextTransaction.mockImplementation(async (_db, work) => {
      inTransaction = true;
      try { const result = await work({}); completedTransactions += 1; return result; }
      finally { inTransaction = false; }
    });
    stubs.slackReservedRequest.mockImplementation(async () => {
      expect(inTransaction).toBe(false);
      return { outcome: "ok", page: { messages: [{ ts: ROOT, text: "root" }], hasMore: true, nextCursor: "page-2" } };
    });
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "refused", category: "stale_lease" });
    expect(stubs.writeSlackThreadSnapshot).toHaveBeenCalledTimes(1);
    expect(stubs.checkpointSlackThread).toHaveBeenCalledTimes(1);
    expect(completedTransactions).toBe(1); // claim committed; page transaction threw and rolled back
  });

  it("requeues, rather than throwing, when the database measures the snapshot over the cap", async () => {
    // AIO-1170 review P3-01: the DB bound is octet_length(messages::text), larger than the JSON.stringify count
    // the hydrator pre-checks, so the write itself can report `too_large` for a thread that passed the pre-check.
    // Uncaught, that reached the caller as a raw 23514 with the lease left to expire and every reclaim repeating it.
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "ok", page: {
      messages: [{ ts: ROOT, text: "root" }], hasMore: false, nextCursor: null } });
    stubs.writeSlackThreadSnapshot.mockResolvedValue("too_large");
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "failed", category: "snapshot_too_large" });
    expect(stubs.checkpointSlackThread).not.toHaveBeenCalled();
    expect(stubs.releaseSlackThreadForRetry.mock.calls[0][2].errorCode).toBe("snapshot_too_large");
  });

  it("resets a cursor with no matching staged body before refetching the root", async () => {
    const resumed = { ...claim, pageCursor: "page-2", snapshotGeneration: 1 };
    const restarted = { ...resumed, pageCursor: null, snapshotGeneration: 2 };
    stubs.claimDueSlackThread.mockResolvedValue(resumed);
    stubs.readSlackThreadSnapshot.mockResolvedValue(null);
    stubs.restartSlackThreadSnapshot.mockResolvedValue(restarted);
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "ok", page: {
      messages: [{ ts: ROOT }], hasMore: false, nextCursor: null } });
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "progressed" });
    expect(stubs.restartSlackThreadSnapshot).toHaveBeenCalledWith(expect.anything(), resumed);
    expect(stubs.slackReservedRequest.mock.calls[0][2]).toEqual({ channel: claim.scope.channelId, ts: ROOT });
    expect(stubs.writeSlackThreadSnapshot.mock.calls[0][1]).toEqual(restarted);
    expect(stubs.checkpointSlackThread.mock.calls[0][2].snapshotGeneration).toBe(3);
  });

  it("uses the provider deadline to release a deferred claim and keeps HTTP untouched", async () => {
    const deadline = new Date(Date.now() + 120_000).toISOString();
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "deferred", nextPermittedAt: deadline });
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "deferred", category: "deferred" });
    expect(stubs.writeSlackThreadSnapshot).not.toHaveBeenCalled();
    const release = stubs.releaseSlackThreadForRetry.mock.calls[0][2];
    expect(release.errorCode).toBe("deferred");
    expect(release.nextDueAt.getTime()).toBeGreaterThanOrEqual(new Date(deadline).getTime());
  });

  it("backs off auth refusal and does not stage an empty success", async () => {
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "auth_error", category: "invalid_auth" });
    const before = Date.now();
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "failed", category: "auth_error" });
    expect(stubs.writeSlackThreadSnapshot).not.toHaveBeenCalled();
    const release = stubs.releaseSlackThreadForRetry.mock.calls[0][2];
    expect(release.nextDueAt.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60_000);
  });

  it("invalidates a rejected provider cursor before queuing a fresh first page", async () => {
    const resumed = { ...claim, pageCursor: "bad-cursor", snapshotGeneration: 1 };
    const restarted = { ...resumed, pageCursor: null, snapshotGeneration: 2 };
    stubs.claimDueSlackThread.mockResolvedValue(resumed);
    stubs.readSlackThreadSnapshot.mockResolvedValue({ messages: [{ ts: ROOT }], seenCursors: ["bad-cursor"], complete: false });
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "provider_error", category: "invalid_cursor" });
    stubs.restartSlackThreadSnapshot.mockResolvedValue(restarted);
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "failed", category: "invalid_cursor" });
    expect(stubs.restartSlackThreadSnapshot).toHaveBeenCalledWith(expect.anything(), resumed);
    expect(stubs.releaseSlackThreadForRetry.mock.calls[0][1]).toEqual(restarted);
    expect(stubs.writeSlackThreadSnapshot).not.toHaveBeenCalled();
  });

  it("selects due work only in the verified workspace before any HTTP", async () => {
    const mismatched = { ...input, methodScope: { ...input.methodScope, workspaceId: "T0OTHER" } };
    stubs.claimDueSlackThread.mockResolvedValue(null);
    expect(await hydrateOneSlackThread(mismatched)).toEqual({ outcome: "idle" });
    expect(stubs.claimDueSlackThread.mock.calls[0][2]).toMatchObject({ workspaceId: "T0OTHER" });
    expect(stubs.slackReservedRequest).not.toHaveBeenCalled();
    expect(stubs.releaseSlackThreadForRetry).not.toHaveBeenCalled();
  });
});
