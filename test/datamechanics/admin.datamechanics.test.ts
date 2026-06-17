import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createMember } from "@/lib/admin/members";
import { issueApiKey, revokeApiKey } from "@/lib/admin/keys";
import { issueLoginLink } from "@/lib/admin/login";
import { db, seedTeam } from "./helpers";

// Admin primitives against real Postgres: the CLI is a thin dispatcher over these,
// so this is the meaningful smoke test. Asserts credential hashing (raw secret never
// stored), idempotent upsert, invite-only login links, and audit-log writes.

describe("admin primitives (real Postgres)", () => {
  it("create-member: inserts; upsert is idempotent + audited", async () => {
    const seed = await seedTeam();
    const a = await createMember(db(), seed.teamId, {
      email: "NewAdmin@x.test",
      displayName: "New Admin",
      actorHandle: "newadmin",
      role: "admin",
    });
    expect(a.status).toBe("invited");

    const b = await createMember(
      db(),
      seed.teamId,
      { email: "newadmin@x.test", displayName: "Renamed", actorHandle: "newadmin", role: "admin" },
      { upsert: true }
    );
    expect(b.id).toBe(a.id); // same member (email is citext-unique per team)

    const { data: rows } = await db()
      .from("members")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("email", "newadmin@x.test");
    expect((rows ?? []).length).toBe(1);
  });

  it("issue-key: returns aios_<id>_<secret>; stores only sha256(secret); revoke works", async () => {
    const seed = await seedTeam();
    const { key, keyId } = await issueApiKey(db(), seed.teamId, seed.memberId, "test key");
    expect(key.startsWith(`aios_${keyId}_`)).toBe(true);

    const secret = key.split("_").slice(2).join("_");
    const { data: row } = await db()
      .from("api_keys")
      .select("id, key_hash")
      .eq("key_id", keyId)
      .maybeSingle();
    const stored = row as { id: string; key_hash: string };
    // crown jewel: only the hash is persisted, never the raw secret
    expect(stored.key_hash).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(stored.key_hash).not.toContain(secret);

    await revokeApiKey(db(), seed.teamId, stored.id);
    const { data: after } = await db()
      .from("api_keys")
      .select("revoked_at")
      .eq("id", stored.id)
      .maybeSingle();
    expect((after as { revoked_at: string | null }).revoked_at).not.toBeNull();
  });

  it("login-link: mints a token for a member (hash stored), null for a non-member", async () => {
    const seed = await seedTeam();
    await createMember(db(), seed.teamId, {
      email: "loginme@x.test",
      displayName: "Login Me",
      actorHandle: "loginme",
      role: "member",
    });
    const ok = await issueLoginLink(db(), seed.teamId, "loginme@x.test", {
      baseUrl: "https://brain.test",
      nextPath: `/t/${seed.teamSlug}`,
      ttlMinutes: 60,
    });
    expect(ok.token).toBeTruthy();
    expect(ok.url).toContain("/auth/confirm?token=");
    const { data: tok } = await db()
      .from("auth_tokens")
      .select("token_hash")
      .eq("email", "loginme@x.test")
      .maybeSingle();
    expect((tok as { token_hash: string }).token_hash).toBe(
      createHash("sha256").update(ok.token as string).digest("hex")
    );

    // invite-only: unknown email yields no token
    const none = await issueLoginLink(db(), seed.teamId, "stranger@x.test", {});
    expect(none.token).toBeNull();
  });

  it("writes audit rows for member/key/login operations", async () => {
    const seed = await seedTeam();
    const m = await createMember(db(), seed.teamId, {
      email: "audit@x.test",
      displayName: "Audit",
      actorHandle: "audit",
      role: "member",
    });
    const { keyId } = await issueApiKey(db(), seed.teamId, m.id, "k");
    void keyId;
    await issueLoginLink(db(), seed.teamId, "audit@x.test", {});

    const { data: audits } = await db()
      .from("audit_log")
      .select("action")
      .eq("team_id", seed.teamId);
    const actions = new Set((audits ?? []).map((a) => (a as { action: string }).action));
    expect(actions.has("member.created")).toBe(true);
    expect(actions.has("api_key.issued")).toBe(true);
    expect(actions.has("login_link.issued")).toBe(true);
  });
});
