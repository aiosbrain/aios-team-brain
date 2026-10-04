import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * AIO-1208 AC-08/AC-10/AC-14 — every production consumer of the changed shared helper
 * `authorizeGatewayAdmin` (docs/design/aio1208-route-auth-inventory.md, "Direct consumers"):
 *
 *   1. lib/gateway/admin-http.ts:gatewayAdminContext            (the nine admin route methods)
 *   2. app/t/[team]/admin/approvals/actions.ts:decideManagedGatewayApproval
 *   3. app/t/[team]/admin/approvals/page.tsx:ApprovalsAdminPage (managed queue branch)
 *
 * Each is EXECUTED here against the ACTUAL helper. The seams are the session, the default
 * `pgClient()` transaction factory (a bound-session stand-in that serves the helper's team and
 * member reads) and the shared posture resolver. That proves consumer control flow: a refusal
 * reaches no privileged operation, and an admitted call passes the helper's authenticated ids —
 * never caller input. The AUTHORITY itself (real Everyone membership, one real connection, a real
 * bound fault) is the data-mechanics tier's claim; the wire is the enabled HTTP carrier's.
 */

type MemberRow = { id: string; team_id: string; auth_user_id: string; role: string; status: string; tier: string };

const h = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  member: null as null | Record<string, string>,
  posture: "team" as "team" | "external" | Error,
  resolveViewerPosture: vi.fn(),
  transactionError: null as Error | null,
  transactions: 0,
  bound: [] as string[],
  sessionDb: { marker: "bound-session-client" },
  decideGatewayApproval: vi.fn(),
  listGatewayApprovals: vi.fn(),
  listGatewayAdminPolicies: vi.fn(),
  createGatewayAdminPolicy: vi.fn(),
  revalidatePath: vi.fn(),
  requireTeamAdmin: vi.fn(),
  loadGovernedApprovalProposals: vi.fn(),
  pending: [] as Record<string, unknown>[],
  recent: [] as Record<string, unknown>[],
  pageReads: [] as string[],
}));

const TEAM = { id: "team-1", slug: "acme" };
const USER = { id: "auth-user-1", email: "admin@example.test" };
const MEMBER: MemberRow = {
  id: "member-1",
  team_id: TEAM.id,
  auth_user_id: USER.id,
  role: "admin",
  status: "active",
  // Deliberately disagrees with posture in the arms below: the verdict must never follow it.
  tier: "team",
};
const CTX = { teamId: TEAM.id, teamSlug: TEAM.slug, memberId: MEMBER.id };

const rows = <T>(found: T[]) => ({ rows: found, rowCount: found.length });

/** The default `pgClient()`: only a transaction-bound session may read. */
const client = {
  from(): never {
    throw new Error("authorizeGatewayAdmin must not read through the unbound client");
  },
  rpc(): never {
    throw new Error("authorizeGatewayAdmin must not call the unbound client");
  },
  async transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T> {
    h.transactions++;
    if (h.transactionError) throw h.transactionError;
    return fn({
      db: h.sessionDb,
      optionalAudit: async <R>(operation: () => Promise<R>) => operation(),
      executeSql: async (text: string, params: unknown[] = []) => {
        if (/\bfrom teams\b/.test(text)) {
          h.bound.push("teams");
          return rows(params[0] === TEAM.slug ? [{ id: TEAM.id }] : []);
        }
        if (/\bfrom members\b/.test(text)) {
          h.bound.push("members");
          const found = h.member && params[0] === h.member.team_id && params[1] === h.member.auth_user_id;
          return rows(found ? [{ ...h.member }] : []);
        }
        throw new Error("unexpected bound statement");
      },
    });
  },
};

