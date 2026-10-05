import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BASE_URL, db, seedMemberEmail, seedTeam, type Seed } from "./http-helpers";

const ADMIN = "/api/internal/executor-gateway/v1/admin";
const CREDENTIAL_ID = "ICEiIyQlJicoKSorLC0uLw";

/** The nine admin operations, each with VALID path parameters for `team`. */
const adminOperations = (team: string): Array<[string, string]> => {
  const serviceId = randomUUID();
  return [
    ["GET", `${ADMIN}/${team}/approvals`],
    ["POST", `${ADMIN}/${team}/approvals/${randomUUID()}/decision`],
    ["GET", `${ADMIN}/${team}/policies`],
    ["POST", `${ADMIN}/${team}/policies`],
    ["PATCH", `${ADMIN}/${team}/policies/${randomUUID()}`],
    ["DELETE", `${ADMIN}/${team}/policies/${randomUUID()}`],
    ["GET", `${ADMIN}/${team}/service-identities/${serviceId}/credentials`],
    ["POST", `${ADMIN}/${team}/service-identities/${serviceId}/credentials`],
    ["POST", `${ADMIN}/${team}/service-identities/${serviceId}/credentials/${CREDENTIAL_ID}/revoke`],
  ];
};

const policyBody = () => ({
  subject: { type: "team" },
  tool: "github.repository.get",
  resource: "github.repository:octo/project",
  effect: "require_approval",
  priority: 5,
  enabled: true,
  correlationId: randomUUID(),
});

/** A REAL browser session: seed a member, make it `role`, sign in over the wire, keep the cookie. */
async function signIn(seed: Seed, role: "admin" | "lead" | "member") {
  const login = await seedMemberEmail(seed);
  expect((await db().from("members").update({ role }).eq("id", login.memberId)).error).toBeNull();
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: login.email, password: login.password }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("fixture login cookie missing");
  return { cookie, memberId: login.memberId };
}

async function everyoneGroupId(seed: Seed): Promise<string> {
  const { data } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").eq("is_builtin", true).single();
  if (!data) throw new Error("fixture everyone group missing");
  return (data as { id: string }).id;
}

/** The record and the membership as the server will read them. */
async function authorityState(seed: Seed, memberId: string) {
  const groupId = await everyoneGroupId(seed);
  const { data: member } = await db().from("members").select("role, tier, status").eq("id", memberId).single();
  const { data: memberships } = await db()
    .from("group_members")
    .select("member_id")
    .eq("team_id", seed.teamId)
    .eq("group_id", groupId)
    .eq("member_id", memberId);
  return { ...(member as { role: string; tier: string; status: string }), everyone: (memberships ?? []).length };
}

async function removeEveryoneMembership(seed: Seed, memberId: string) {
  const groupId = await everyoneGroupId(seed);
  const removed = await db()
    .from("group_members")
    .delete()
    .eq("team_id", seed.teamId)
    .eq("group_id", groupId)
    .eq("member_id", memberId);
  expect(removed.error).toBeNull();
}

const gatewayPolicyCount = async (seed: Seed) => {
  const { data } = await db().from("policies").select("id, action").eq("team_id", seed.teamId);
  return ((data ?? []) as { action: string }[]).filter((row) => row.action.startsWith("gateway.")).length;
};

