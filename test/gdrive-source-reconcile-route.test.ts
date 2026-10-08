import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * AIO-1167 — `POST /api/v1/items/source-reconcile`, the wire contract a staged snapshot upload
 * depends on to make progress across runs.
 *
 * Spec.
 *   · A rate-limited request says WHEN to come back (`Retry-After`), so a connector with a run
 *     deadline can wait exactly that long or defer the rest of the upload — never guess.
 *   · A successor execution may ask what is held (`inspect`) and continue it by proof (`resume`);
 *     both are forwarded to the staging owner under the execution the request was fenced as.
 *   · Neither can be smuggled onto a request it does not belong to: `inspect` carries no members,
 *     proof or completion, and both apply only to a staged (named) snapshot.
 *
 * The staging owner and the execution fence are fakes here; what they DO with a forwarded
 * `resume`/`inspect` is `gdrive-snapshot-staging.datamechanics` (real Postgres).
 */
const h = vi.hoisted(() => {
  class GdriveSnapshotError extends Error {
    constructor(readonly code: string, message: string, readonly status: number) { super(message); }
  }
  class GdriveAuthorityError extends Error {
    constructor(readonly code: string, message: string, readonly status: number) { super(message); }
  }
  return {
    GdriveSnapshotError,
    GdriveAuthorityError,
    auth: null as null | { teamId: string; memberId: string; apiKeyId: string },
    rateLimitWithReset: vi.fn(),
    stage: vi.fn(),
    drain: vi.fn(),
    commit: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/api/auth", () => ({ authenticateApiKey: async () => h.auth }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimitWithReset: h.rateLimitWithReset }));
vi.mock("@/lib/ingest/source-reconcile", () => ({
  GDRIVE_SNAPSHOT_PAGE_LIMIT: 10_000,
  GdriveSnapshotError: h.GdriveSnapshotError,
  stageGdriveReconciliation: h.stage,
  drainGdriveCleanupObligations: h.drain,
}));
vi.mock("@/lib/integrations/gdrive-authority", () => ({
  GdriveAuthorityError: h.GdriveAuthorityError,
  withGdriveExecutionCommit: h.commit,
}));

const { POST } = await import("@/app/api/v1/items/source-reconcile/route");

const INTEGRATION = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT = "33333333-3333-5333-8333-333333333333";
const DIGEST = "a".repeat(64);

function post(snapshot?: Record<string, unknown>): Promise<Response> {
  return POST(new Request("https://brain.example.com/api/v1/items/source-reconcile", {
    method: "POST",
    headers: { Authorization: "Bearer aios_key-1_secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "gdrive", integration_id: INTEGRATION, generation: 7, fence: 3, owner: OWNER,
      removed_provider_ids: [], reason: "complete gdrive scope",
      ...(snapshot ? { snapshot } : {}),
    }),
  }) as unknown as NextRequest);
}

beforeEach(() => {
  h.auth = { teamId: "team-1", memberId: "member-1", apiKeyId: "key-1" };
  h.rateLimitWithReset.mockReset().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  h.stage.mockReset().mockResolvedValue({ candidates: 0, snapshotApplied: false, cleanupQueued: 0 });
  h.drain.mockReset().mockResolvedValue({ items: 0, episodes: 0, restored: 0, failed: 0, pending: 0 });
  // The fence passes; staging runs inside it exactly as the route arranged.
  h.commit.mockReset().mockImplementation(async (_auth, _ref, fn: () => Promise<unknown>) => fn());
});

describe("POST /api/v1/items/source-reconcile rate limit", () => {
  it.each([60, 17, 1])("answers a limited request with Retry-After %i and stages nothing", async (seconds) => {
    h.rateLimitWithReset.mockResolvedValue({ allowed: false, retryAfterSeconds: seconds });

    const response = await post({ complete: false, provider_ids: ["doc"], snapshot_id: SNAPSHOT });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(seconds));
    await expect(response.json()).resolves.toMatchObject({ error: { code: "rate_limited" } });
    expect(h.rateLimitWithReset).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), "key-1:source-reconcile:post", 30,
    );
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.stage).not.toHaveBeenCalled();
  });

  it("does not rate-limit or disclose reset guidance before authentication", async () => {
    h.auth = null;

    const response = await post({ complete: false, provider_ids: ["doc"], snapshot_id: SNAPSHOT });

    expect(response.status).toBe(401);
    expect(response.headers.has("Retry-After")).toBe(false);
    expect(h.rateLimitWithReset).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/items/source-reconcile staged snapshot continuation", () => {
  it("forwards an inspection under the fenced execution and reports what is held", async () => {
    h.stage.mockResolvedValue({ candidates: 0, snapshotApplied: false, cleanupQueued: 0, snapshotStaged: 20_000 });

    const response = await post({ complete: false, provider_ids: [], snapshot_id: SNAPSHOT, inspect: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ snapshotApplied: false, snapshotStaged: 20_000 });
    expect(h.commit).toHaveBeenCalledExactlyOnceWith(
      h.auth, { integrationId: INTEGRATION, generation: 7, fence: 3, owner: OWNER }, expect.any(Function),
    );
    expect(h.stage.mock.calls[0][2]).toMatchObject({
      connectionId: INTEGRATION,
      snapshot: {
        complete: false, providerIds: [],
        staged: { snapshotId: SNAPSHOT, generation: 7, fence: 3, inspect: true },
      },
    });
  });

  it("forwards a resume proof with the page it continues from", async () => {
    await post({
      complete: false, provider_ids: ["doc-20000"], snapshot_id: SNAPSHOT,
      resume: { members: 20_000, digest: DIGEST },
    });

    expect(h.stage.mock.calls[0][2]).toMatchObject({
      snapshot: {
        complete: false, providerIds: ["doc-20000"],
        staged: { snapshotId: SNAPSHOT, generation: 7, fence: 3, resume: { members: 20_000, digest: DIGEST } },
      },
    });
  });

  it("carries the proof on a finalizing page too", async () => {
    await post({
      complete: true, provider_ids: ["doc-20000"], snapshot_id: SNAPSHOT, total: 20_001,
      resume: { members: 20_000, digest: DIGEST },
    });

    expect(h.stage.mock.calls[0][2]).toMatchObject({
      snapshot: {
        complete: true,
        staged: { snapshotId: SNAPSHOT, total: 20_001, resume: { members: 20_000, digest: DIGEST } },
      },
    });
  });

  it("reports a refused continuation as its own retryable-from-the-start conflict", async () => {
    h.stage.mockRejectedValue(new h.GdriveSnapshotError("snapshot_resume_mismatch", "not the expected membership", 409));

    const response = await post({
      complete: false, provider_ids: ["doc-20000"], snapshot_id: SNAPSHOT,
      resume: { members: 20_000, digest: DIGEST },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "snapshot_resume_mismatch" } });
    expect(h.drain).not.toHaveBeenCalled();
  });

  it.each([
    ["an inspection that carries members", { complete: false, provider_ids: ["doc"], snapshot_id: SNAPSHOT, inspect: true }],
    ["an inspection that claims completion", { complete: true, provider_ids: [], snapshot_id: SNAPSHOT, total: 0, inspect: true }],
    ["an inspection that also carries a proof", {
      complete: false, provider_ids: [], snapshot_id: SNAPSHOT, inspect: true, resume: { members: 1, digest: DIGEST },
    }],
    ["an inspection of an unnamed snapshot", { complete: false, provider_ids: [], inspect: true }],
    ["a proof for an unnamed snapshot", { complete: true, provider_ids: ["doc"], resume: { members: 1, digest: DIGEST } }],
    ["a proof of nothing", { complete: false, provider_ids: ["doc"], snapshot_id: SNAPSHOT, resume: { members: 0, digest: DIGEST } }],
    ["a proof whose digest is not a sha256", {
      complete: false, provider_ids: ["doc"], snapshot_id: SNAPSHOT, resume: { members: 1, digest: "ABC" },
    }],
    ["a proof with an unknown field", {
      complete: false, provider_ids: ["doc"], snapshot_id: SNAPSHOT, resume: { members: 1, digest: DIGEST, fence: 9 },
    }],
  ])("rejects %s before the fence or the staging owner is reached", async (_case, snapshot) => {
    const response = await post(snapshot);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_payload" } });
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.stage).not.toHaveBeenCalled();
  });
});