interface PageChain extends PromiseLike<{ data: unknown; error: null }> {
  select(spec?: string): PageChain;
  eq(column: string, value: unknown): PageChain;
  in(column: string, values: unknown[]): PageChain;
  order(column: string, options?: unknown): PageChain;
  limit(count: number): PageChain;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
}
/** `serverClient()` for the approvals page: the team row and the two legacy approval queues. */
const pageDb = {
  from(table: string) {
    h.pageReads.push(table);
    let decided = false;
    const chain: PageChain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      in: () => {
        decided = true;
        return chain;
      },
      maybeSingle: async () => ({ data: table === "teams" ? { id: TEAM.id } : null, error: null }),
      then: (onfulfilled, onrejected) =>
        Promise.resolve({ data: decided ? h.recent : h.pending, error: null as null }).then(onfulfilled, onrejected),
    };
    return chain;
  },
};

vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => h.user }));
vi.mock("@/lib/access/posture", () => ({ resolveViewerPosture: h.resolveViewerPosture }));
vi.mock("@/lib/db/pg/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/pg/client")>()),
  pgClient: () => client,
}));
vi.mock("@/lib/gateway/admin-persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway/admin-persistence")>()),
  decideGatewayApproval: h.decideGatewayApproval,
  listGatewayApprovals: h.listGatewayApprovals,
  listGatewayAdminPolicies: h.listGatewayAdminPolicies,
  createGatewayAdminPolicy: h.createGatewayAdminPolicy,
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: h.requireTeamAdmin }));
vi.mock("@/lib/db/server", () => ({ serverClient: async () => pageDb }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => pageDb }));
// The legacy approval path shares the action module; none of it is reachable from the managed action.
vi.mock("@/lib/actions", () => ({ resolveApproval: vi.fn() }));
vi.mock("@/lib/actions/governed", () => ({ governedActions: { decide: vi.fn() }, GovernedError: class extends Error {} }));
vi.mock("@/lib/actions/sandbox/e2b", () => ({ createE2BSandbox: vi.fn() }));
vi.mock("@/lib/actions/governed/approval-preview", () => ({
  loadGovernedApprovalProposals: h.loadGovernedApprovalProposals,
}));
// The two client components are replaced by markers that render exactly what the page handed them.
vi.mock("@/components/admin/approvals-queue", async () => {
  const { createElement } = await import("react");
  function ApprovalsQueue(props: { teamSlug: string; pending: unknown[]; recent: unknown[] }) {
    return createElement("section", {
      "data-testid": "approvals-queue",
      "data-team": props.teamSlug,
      "data-pending": props.pending.length,
      "data-recent": props.recent.length,
    });
  }
  return { ApprovalsQueue };
});
vi.mock("@/components/admin/managed-gateway-approvals", async () => {
  const { createElement } = await import("react");
  function ManagedGatewayApprovals(props: { teamSlug: string; approvals: Array<{ approvalId: string }> }) {
    return createElement(
      "section",
      { "data-testid": "managed-gateway", "data-team": props.teamSlug },
      props.approvals.map((approval) => approval.approvalId).join(","),
    );
  }
  return { ManagedGatewayApprovals };
});

const { gatewayAdminContext } = await import("@/lib/gateway/admin-http");
const policies = await import("@/app/api/internal/executor-gateway/v1/admin/[teamSlug]/policies/route");
const { decideManagedGatewayApproval } = await import("@/app/t/[team]/admin/approvals/actions");
const { default: ApprovalsAdminPage } = await import("@/app/t/[team]/admin/approvals/page");

const privileged = () => [
  h.decideGatewayApproval,
  h.listGatewayApprovals,
  h.listGatewayAdminPolicies,
  h.createGatewayAdminPolicy,
];
const expectNoPrivilegedDispatch = () => {
  for (const operation of privileged()) expect(operation).not.toHaveBeenCalled();
};

interface Refusal {
  name: string;
  arrange(): void;
  status: number;
  code: string;
  /** Bound reads the helper performed, in order. */
  bound: string[];
  team?: string;
}

