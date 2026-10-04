import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayError } from "@/lib/gateway/http";
import { parseGatewayPolicyInput } from "@/lib/gateway/admin-validation";

// AIO-1208 AC-08: the nine managed-gateway admin operations, driven through their ACTUAL route
// handlers with the gateway enabled. For each one: a guard refusal is returned unchanged and
// reaches NO privileged persistence owner — for every refusal status the guard can produce — and
// an approved context dispatches exactly that operation's owner. Requests carry valid path
// parameters and valid bodies, so a parser or path refusal can never stand in for the guard.
// The guard's own authority is proved in gateway-admin-consumers.test.ts (actual wrapper), the
// real-Postgres gateway-approval tier (AC-09/10) and the enabled wire carrier (AC-12).

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  owners: {
    listGatewayApprovals: vi.fn(),
    decideGatewayApproval: vi.fn(),
    listGatewayAdminPolicies: vi.fn(),
    createGatewayAdminPolicy: vi.fn(),
    updateGatewayAdminPolicy: vi.fn(),
    deleteGatewayAdminPolicy: vi.fn(),
    listGatewayCredentials: vi.fn(),
    rotateGatewayCredential: vi.fn(),
    revokeGatewayCredential: vi.fn(),
  },
}));

vi.mock("@/lib/gateway/admin-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway/admin-http")>()),
  gatewayAdminContext: h.gate,
}));
vi.mock("@/lib/gateway/admin-persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway/admin-persistence")>()),
  ...h.owners,
}));

const approvals = await import("@/app/api/internal/executor-gateway/v1/admin/[teamSlug]/approvals/route");
const decision = await import(
  "@/app/api/internal/executor-gateway/v1/admin/[teamSlug]/approvals/[approvalId]/decision/route"
);
const policies = await import("@/app/api/internal/executor-gateway/v1/admin/[teamSlug]/policies/route");
const policy = await import("@/app/api/internal/executor-gateway/v1/admin/[teamSlug]/policies/[policyId]/route");
const credentials = await import(
  "@/app/api/internal/executor-gateway/v1/admin/[teamSlug]/service-identities/[serviceIdentityId]/credentials/route"
);
const revoke = await import(
  "@/app/api/internal/executor-gateway/v1/admin/[teamSlug]/service-identities/[serviceIdentityId]/credentials/[credentialId]/revoke/route"
);

type Owner = keyof typeof h.owners;
const TEAM = "acme";
const CTX = { teamId: "team-1", teamSlug: TEAM, memberId: "member-1" };
const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const POLICY_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "33333333-3333-4333-8333-333333333333";
const CORRELATION_ID = "44444444-4444-4444-8444-444444444444";
const CREDENTIAL_ID = "ICEiIyQlJicoKSorLC0uLw";
const NEW_CREDENTIAL_ID = "MDEyMzQ1Njc4OTo7PD0-Pw";
const SECRET = "c".repeat(43);

const policyBody = {
  subject: { type: "team" },
  tool: "github.repository.get",
  resource: "github.repository:octo/project",
  effect: "require_approval",
  priority: 5,
  enabled: true,
  correlationId: CORRELATION_ID,
};
const rotation = {
  credentialId: NEW_CREDENTIAL_ID,
  secret: SECRET,
  replacesCredentialId: CREDENTIAL_ID,
  correlationId: CORRELATION_ID,
};

const url = "http://local/api/internal/executor-gateway/v1/admin";
const read = () => new Request(url);
const write = (method: string, body: unknown) =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve({ teamSlug: TEAM, ...value }) });

interface Operation {
  name: string;
  owner: Owner;
  /** Arguments the owner must receive after the authenticated context. */
  args: unknown[];
  invoke(body?: string): Promise<Response>;
}

