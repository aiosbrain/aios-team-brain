// The adapters' decrypt path needs a SECRETS_KEY; set one before the fake db encrypts.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { describe, expect, it, vi } from "vitest";
import { linearAdapter } from "@/lib/provisioning/linear";
import { slackAdapter } from "@/lib/provisioning/slack";
import { githubAdapter } from "@/lib/provisioning/github";
import { resolveRequestedTools, runProvisioning, ALL_TOOLS } from "@/lib/provisioning/run";
import type { ProvisioningMember } from "@/lib/provisioning/types";
import { fakeIntegrationsDb } from "./provisioning-fake-db";

function member(over: Partial<ProvisioningMember> = {}): ProvisioningMember {
  return { id: "m1", email: "invitee@example.com", displayName: "Invitee", role: "member", tier: "team", ...over };
}

// ── Linear ───────────────────────────────────────────────────────────────────
describe("linear provisioning adapter", () => {
  function linearFetch(body: unknown) {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json(body);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("sends the organizationInviteCreate mutation with tier-defaulted role + teamIds", async () => {
    const { fetchImpl, calls } = linearFetch({ data: { organizationInviteCreate: { success: true } } });
    const db = fakeIntegrationsDb([{ type: "linear", secret: "lin_key", config: { inviteTeamIds: ["T1", "T2"] } }]);

    const res = await linearAdapter.invite(db, "team-1", member({ tier: "external" }), fetchImpl);

    expect(res.status).toBe("sent");
    expect(calls[0].query).toContain("organizationInviteCreate");
    expect(calls[0].variables.input).toEqual({ email: "invitee@example.com", role: "guest", teamIds: ["T1", "T2"] });
  });

  it("defaults a team-tier member's role to user and omits teamIds when unset", async () => {
    const { fetchImpl, calls } = linearFetch({ data: { organizationInviteCreate: { success: true } } });
    const db = fakeIntegrationsDb([{ type: "linear", secret: "lin_key", config: {} }]);

    await linearAdapter.invite(db, "team-1", member({ tier: "team" }), fetchImpl);

    expect(calls[0].variables.input).toEqual({ email: "invitee@example.com", role: "user" });
  });

  it("honors an explicit config.inviteRole over the tier default", async () => {
    const { fetchImpl, calls } = linearFetch({ data: { organizationInviteCreate: { success: true } } });
    const db = fakeIntegrationsDb([{ type: "linear", secret: "lin_key", config: { inviteRole: "admin" } }]);

    await linearAdapter.invite(db, "team-1", member({ tier: "external" }), fetchImpl);

    expect((calls[0].variables.input as { role: string }).role).toBe("admin");
  });

  it("maps an already-invited GraphQL error to skipped (never throws)", async () => {
    const { fetchImpl } = linearFetch({ errors: [{ message: "That user has already been invited" }] });
    const db = fakeIntegrationsDb([{ type: "linear", secret: "lin_key", config: {} }]);

    const res = await linearAdapter.invite(db, "team-1", member(), fetchImpl);

    expect(res.status).toBe("skipped");
    expect(res.detail).toMatch(/already/i);
  });

  it('maps Linear\'s live duplicate-invite wording ("Existing invite.") to skipped', async () => {
    // Exact message observed against the real Linear API in the 2026-07-10 prod E2E —
    // it does NOT contain "already", which a plain /already/i heuristic requires.
    const { fetchImpl } = linearFetch({ errors: [{ message: "Linear GraphQL failed: Existing invite." }] });
    const db = fakeIntegrationsDb([{ type: "linear", secret: "lin_key", config: {} }]);

    const res = await linearAdapter.invite(db, "team-1", member(), fetchImpl);

    expect(res.status).toBe("skipped");
    expect(res.detail).toMatch(/existing invite/i);
  });

  it("maps any other GraphQL error to failed with the message", async () => {
    const { fetchImpl } = linearFetch({ errors: [{ message: "Rate limited" }] });
    const db = fakeIntegrationsDb([{ type: "linear", secret: "lin_key", config: {} }]);

    const res = await linearAdapter.invite(db, "team-1", member(), fetchImpl);

    expect(res.status).toBe("failed");
    expect(res.detail).toMatch(/Rate limited/);
  });

  it("skips when there is no enabled Linear integration", async () => {
    const db = fakeIntegrationsDb([]);
    const res = await linearAdapter.invite(db, "team-1", member(), vi.fn() as unknown as typeof fetch);
    expect(res.status).toBe("skipped");
  });
});

// ── GitHub ───────────────────────────────────────────────────────────────────
describe("github provisioning adapter", () => {
  it("POSTs the org invitation and maps 201 to sent", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (u: string, i?: RequestInit) => {
      url = u;
      init = i;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const db = fakeIntegrationsDb([{ type: "github", secret: "ghp_x", config: { org: "acme" } }]);

    const res = await githubAdapter.invite(db, "team-1", member(), fetchImpl);

    expect(res.status).toBe("sent");
    expect(url).toBe("https://api.github.com/orgs/acme/invitations");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "invitee@example.com", role: "direct_member" });
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_x");
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["User-Agent"]).toBeTruthy();
  });

  it("maps a 422 already-member response to skipped with GitHub's message", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { message: "Validation Failed", errors: [{ message: "A user is already a member of the organization." }] },
        { status: 422 }
      )
    ) as unknown as typeof fetch;
    const db = fakeIntegrationsDb([{ type: "github", secret: "ghp_x", config: { org: "acme" } }]);

    const res = await githubAdapter.invite(db, "team-1", member(), fetchImpl);

    expect(res.status).toBe("skipped");
    expect(res.detail).toMatch(/already a member/i);
  });

  it("maps 403 to failed with an admin:org scope hint", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    const db = fakeIntegrationsDb([{ type: "github", secret: "ghp_x", config: { org: "acme" } }]);

    const res = await githubAdapter.invite(db, "team-1", member(), fetchImpl);

    expect(res.status).toBe("failed");
    expect(res.detail).toMatch(/admin:org/);
    expect(res.detail).toMatch(/acme/);
  });

  it("skips when no org is configured", async () => {
    const db = fakeIntegrationsDb([{ type: "github", secret: "ghp_x", config: {} }]);
    const res = await githubAdapter.invite(db, "team-1", member(), vi.fn() as unknown as typeof fetch);
    expect(res.status).toBe("skipped");
    expect(res.detail).toMatch(/GitHub org/);
  });
});