/** Every way the shared helper refuses an authenticated session, with the order it read in. */
const HELPER_REFUSALS: Refusal[] = [
  { name: "an unknown team", arrange: () => undefined, team: "no-such-team", status: 404, code: "gateway_not_found", bound: ["teams"] },
  {
    name: "a user with no membership in the team",
    arrange: () => (h.member = null),
    status: 404,
    code: "gateway_not_found",
    bound: ["teams", "members"],
  },
  {
    name: "an admin of a different team only",
    arrange: () => (h.member = { ...MEMBER, team_id: "team-2" }),
    status: 404,
    code: "gateway_not_found",
    bound: ["teams", "members"],
  },
  {
    name: "a disabled admin (no posture read)",
    arrange: () => (h.member = { ...MEMBER, status: "disabled" }),
    status: 422,
    code: "gateway_scope_not_found",
    bound: ["teams", "members"],
  },
  {
    name: "an invited admin (no posture read)",
    arrange: () => (h.member = { ...MEMBER, status: "invited" }),
    status: 422,
    code: "gateway_scope_not_found",
    bound: ["teams", "members"],
  },
  {
    name: "an active admin without Everyone membership, legacy tier 'team'",
    arrange: () => (h.posture = "external"),
    status: 422,
    code: "gateway_scope_not_found",
    bound: ["teams", "members", "posture"],
  },
  {
    name: "an active member without Everyone membership (422 precedes 403)",
    arrange: () => {
      h.member = { ...MEMBER, role: "member" };
      h.posture = "external";
    },
    status: 422,
    code: "gateway_scope_not_found",
    bound: ["teams", "members", "posture"],
  },
  {
    name: "an active member with Everyone membership",
    arrange: () => (h.member = { ...MEMBER, role: "member" }),
    status: 403,
    code: "gateway_forbidden",
    bound: ["teams", "members", "posture"],
  },
  {
    name: "an active lead with Everyone membership",
    arrange: () => (h.member = { ...MEMBER, role: "lead" }),
    status: 403,
    code: "gateway_forbidden",
    bound: ["teams", "members", "posture"],
  },
  {
    name: "a posture read failure",
    arrange: () => (h.posture = new Error("posture read failed: connection reset")),
    status: 500,
    code: "gateway_internal",
    bound: ["teams", "members", "posture"],
  },
  {
    name: "a transaction that cannot begin",
    arrange: () => (h.transactionError = new Error("BEGIN failed: pool exhausted")),
    status: 500,
    code: "gateway_internal",
    bound: [],
  },
];

beforeEach(() => {
  vi.stubEnv("AIOS_GATEWAY_INTERNAL_ENABLED", "true");
  h.user = USER;
  h.member = { ...MEMBER };
  h.posture = "team";
  h.transactionError = null;
  h.transactions = 0;
  h.bound = [];
  h.pageReads = [];
  h.pending = [
    { id: "request-1", requested_by_actor: "agent", action: "code.run", resource: "repo", context: {}, created_at: "2026-10-01T00:00:00Z" },
    { id: "request-2", requested_by_actor: "agent", action: "code.run", resource: "repo", context: {}, created_at: "2026-10-02T00:00:00Z" },
  ];
  h.recent = [{ id: "request-0", requested_by_actor: "agent", action: "code.run", resource: "repo", status: "approved" }];
  h.resolveViewerPosture.mockReset().mockImplementation(async () => {
    h.bound.push("posture");
    if (h.posture instanceof Error) throw h.posture;
    return h.posture;
  });
  h.decideGatewayApproval.mockReset().mockResolvedValue({ status: "approved" });
  h.listGatewayApprovals.mockReset().mockResolvedValue([{ approvalId: "approval-1" }, { approvalId: "approval-2" }]);
  h.listGatewayAdminPolicies.mockReset().mockResolvedValue([]);
  h.createGatewayAdminPolicy.mockReset().mockResolvedValue({ id: "policy-1" });
  h.revalidatePath.mockReset();
  h.requireTeamAdmin.mockReset().mockResolvedValue({ teamId: TEAM.id, memberId: MEMBER.id });
  h.loadGovernedApprovalProposals.mockReset().mockResolvedValue(new Map());
});
afterEach(() => vi.unstubAllEnvs());

