import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { BASE_URL, db, issueKeyFor, keyHeaders, seedMemberEmail, seedTeam } from "./http-helpers";
import { authenticateApiKey } from "@/lib/api/auth";
import { createGovernedActionService } from "@/lib/actions/governed";

// AIO-1186 foundation: real production HTTP boundaries. Domain consumers are
// intentionally absent; enabled execution is verified through test composition
// in the real-Postgres tier, never a fixture route in the shipped application.
const submitUrl = `${BASE_URL}/api/v1/actions/submit`;
const requestFor = (projectId = randomUUID()) => ({
  contract_version: "mcp-next/1",
  type: "task.create",
  destination: { project_id: projectId },
  params: {
    operation_id: randomUUID(), title: "HTTP fixture", assignee: null,
    status: "backlog", due: null,
  },
});

async function authenticated() {
  const seed = await seedTeam();
  const { key } = await issueKeyFor(seed, "team");
  const { data: project, error } = await db().from("projects").insert({
    team_id: seed.teamId, slug: `governed-${randomUUID().slice(0, 8)}`, name: "Governed HTTP fixture",
  }).select("id").single();
  if (error || !project) throw new Error("fixture project creation failed");
  const { data: group } = await db().from("groups").select("id")
    .eq("team_id", seed.teamId).eq("slug", "everyone").single();
  if (!group) throw new Error("fixture group missing");
  const grant = await db().from("project_groups").insert({
    team_id: seed.teamId, project_id: project.id, group_id: group.id,
  });
  if (grant.error) throw new Error("fixture project grant failed");
  return { seed, projectId: project.id as string, headers: keyHeaders(key, seed.teamSlug) };
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(submitUrl, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error).toEqual({
    code, message: expect.any(String), retryable: expect.any(Boolean),
    recovery: expect.any(String),
  });
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body.error.recovery.length).toBeGreaterThan(0);
  expect(JSON.stringify(body)).not.toMatch(/key_hash|select .*from|relation .*does not exist/i);
  return body.error as { code: string; retryable: boolean };
}

// Faults affect only the explicitly required, disposable test DB. The HTTP tier
// serializes files, and each test restores its DDL before the next fixture setup.
async function withUnavailableTable(table: "api_keys" | "group_members", run: () => Promise<void>) {
  if (!process.env.DATABASE_TEST_URL) throw new Error("dedicated test DB required");
  const client = new Client({ connectionString: process.env.DATABASE_TEST_URL });
  await client.connect();
  const unavailable = `aio1186_unavailable_${table}`;
  try {
    await client.query(`ALTER TABLE public.${table} RENAME TO ${unavailable}`);
    try { await run(); }
    finally { await client.query(`ALTER TABLE public.${unavailable} RENAME TO ${table}`); }
  } finally { await client.end(); }
}

