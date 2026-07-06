import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/db/admin";
import { audit } from "@/lib/api/audit";

export type ApiAuth = {
  teamId: string;
  memberId: string;
  memberTier: "team" | "external";
  memberRole: "admin" | "lead" | "member";
  apiKeyId: string;
  actorHandle: string;
  displayName: string | null;
  email: string | null;
};

/**
 * Bearer key auth for the sync API. Key format: aios_<key_id>_<secret>.
 * We look up by key_id and compare sha256(secret) with timingSafeEqual.
 * Returns null on any failure (caller responds 401); failures are audited.
 */
export async function authenticateApiKey(req: Request): Promise<ApiAuth | null> {
  const header = req.headers.get("authorization") || "";
  const teamHeader = req.headers.get("x-aios-team") || "";
  const m = header.match(/^Bearer\s+aios_([A-Za-z0-9]+)_([A-Za-z0-9_-]+)$/);
  const db = adminClient();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

  const fail = async (reason: string) => {
    await audit(db, {
      team_id: null,
      actor_kind: "system",
      action: "auth.failed",
      meta: { reason, team_header: teamHeader },
      ip,
    });
    return null;
  };

  if (!m) return fail("malformed_bearer");
  const [, keyId, secret] = m;

  const { data: key } = await db
    .from("api_keys")
    .select("id, team_id, member_id, key_hash, revoked_at, members(actor_handle, tier, status, role, display_name, email), teams(slug)")
    .eq("key_id", keyId)
    .maybeSingle();

  if (!key || key.revoked_at) return fail("unknown_or_revoked_key");

  const candidate = createHash("sha256").update(secret).digest();
  const stored = Buffer.from(key.key_hash, "hex");
  if (stored.length !== candidate.length || !timingSafeEqual(stored, candidate)) {
    return fail("bad_secret");
  }

  const member = key.members as unknown as { actor_handle: string; tier: "team" | "external"; status: string; role: "admin" | "lead" | "member"; display_name: string | null; email: string | null };
  if (member?.status !== "active") return fail("member_not_active");

  const team = key.teams as unknown as { slug: string };
  // X-AIOS-Team must match the key's team (id or slug accepted).
  if (teamHeader && teamHeader !== key.team_id && teamHeader !== team?.slug) {
    return fail("team_mismatch");
  }

  // fire-and-forget last_used_at
  void db
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", key.id)
    .then(() => {});

  return {
    teamId: key.team_id,
    memberId: key.member_id,
    memberTier: member.tier,
    memberRole: member.role,
    apiKeyId: key.id,
    actorHandle: member.actor_handle,
    displayName: member.display_name,
    email: member.email,
  };
}