describe("gatewayAdminContext — the actual wrapper over the actual shared helper", () => {
  const refusal = async (result: unknown) => {
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    return { status: response.status, code: JSON.parse(text).error.code as string, text };
  };

  it("refuses an absent session with 401 before opening a transaction", async () => {
    h.user = null;
    expect(await refusal(await gatewayAdminContext(TEAM.slug))).toMatchObject({ status: 401, code: "gateway_unauthorized" });
    expect(h.transactions).toBe(0);
    expect(h.resolveViewerPosture).not.toHaveBeenCalled();
  });

  it.each(HELPER_REFUSALS)("refuses $name with $status $code", async ({ arrange, team, status, code, bound }) => {
    arrange();
    const outcome = await refusal(await gatewayAdminContext(team ?? TEAM.slug));
    expect(outcome).toMatchObject({ status, code });
    expect(h.bound).toEqual(bound);
    // A fault is the fixed generic 500 — never the substrate's own words.
    expect(outcome.text).not.toMatch(/connection reset|pool exhausted|posture read failed/);
  });

  it("resolves posture on the transaction's own session client, for the resolved team and member", async () => {
    await gatewayAdminContext(TEAM.slug);
    expect(h.transactions).toBe(1);
    expect(h.bound).toEqual(["teams", "members", "posture"]);
    expect(h.resolveViewerPosture).toHaveBeenCalledExactlyOnceWith(h.sessionDb, TEAM.id, MEMBER.id);
  });

  it("admits an active admin with Everyone membership — whatever the legacy tier record says", async () => {
    await expect(gatewayAdminContext(TEAM.slug)).resolves.toEqual(CTX);
    h.member = { ...MEMBER, tier: "external" };
    await expect(gatewayAdminContext(TEAM.slug)).resolves.toEqual(CTX);
  });
});

describe("an admin route through the actual wrapper and helper", () => {
  const params = { params: Promise.resolve({ teamSlug: TEAM.slug }) };
  const url = "http://local/api/internal/executor-gateway/v1/admin/acme/policies";
  const create = () =>
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: { type: "team" },
        tool: "github.repository.get",
        resource: "github.repository:octo/project",
        effect: "require_approval",
        priority: 5,
        enabled: true,
        correlationId: "44444444-4444-4444-8444-444444444444",
      }),
    });

  it.each(HELPER_REFUSALS.filter((entry) => !entry.team))(
    "$name → $status with no privileged persistence, for a read and a write",
    async ({ arrange, status, code }) => {
      arrange();
      for (const response of [await policies.GET(new Request(url), params), await policies.POST(create(), params)]) {
        expect(response.status).toBe(status);
        expect((await response.json()).error.code).toBe(code);
      }
      expectNoPrivilegedDispatch();
    },
  );

  it("admitted control: dispatches the read and the write with the helper's context", async () => {
    expect((await policies.GET(new Request(url), params)).status).toBe(200);
    expect(h.listGatewayAdminPolicies).toHaveBeenCalledExactlyOnceWith(CTX);
    expect((await policies.POST(create(), params)).status).toBe(201);
    expect(h.createGatewayAdminPolicy).toHaveBeenCalledExactlyOnceWith(CTX, expect.objectContaining({ priority: 5 }));
  });
});

