import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createMember, deleteMember } from "@/lib/admin/members";
import { issueApiKey, revokeApiKey } from "@/lib/admin/keys";
import { issueLoginLink } from "@/lib/admin/login";
import { addAuthorAlias } from "@/lib/admin/aliases";
import { renameTeam } from "@/lib/admin/teams";
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

describe("deleteMember (real Postgres)", () => {
  it("hard delete cascades keys/aliases, SET-NULLs contributions, audits", async () => {
    const seed = await seedTeam();
    const m = await createMember(db(), seed.teamId, {
      email: "gone@x.test", displayName: "Gone", actorHandle: "gone", role: "member",
    });
    await issueApiKey(db(), seed.teamId, m.id, "k");
    await addAuthorAlias(db(), seed.teamId, m.id, "gone@x.test");
    // a code_contributions row mapped to this member
    const { data: cb } = await db().from("codebases")
      .insert({ team_id: seed.teamId, slug: "r" }).select("id").single();
    await db().from("code_contributions").insert({
      team_id: seed.teamId, codebase_id: (cb as { id: string }).id,
      author_key: "gone@x.test", author_email: "gone@x.test", member_id: m.id, day: "2026-06-10", commits: 1,
    });

    const r = await deleteMember(db(), seed.teamId, "gone@x.test", { hard: true });
    expect(r).toMatchObject({ deleted: true, mode: "hard" });

    expect((await db().from("members").select("id").eq("id", m.id).maybeSingle()).data).toBeNull();
    expect(((await db().from("member_emails").select("id").eq("member_id", m.id)).data ?? []).length).toBe(0);
    expect(((await db().from("api_keys").select("id").eq("member_id", m.id)).data ?? []).length).toBe(0);
    const { data: contrib } = await db().from("code_contributions")
      .select("member_id").eq("author_key", "gone@x.test").maybeSingle();
    expect((contrib as { member_id: string | null }).member_id).toBeNull(); // SET NULL
    const { data: audits } = await db().from("audit_log").select("action").eq("team_id", seed.teamId);
    expect(new Set((audits ?? []).map((a) => (a as { action: string }).action)).has("member.deleted")).toBe(true);
  });

  it("missing member → no-op; last active admin → refused", async () => {
    const seed = await seedTeam();
    expect(await deleteMember(db(), seed.teamId, "nobody@x.test")).toMatchObject({ deleted: false, reason: "absent" });

    const admin = await createMember(db(), seed.teamId, {
      email: "boss@x.test", displayName: "Boss", actorHandle: "boss", role: "admin",
    });
    // seedTeam's member is a 'member'; boss is the only ADMIN → refused
    expect(await deleteMember(db(), seed.teamId, "boss@x.test", { hard: true }))
      .toMatchObject({ deleted: false, reason: "last-admin" });
    expect((await db().from("members").select("id").eq("id", admin.id).maybeSingle()).data).not.toBeNull();
  });

  it("soft disable sets status=disabled and clears auth_user_id", async () => {
    const seed = await seedTeam();
    await createMember(db(), seed.teamId, {
      email: "soft@x.test", displayName: "Soft", actorHandle: "soft", role: "member",
    });
    const r = await deleteMember(db(), seed.teamId, "soft@x.test"); // soft default
    expect(r).toMatchObject({ deleted: true, mode: "soft" });
    const { data } = await db().from("members").select("status, auth_user_id").eq("email", "soft@x.test").maybeSingle();
    expect(data).toMatchObject({ status: "disabled", auth_user_id: null });
  });
});

describe("renameTeam (real Postgres)", () => {
  it("renames slug+name; idempotent; rejects bad/duplicate slug; name-only", async () => {
    const seed = await seedTeam();
    const a = await renameTeam(db(), seed.teamId, { slug: `t${Date.now().toString(36)}`, name: "AIOS" });
    expect(a.name).toBe("AIOS");

    // idempotent: same slug+name → no throw, same result
    const again = await renameTeam(db(), seed.teamId, { slug: a.slug, name: "AIOS" });
    expect(again.slug).toBe(a.slug);

    // bad slug rejected
    await expect(renameTeam(db(), seed.teamId, { slug: "Bad Slug!" })).rejects.toThrow();

    // duplicate slug rejected (create a second team with a known slug, try to take it)
    const other = await seedTeam();
    const { data: o } = await db().from("teams").select("slug").eq("id", other.teamId).single();
    await expect(renameTeam(db(), seed.teamId, { slug: (o as { slug: string }).slug })).rejects.toThrow();

    // name-only update keeps slug
    const n = await renameTeam(db(), seed.teamId, { name: "AIOS HQ" });
    expect(n).toMatchObject({ slug: a.slug, name: "AIOS HQ" });
  });
});
