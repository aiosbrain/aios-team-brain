import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/v1/items` maps a push that LOST A RACE — identity revision changed, project plan
 * changed, Drive plan still stale after its re-plan, or a bounded lock wait ran out (55P03) — to a
 * fixed-message `503 temporarily_unavailable`, and every other failure to a fixed generic 500. The
 * sidecar retries 429/5xx and treats other 4xx as permanent, so a 409 here would drop a push that
 * a retry would have landed. No raw exception or SQL text may reach the caller.
 */

const h = vi.hoisted(() => ({
  ingestError: null as unknown,
  attributeError: null as unknown,
  ingestCalls: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/attribution/resolve-authors", () => ({
  attributeIncomingItem: async () => {
    if (h.attributeError) throw h.attributeError;
    return { opts: {} };
  },
  connectorMemberIds: async () => new Set<string>(),
}));
vi.mock("@/lib/pm-sync", () => ({ projectChangedTasksAfterWrite: async () => {} }));
vi.mock("@/lib/ingest", () => ({
  ingestApiItem: async () => {
    h.ingestCalls++;
    if (h.ingestError) throw h.ingestError;
    return { status: "created", id: "item-1" };
  },
}));
vi.mock("@/lib/api/auth", () => ({
  authenticateApiKey: async (req: Request) =>
    req.headers.get("authorization") === "Bearer aios_key1_secret"
      ? { teamId: "team-1", memberId: "member-1", apiKeyId: "key-1", memberTier: "team", memberRole: "member" }
      : null,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {},
}));

const { POST } = await import("@/app/api/v1/items/route");
const { IdentitySnapshotChangedError } = await import("@/lib/identity/authority");
const { ProjectPlanChangedError } = await import("@/lib/projects/project-row-locks");
const { GdriveIngestStateChangedError } = await import("@/lib/ingest/gdrive-commit-locks");
const { TransactionExecutionError } = await import("@/lib/db/pg/tx-outcome");
const { IngestValidationError, TierViolationError } = await import("@/lib/api/schemas");

const SECRET_DETAIL = 'relation "items" lock on tuple (0,7) of team-1:identity-authority';

function push(overrides: Record<string, unknown> = {}, auth = "Bearer aios_key1_secret") {
  const body = "# Notes\nwe talked";
  return new Request("https://brain.example.com/api/v1/items", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      project: "chetan-workspace",
      path: "2-work/notes/2026-10-23.md",
      content_sha256: createHash("sha256").update(body).digest("hex"),
      access: "team",
      kind: "deliverable",
      frontmatter: {},
      body,
      ...overrides,
    }),
  });
}

function lockTimeout(): Error {
  return Object.assign(new Error(`canceling statement due to lock timeout: ${SECRET_DETAIL}`), { code: "55P03" });
}

async function send(req: Request) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST(req as any);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { error?: Record<string, unknown> } };
}

const RETRYABLE: Array<[string, () => unknown]> = [
  ["IdentitySnapshotChangedError", () => new IdentitySnapshotChangedError()],
  ["ProjectPlanChangedError", () => new ProjectPlanChangedError(SECRET_DETAIL)],
  ["GdriveIngestStateChangedError", () => new GdriveIngestStateChangedError(SECRET_DETAIL)],
  ["raw PostgreSQL 55P03", lockTimeout],
  [
    "55P03 wrapped by the transaction layer",
    () => new TransactionExecutionError(`statement failed: ${SECRET_DETAIL}`, { cause: lockTimeout(), code: "55P03" }),
  ],
  [
    "55P03 only on the cause",
    () => new TransactionExecutionError(`statement failed: ${SECRET_DETAIL}`, { cause: lockTimeout() }),
  ],
];

describe("POST /api/v1/items — retryable ingest conflicts", () => {
  beforeEach(() => {
    h.ingestError = null;
    h.attributeError = null;
    h.ingestCalls = 0;
  });

  it.each(RETRYABLE)("%s → fixed 503 temporarily_unavailable, attempted once", async (_name, make) => {
    h.ingestError = make();
    const { status, json, text } = await send(push());
    expect(status).toBe(503);
    expect(Object.keys(json)).toEqual(["error"]);
    expect(Object.keys(json.error!).sort()).toEqual(["code", "message", "request_id"]);
    expect(json.error).toMatchObject({
      code: "temporarily_unavailable",
      message: "ingest conflicted with a concurrent change; retry shortly",
    });
    expect(json.error!.request_id).toEqual(expect.any(String));
    expect(text).not.toContain("tuple");
    expect(text).not.toContain("identity-authority");
    expect(text).not.toContain("abandoned");
    // The route does not retry on its own: the caller's bounded retry owns that.
    expect(h.ingestCalls).toBe(1);
  });

  it("an identity snapshot change raised during attribution is also a retryable 503", async () => {
    h.attributeError = new IdentitySnapshotChangedError();
    const { status, json } = await send(push());
    expect(status).toBe(503);
    expect(json.error).toMatchObject({ code: "temporarily_unavailable" });
    expect(h.ingestCalls).toBe(0);
  });

  it("an ordinary failure is a fixed generic 500 that never echoes the exception", async () => {
    h.ingestError = Object.assign(new Error(`duplicate key value violates unique constraint: ${SECRET_DETAIL}`), {
      code: "23505",
    });
    const { status, json, text } = await send(push());
    expect(status).toBe(500);
    expect(json.error).toMatchObject({ code: "internal", message: "ingest failed" });
    expect(text).not.toContain("duplicate key");
    expect(text).not.toContain("tuple");
  });

  it("a non-Error throw is the same fixed 500", async () => {
    h.ingestError = SECRET_DETAIL;
    const { status, json, text } = await send(push());
    expect(status).toBe(500);
    expect(json.error).toMatchObject({ code: "internal", message: "ingest failed" });
    expect(text).not.toContain("tuple");
  });

  it("validation, tier and authentication statuses are unchanged", async () => {
    h.ingestError = new IngestValidationError("invalid item payload: bad row");
    expect(await send(push())).toMatchObject({
      status: 422,
      json: { error: { code: "invalid_payload", message: "invalid item payload: bad row" } },
    });

    h.ingestError = new TierViolationError("not yours");
    expect(await send(push())).toMatchObject({ status: 403, json: { error: { code: "forbidden_tier" } } });

    h.ingestError = null;
    h.ingestCalls = 0;
    expect(await send(push({ access: "private" }))).toMatchObject({
      status: 422,
      json: { error: { code: "forbidden_tier" } },
    });
    expect(await send(push({ kind: "blueprint" }))).toMatchObject({
      status: 403,
      json: { error: { code: "forbidden" } },
    });
    expect(await send(push({}, "Bearer wrong"))).toMatchObject({
      status: 401,
      json: { error: { code: "unauthorized" } },
    });
    // None of the refusals reached the writer.
    expect(h.ingestCalls).toBe(0);
  });

  it("malformed Drive execution headers keep their 403 authority refusal", async () => {
    const req = push();
    req.headers.set("x-aios-integration-id", "not-a-uuid");
    const { status, json } = await send(req);
    expect(status).toBe(403);
    expect(json.error).toMatchObject({ code: "connector_principal_required" });
    expect(h.ingestCalls).toBe(0);
  });
});