const OPERATIONS: Operation[] = [
  { name: "GET approvals", owner: "listGatewayApprovals", args: [], invoke: () => approvals.GET(read(), params({})) },
  {
    name: "POST approvals/:id/decision",
    owner: "decideGatewayApproval",
    args: [APPROVAL_ID, "approve", CORRELATION_ID],
    invoke: (body) =>
      decision.POST(
        write("POST", body ?? { decision: "approve", correlationId: CORRELATION_ID }),
        params({ approvalId: APPROVAL_ID }),
      ),
  },
  { name: "GET policies", owner: "listGatewayAdminPolicies", args: [], invoke: () => policies.GET(read(), params({})) },
  {
    name: "POST policies",
    owner: "createGatewayAdminPolicy",
    args: [parseGatewayPolicyInput(policyBody)],
    invoke: (body) => policies.POST(write("POST", body ?? policyBody), params({})),
  },
  {
    name: "PATCH policies/:id",
    owner: "updateGatewayAdminPolicy",
    args: [POLICY_ID, parseGatewayPolicyInput(policyBody)],
    invoke: (body) => policy.PATCH(write("PATCH", body ?? policyBody), params({ policyId: POLICY_ID })),
  },
  {
    name: "DELETE policies/:id",
    owner: "deleteGatewayAdminPolicy",
    args: [POLICY_ID, CORRELATION_ID],
    invoke: (body) =>
      policy.DELETE(write("DELETE", body ?? { correlationId: CORRELATION_ID }), params({ policyId: POLICY_ID })),
  },
  {
    name: "GET service-identities/:id/credentials",
    owner: "listGatewayCredentials",
    args: [SERVICE_ID],
    invoke: () => credentials.GET(read(), params({ serviceIdentityId: SERVICE_ID })),
  },
  {
    name: "POST service-identities/:id/credentials",
    owner: "rotateGatewayCredential",
    args: [SERVICE_ID, rotation],
    invoke: (body) => credentials.POST(write("POST", body ?? rotation), params({ serviceIdentityId: SERVICE_ID })),
  },
  {
    name: "POST service-identities/:id/credentials/:credentialId/revoke",
    owner: "revokeGatewayCredential",
    args: [SERVICE_ID, CREDENTIAL_ID, CORRELATION_ID],
    invoke: (body) =>
      revoke.POST(
        write("POST", body ?? { correlationId: CORRELATION_ID }),
        params({ serviceIdentityId: SERVICE_ID, credentialId: CREDENTIAL_ID }),
      ),
  },
];
const WRITES = OPERATIONS.filter((operation) => !operation.name.startsWith("GET"));

const REFUSALS: Array<[number, string]> = [
  [401, "gateway_unauthorized"],
  [403, "gateway_forbidden"],
  [404, "gateway_not_found"],
  [422, "gateway_scope_not_found"],
  [500, "gateway_internal"],
];

const expectNoDispatch = () => {
  for (const [name, owner] of Object.entries(h.owners)) expect(owner, name).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.stubEnv("AIOS_GATEWAY_INTERNAL_ENABLED", "true");
  h.gate.mockReset().mockResolvedValue(CTX);
  for (const owner of Object.values(h.owners)) owner.mockReset().mockResolvedValue({});
  h.owners.listGatewayApprovals.mockResolvedValue([]);
  h.owners.listGatewayAdminPolicies.mockResolvedValue([]);
  h.owners.listGatewayCredentials.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("the nine enabled gateway admin operations", () => {
  it("covers exactly nine operations, each with its own persistence owner", () => {
    expect(OPERATIONS).toHaveLength(9);
    expect(new Set(OPERATIONS.map((operation) => operation.owner)).size).toBe(9);
    expect(OPERATIONS.map((operation) => operation.owner).sort()).toEqual(Object.keys(h.owners).sort());
  });

  describe.each(REFUSALS)("guard refusal %i %s", (status, code) => {
    it.each(OPERATIONS)("$name returns it unchanged and dispatches nothing", async ({ invoke }) => {
      const refusal = gatewayError(code, status);
      h.gate.mockResolvedValue(refusal);
      const response = await invoke();
      expect(response).toBe(refusal);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error.code).toBe(code);
      expect(h.gate).toHaveBeenCalledExactlyOnceWith(TEAM);
      expectNoDispatch();
    });
  });

  it.each(WRITES)("$name refuses before parsing a malformed body", async ({ invoke }) => {
    const refusal = gatewayError("gateway_unauthorized", 401);
    h.gate.mockResolvedValue(refusal);
    const response = await invoke("{malformed");
    expect(response).toBe(refusal);
    expectNoDispatch();
    // Control: with an approved context the same malformed body IS the parser's 400.
    h.gate.mockResolvedValue(CTX);
    expect((await invoke("{malformed")).status).toBe(400);
    expectNoDispatch();
  });

  it.each(OPERATIONS)("$name dispatches only its own owner, with the authenticated context", async ({ invoke, owner, args }) => {
    const response = await invoke();
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(h.gate).toHaveBeenCalledExactlyOnceWith(TEAM);
    expect(h.owners[owner]).toHaveBeenCalledExactlyOnceWith(CTX, ...args);
    for (const [name, other] of Object.entries(h.owners)) {
      if (name !== owner) expect(other, name).not.toHaveBeenCalled();
    }
  });
});

describe("the nine gateway admin operations while disabled", () => {
  it.each(["", "TRUE", "1", "false"])("stay an inert 404 before the guard when the flag is %j", async (flag) => {
    vi.stubEnv("AIOS_GATEWAY_INTERNAL_ENABLED", flag);
    for (const operation of OPERATIONS) {
      const response = await operation.invoke();
      expect(response.status, operation.name).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error.code).toBe("gateway_not_found");
    }
    expect(h.gate).not.toHaveBeenCalled();
    expectNoDispatch();
  });
});
