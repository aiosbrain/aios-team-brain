import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueApiKey } from "@/lib/admin/keys";
import { BASE_URL, db, keyHeaders, seedTeam, type Seed } from "./http-helpers";

// The money tests for POST /api/v1/members/invite (brain-api v1.7): auth/role gating, the tools
// vocabulary 422, and the exact snake_case wire shape on create + idempotent re-invite. Runs over a
// real socket against the prod runtime + real Postgres. Mail is unconfigured in this tier
// (magicLinkAvailable() === false) → the invite always resolves to MANUAL mode, so we assert
// password + invite_message (and login_url is absent, being a magic-link-only field).

const INVITE = `${BASE_URL}/api/v1/members/invite`;

/** Issue a key for a member of a given tier + role on the seeded team. */
async function issueKeyForRole(
  seed: Seed,
  tier: "team" | "external",
  role: "admin" | "lead" | "member"
): Promise<{ key: string }> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${role}-${tier}-${randomUUID().slice(0, 8)}@test.local`,
      display_name: `${role} ${tier}`,
      actor_handle: `${role}-${tier}-${randomUUID().slice(0, 8)}`,
      role,
      tier,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`member seed failed: ${error?.message}`);
  const { key } = await issueApiKey(db(), seed.teamId, (data as { id: string }).id, `${role} ${tier} key`);
  return { key };
}

function invitePayload(over: Record<string, unknown> = {}) {
  const suffix = randomUUID().slice(0, 8);
  return {
    email: `invitee-${suffix}@test.local`,
    display_name: "New Invitee",
    actor_handle: `invitee-${suffix}`,
    ...over,
  };
}

describe("POST /api/v1/members/invite (HTTP)", () => {
  it("rejects a missing/invalid API key with 401", async () => {
    const res = await fetch(INVITE, {
      method: "POST",
      headers: { Authorization: "Bearer nope", "Content-Type": "application/json" },
      body: JSON.stringify(invitePayload()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a team member-role key with 403 forbidden_role", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyForRole(seed, "team", "member");
    const res = await fetch(INVITE, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(invitePayload()),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_role");
  });

  it("rejects an external-tier admin key with 403 forbidden_role", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyForRole(seed, "external", "admin");
    const res = await fetch(INVITE, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(invitePayload()),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_role");
  });

  it("422s invalid_payload on an unknown tool name", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyForRole(seed, "team", "admin");
    const res = await fetch(INVITE, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(invitePayload({ tools: ["linear", "jira"] })),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_payload");
  });

  it("200s on create with the exact manual-mode wire shape (created:true, no login_url)", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyForRole(seed, "team", "admin");
    const payload = invitePayload();

    const res = await fetch(INVITE, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.member.email).toBe(payload.email);
    expect(body.member.created).toBe(true);
    expect(typeof body.member.id).toBe("string");

    // Mail is unconfigured in this tier → manual mode: password + invite_message, no login_url.
    expect(body.invite.mode).toBe("manual");
    expect(typeof body.invite.password).toBe("string");
    expect(body.invite.password.length).toBeGreaterThan(0);
    expect(typeof body.invite.invite_message).toBe("string");
    expect(body.invite.login_url).toBeUndefined();

    // Provisioning: default "all", nothing configured → three snake_case skipped rows.
    expect(Array.isArray(body.provisioning)).toBe(true);
    expect(new Set(body.provisioning.map((r: { tool: string }) => r.tool))).toEqual(
      new Set(["linear", "slack", "github"])
    );
    for (const r of body.provisioning) {
      expect(typeof r.tool).toBe("string");
      expect(typeof r.status).toBe("string");
      expect(typeof r.detail).toBe("string");
    }

    // The member landed in the DB as 'invited' under this team.
    const { data: member } = await db()
      .from("members")
      .select("status, team_id")
      .eq("id", body.member.id)
      .single();
    expect((member as { status: string }).status).toBe("invited");
  });

  it("200s idempotently on re-invite of the same email (created:false)", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyForRole(seed, "team", "admin");
    const payload = invitePayload();

    const first = await fetch(INVITE, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    expect((await first.json()).member.created).toBe(true);

    const second = await fetch(INVITE, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify({ ...payload, actor_handle: `${payload.actor_handle}-2` }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.member.created).toBe(false);
    expect(secondBody.member.email).toBe(payload.email);
  });
});
