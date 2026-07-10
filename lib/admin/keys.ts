import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import type { ActorContext } from "./members";

/**
 * Shared admin primitive: issue / revoke API keys. The secret is generated here
 * and only its sha256 is stored (key_hash); the raw `aios_<id>_<secret>` is
 * returned ONCE and never persisted. Service-role client; caller does authz.
 */
export async function issueApiKey(
  admin: DbClient,
  teamId: string,
  memberId: string,
  name: string,
  opts: { actor?: ActorContext } = {}
): Promise<{ key: string; keyId: string }> {
  const keyId = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const { error } = await admin.from("api_keys").insert({
    team_id: teamId,
    member_id: memberId,
    key_id: keyId,
    key_hash: createHash("sha256").update(secret).digest("hex"),
    name: name.trim() || "unnamed key",
  });
  if (error) throw new Error(`issue key failed: ${error.message}`);

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "api_key.issued",
    target_type: "api_key",
    target_id: keyId,
    meta: { for_member: memberId },
  });
  return { key: `aios_${keyId}_${secret}`, keyId };
}

export async function revokeApiKey(
  admin: DbClient,
  teamId: string,
  apiKeyId: string,
  opts: { actor?: ActorContext } = {}
): Promise<void> {
  const { error } = await admin
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", apiKeyId)
    .eq("team_id", teamId);
  if (error) throw new Error(`revoke key failed: ${error.message}`);

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "api_key.revoked",
    target_type: "api_key",
    target_id: apiKeyId,
  });
}

/**
 * Self-serve variant of revokeApiKey: a member may revoke ONLY their own key. Unlike
 * revokeApiKey (which trusts the caller's authz check and only scopes by team), this
 * primitive re-derives ownership from the DB itself, so the ownership check can never be
 * skipped by a caller that forgets to gate it — same "single writer, one legal path"
 * shape as createTeam/createMember. Returns `{ revoked: false }` (no-op, not an error) if
 * the key is absent, already revoked, or owned by someone else; throws on a genuine DB
 * failure so a caller never mistakes "the lookup broke" for "not allowed."
 */
export async function revokeOwnApiKey(
  admin: DbClient,
  teamId: string,
  memberId: string,
  apiKeyId: string,
  opts: { actor?: ActorContext } = {}
): Promise<{ revoked: boolean }> {
  const { data: row, error } = await admin
    .from("api_keys")
    .select("member_id, revoked_at")
    .eq("id", apiKeyId)
    .eq("team_id", teamId)
    .maybeSingle();
  if (error) throw new Error(`revoke key lookup failed: ${error.message}`);
  const r = row as { member_id: string; revoked_at: string | null } | null;
  if (!r || r.member_id !== memberId || r.revoked_at) return { revoked: false };

  await revokeApiKey(admin, teamId, apiKeyId, opts);
  return { revoked: true };
}
