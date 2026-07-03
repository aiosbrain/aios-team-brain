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