describe("governed actions production HTTP boundary", () => {
  it("requires member authentication for submit and status", async () => {
    await expectError(await post(requestFor()), 401, "unauthorized");
    await expectError(await fetch(`${BASE_URL}/api/v1/actions/${randomUUID()}`), 401, "unauthorized");
  });

  it("rejects delegated read tokens and team-header forgery", async () => {
    const { seed, headers } = await authenticated();
    await expectError(await post(requestFor(), {
      ...headers, Authorization: `Bearer aiosd_${randomUUID()}_synthetic`,
    }), 401, "unauthorized");
    await expectError(await post(requestFor(), {
      ...headers, "X-AIOS-Team": `${seed.teamSlug}-wrong`,
    }), 401, "unauthorized");
  });

  it.each(["actor", "team_id", "resource", "credentials", "access"])(
    "rejects caller-supplied %s instead of interpreting it as authority", async (field) => {
      const { headers } = await authenticated();
      await expectError(await post({ ...requestFor(), [field]: "forged" }, headers), 422, "invalid_payload");
    },
  );

  it("never dispatches legacy or unknown action types", async () => {
    const { headers } = await authenticated();
    for (const type of ["code.run", "note.create", "task.delete", "future.action"]) {
      await expectError(await post({ ...requestFor(), type }, headers), 422, "invalid_payload");
    }
  });

  it("rejects malformed JSON, invalid UTF-8, unpaired surrogates and impossible dates", async () => {
    const { headers } = await authenticated();
    await expectError(await fetch(submitUrl, { method: "POST", headers, body: "{" }), 422, "invalid_payload");
    await expectError(await fetch(submitUrl, {
      method: "POST", headers, body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    }), 422, "invalid_payload");
    for (const overrides of [{ title: "\ud800" }, { due: "2026-02-30" }]) {
      const request = requestFor();
      await expectError(await post({ ...request, params: { ...request.params, ...overrides } }, headers),
        422, "invalid_payload");
    }
  });

  it("bounds the body before parsing and never exposes internal details", async () => {
    const { headers } = await authenticated();
    const response = await fetch(submitUrl, {
      method: "POST", headers, body: JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) }),
    });
    // The wire contract uses a typed validation failure, not an unstructured HTML error.
    await expectError(response, 422, "invalid_payload");
    expect(response.headers.get("connection")).toBe("close");
    // An early rejected upload must not poison the pooled connection used by the next read.
    const healthy = await fetch(`${BASE_URL}/api/v1/me`, { headers });
    expect(healthy.status).toBe(200);
    expect((await healthy.json()).role).toBe("member");
  });

  it("preserves existing identity reads and advertises no unimplemented consumers", async () => {
    const { seed, headers } = await authenticated();
    const response = await fetch(`${BASE_URL}/api/v1/me`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ team: seed.teamId, role: "member", tier: "team", actor: expect.any(String) });
    expect(body.capabilities?.actions ?? []).toEqual([]);
    expect(body.capabilities?.task_revisions ?? false).toBe(false);
  });

  it("cannot execute a valid request through the empty production registry", async () => {
    const { headers, projectId } = await authenticated();
    const response = await post(requestFor(projectId), headers);
    expect(response.ok).toBe(false);
    const body = await response.json();
    expect(body.error.code).toBe("capability_unavailable");
    expect(body.error.retryable).toBe(false);
    expect(body.action_id).toBeUndefined();
  });

  it("shows the exact proposal only to a current administrator of its team", async () => {
    const { seed, headers, projectId } = await authenticated();
    const policy = await db().from("policies").insert({
      team_id: seed.teamId, action: "*", resource: "*", effect: "require_approval",
    });
    expect(policy.error).toBeNull();
    const auth = await authenticateApiKey(new Request(submitUrl, { headers }), {
      recordUsage: false, preserveErrors: true,
    });
    if (!auth) throw new Error("fixture authentication failed");
    const service = createGovernedActionService({ enabled: () => true, consumers: [{
      type: "task.create", async execute() { throw new Error("pending proposal must not execute"); },
    }] });
    const request = requestFor(projectId);
    request.params.title = `Private proposal ${randomUUID()}`;
    expect((await service.submit(auth, request)).status).toBe("pending_approval");
    const member = await seedMemberEmail(seed);
    const admin = await seedMemberEmail(seed);
    const foreign = await seedMemberEmail(await seedTeam());
    for (const user of [admin, foreign]) {
      expect((await db().from("members").update({ role: "admin" }).eq("id", user.memberId)).error).toBeNull();
    }
    for (const user of [member, foreign, admin]) {
      const login = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: user.password }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      if (!cookie) throw new Error("fixture login cookie missing");
      const page = await fetch(`${BASE_URL}/t/${seed.teamSlug}/admin/approvals`, { headers: { cookie } });
      const html = await page.text();
      if (user === admin) {
        expect(page.status).toBe(200);
        expect(html).toContain("Proposed changes");
        expect(html).toContain(request.params.title);
      } else expect(html).not.toContain(request.params.title);
    }
    const status = await fetch(`${BASE_URL}/api/v1/actions/${(await service.submit(auth, request)).action_id}`, { headers });
    expect(status.status).toBe(200);
    expect((await status.json()).status).toBe("pending_approval");
  });

  it("does not disclose whether an action ID is malformed or absent", async () => {
    const { headers } = await authenticated();
    const unknown = await fetch(`${BASE_URL}/api/v1/actions/${randomUUID()}`, { headers });
    const malformed = await fetch(`${BASE_URL}/api/v1/actions/not-a-uuid`, { headers });
    const first = await expectError(unknown, 404, "not_found");
    const second = await expectError(malformed, 404, "not_found");
    expect(second).toEqual(first);
  });

  it.each(["api_keys", "group_members"] as const)(
    "%s outages are retryable503 and recover without converting the operation to a denial", async (table) => {
      const { headers, projectId } = await authenticated();
      const request = requestFor(projectId);
      await withUnavailableTable(table, async () => {
        const error = await expectError(await post(request, headers), 503, "unavailable");
        expect(error.retryable).toBe(true);
      });
      // Restored authentication reaches the disabled/unimplemented capability
      // boundary using the same identity; it is not permanently rejected as bad auth.
      const recovered = await post(request, headers);
      expect(recovered.status).not.toBe(401);
      const body = await recovered.json();
      expect(body.error.code).toBe("capability_unavailable");
      const { data, error } = await db().from("approval_requests").select("id");
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
      const actions = await db().from("governed_actions").select("id");
      expect(actions.error).toBeNull();
      expect(actions.data).toHaveLength(0);
    },
  );
});