describe.runIf(process.env.AIOS_GATEWAY_INTERNAL_ENABLED === "true")(
  "gateway approval routes while enabled (HTTP)",
  () => {
    it("requires a gateway service credential for resume", async () => {
      const response = await fetch(
        `${BASE_URL}/api/internal/executor-gateway/v1/executions/${randomUUID()}/resume-claim`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer deliberately-invalid",
            "Content-Type": "application/json",
          },
          body: "{malformed",
        },
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error.code).toBe("gateway_unauthorized");
    });

    it("requires an authenticated admin session before parsing admin requests", async () => {
      const response = await fetch(
        `${BASE_URL}/api/internal/executor-gateway/v1/admin/team/approvals/${randomUUID()}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{malformed",
        },
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error.code).toBe("gateway_unauthorized");
    });

    // AIO-1208 AC-12: all nine operations, on valid paths of a REAL team, with no session.
    it("rejects all nine admin operations anonymously with 401 before parsing a malformed body", async () => {
      const seed = await seedTeam();
      const operations = adminOperations(seed.teamSlug);
      expect(operations).toHaveLength(9);
      for (const [method, path] of operations) {
        const response = await fetch(`${BASE_URL}${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: method === "GET" ? undefined : "{malformed",
        });
        expect(response.status, `${method} ${path}`).toBe(401);
        expect(response.headers.get("cache-control"), `${method} ${path}`).toBe("no-store");
        expect((await response.json()).error.code, `${method} ${path}`).toBe("gateway_unauthorized");
        expect(response.headers.get("set-cookie"), `${method} ${path}`).toBeNull();
      }
    });

    it("refuses an unverifiable session cookie on every admin operation", async () => {
      const seed = await seedTeam();
      for (const [method, path] of adminOperations(seed.teamSlug)) {
        const response = await fetch(`${BASE_URL}${path}`, {
          method,
          headers: { "Content-Type": "application/json", cookie: "aios_session=not.a.session" },
          body: method === "GET" ? undefined : "{malformed",
        });
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    });

    // AIO-1208 AC-12 full chain: real login → real session cookie → route → gatewayAdminContext →
    // authorizeGatewayAdmin → real Postgres. Only the Everyone membership row changes between the
    // admitted request and the refused one; the legacy tier record stays 'team' throughout.
    it("admits an enrolled admin session, then refuses the same session once Everyone membership is gone", async () => {
      const seed = await seedTeam();
      const admin = await signIn(seed, "admin");
      const policies = `${BASE_URL}${ADMIN}/${seed.teamSlug}/policies`;
      expect(await authorityState(seed, admin.memberId)).toEqual({ role: "admin", tier: "team", status: "active", everyone: 1 });

      const admitted = await fetch(policies, { headers: { cookie: admin.cookie } });
      expect(admitted.status).toBe(200);
      expect(admitted.headers.get("cache-control")).toBe("no-store");
      expect(await admitted.json()).toEqual({ policies: [] });

      await removeEveryoneMembership(seed, admin.memberId);
      expect(await authorityState(seed, admin.memberId)).toEqual({ role: "admin", tier: "team", status: "active", everyone: 0 });

      const refused = await fetch(policies, { headers: { cookie: admin.cookie } });
      expect(refused.status).toBe(422);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      expect((await refused.json()).error.code).toBe("gateway_scope_not_found");

      // The refusal precedes a VALID write too: nothing is created.
      const write = await fetch(policies, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: admin.cookie },
        body: JSON.stringify(policyBody()),
      });
      expect(write.status).toBe(422);
      expect(await gatewayPolicyCount(seed)).toBe(0);
    });

    it("admits an enrolled admin whose legacy tier record is stale 'external', and can write", async () => {
      const seed = await seedTeam();
      const admin = await signIn(seed, "admin");
      expect((await db().from("members").update({ tier: "external" }).eq("id", admin.memberId)).error).toBeNull();
      expect(await authorityState(seed, admin.memberId)).toEqual({ role: "admin", tier: "external", status: "active", everyone: 1 });

      const policies = `${BASE_URL}${ADMIN}/${seed.teamSlug}/policies`;
      const read = await fetch(policies, { headers: { cookie: admin.cookie } });
      expect(read.status).toBe(200);
      const write = await fetch(policies, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: admin.cookie },
        body: JSON.stringify(policyBody()),
      });
      expect(write.status).toBe(201);
      expect(await gatewayPolicyCount(seed)).toBe(1);
    });

    it.each(["member", "lead"] as const)("refuses an enrolled %s session with 403, and 404 for a team it is not in", async (role) => {
      const seed = await seedTeam();
      const session = await signIn(seed, role);
      const own = await fetch(`${BASE_URL}${ADMIN}/${seed.teamSlug}/policies`, { headers: { cookie: session.cookie } });
      expect(own.status).toBe(403);
      expect((await own.json()).error.code).toBe("gateway_forbidden");

      const foreign = await seedTeam();
      const other = await fetch(`${BASE_URL}${ADMIN}/${foreign.teamSlug}/policies`, { headers: { cookie: session.cookie } });
      expect(other.status).toBe(404);
      expect((await other.json()).error.code).toBe("gateway_not_found");
    });
  },
);