// ── Slack ────────────────────────────────────────────────────────────────────
describe("slack provisioning adapter", () => {
  const noFetch = (() => {
    throw new Error("slack must not hit the network");
  }) as unknown as typeof fetch;

  it("returns link_provided with the invite link when configured", async () => {
    const db = fakeIntegrationsDb([{ type: "slack", config: { inviteLink: "https://join.slack.com/t/x/abc" } }]);
    const res = await slackAdapter.invite(db, "team-1", member(), noFetch);
    expect(res.status).toBe("link_provided");
    expect(res.inviteLink).toBe("https://join.slack.com/t/x/abc");
  });

  it("skips when no invite link is set", async () => {
    const db = fakeIntegrationsDb([{ type: "slack", config: {} }]);
    const res = await slackAdapter.invite(db, "team-1", member(), noFetch);
    expect(res.status).toBe("skipped");
  });
});

// ── run.ts tool resolution ─────────────────────────────────────────────────────
describe("resolveRequestedTools", () => {
  it("expands all / none and de-dupes a list", () => {
    expect(resolveRequestedTools("all")).toEqual(ALL_TOOLS);
    expect(resolveRequestedTools("none")).toEqual([]);
    expect(resolveRequestedTools([])).toEqual([]);
    expect(resolveRequestedTools(["linear", "linear", "slack"])).toEqual(["linear", "slack"]);
  });

  it("runProvisioning('none') returns [] without touching the db", async () => {
    const throwingDb = {
      from: () => {
        throw new Error("db must not be touched for 'none'");
      },
      rpc: async () => ({ data: null, error: null }),
    } as unknown as import("@/lib/db/types").DbClient;
    expect(await runProvisioning(throwingDb, "team-1", member(), "none")).toEqual([]);
  });
});