describe("decideManagedGatewayApproval — the managed approval Server Action (AC-14)", () => {
  const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
  const CORRELATION_ID = "44444444-4444-4444-8444-444444444444";
  const decide = (team = TEAM.slug) => decideManagedGatewayApproval(team, APPROVAL_ID, "approve", CORRELATION_ID);

  it.each(HELPER_REFUSALS)("$name → refuses with no decision and no revalidation", async ({ arrange, team, status, code }) => {
    arrange();
    await expect(decide(team)).resolves.toEqual({ ok: false, error: status === 500 ? "could not decide" : code });
    expect(h.decideGatewayApproval).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expectNoPrivilegedDispatch();
  });

  it("refuses an absent session without consulting the helper", async () => {
    h.user = null;
    await expect(decide()).resolves.toEqual({ ok: false, error: "admins only" });
    expect(h.transactions).toBe(0);
    expect(h.decideGatewayApproval).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("stays inert while the gateway is disabled", async () => {
    vi.stubEnv("AIOS_GATEWAY_INTERNAL_ENABLED", "");
    await expect(decide()).resolves.toEqual({ ok: false, error: "approval not found" });
    expect(h.transactions).toBe(0);
    expect(h.decideGatewayApproval).not.toHaveBeenCalled();
  });

  it("admitted control: decides with the helper's authenticated ids, then revalidates", async () => {
    await expect(decide()).resolves.toEqual({ ok: true });
    expect(h.decideGatewayApproval).toHaveBeenCalledExactlyOnceWith(CTX, APPROVAL_ID, "approve", CORRELATION_ID);
    expect(h.revalidatePath).toHaveBeenCalledExactlyOnceWith(`/t/${TEAM.slug}/admin/approvals`);
  });
});

describe("ApprovalsAdminPage — the managed queue branch (AC-14)", () => {
  /** Execute the page's server component and render what it returned. */
  const render = async (team = TEAM.slug) => {
    const element = await ApprovalsAdminPage({ params: Promise.resolve({ team }) });
    return element === null ? null : renderToStaticMarkup(element);
  };
  const expectLegacyQueuesIntact = (html: string | null) => {
    expect(html).toContain('data-testid="approvals-queue"');
    expect(html).toContain(`data-team="${TEAM.slug}"`);
    expect(html).toContain('data-pending="2"');
    expect(html).toContain('data-recent="1"');
  };

  it.each(HELPER_REFUSALS.filter((entry) => !entry.team))(
    "$name → renders no managed panel and lists no managed approvals",
    async ({ arrange }) => {
      arrange();
      const html = await render();
      expect(html).not.toContain("managed-gateway");
      expect(h.listGatewayApprovals).not.toHaveBeenCalled();
      expectNoPrivilegedDispatch();
      expectLegacyQueuesIntact(html);
    },
  );

  it("renders no managed panel without a session, and never consults the helper", async () => {
    h.user = null;
    const html = await render();
    expect(html).not.toContain("managed-gateway");
    expect(h.transactions).toBe(0);
    expect(h.listGatewayApprovals).not.toHaveBeenCalled();
    expectLegacyQueuesIntact(html);
  });

  it("renders no managed panel while the gateway is disabled", async () => {
    vi.stubEnv("AIOS_GATEWAY_INTERNAL_ENABLED", "");
    const html = await render();
    expect(html).not.toContain("managed-gateway");
    expect(h.transactions).toBe(0);
    expect(h.listGatewayApprovals).not.toHaveBeenCalled();
    expectLegacyQueuesIntact(html);
  });

  it("admitted control: lists with the helper's context and renders the managed panel", async () => {
    const html = await render();
    expect(h.listGatewayApprovals).toHaveBeenCalledExactlyOnceWith(CTX);
    expect(html).toContain('<section data-testid="managed-gateway" data-team="acme">approval-1,approval-2</section>');
    expectLegacyQueuesIntact(html);
  });

  it("returns nothing at all when the page's own admin gate refuses", async () => {
    h.requireTeamAdmin.mockResolvedValue(null);
    await expect(render()).resolves.toBeNull();
    expect(h.pageReads).toEqual([]);
    expect(h.transactions).toBe(0);
    expectNoPrivilegedDispatch();
  });
});
