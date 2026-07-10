import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { encryptSecret, decryptSecret } from "@/lib/secrets/crypto";

/**
 * The single writer/reader for `member_secrets` — a member's own encrypted secret (e.g. their
 * Slack USER token for "act as me"). Mirrors lib/integrations/manage.ts but PER-MEMBER:
 *  - team `integrations.secret_ciphertext` = team-scoped bot/read tokens (the team connector);
 *  - `member_secrets` = per-member write-capable tokens, owned by ONE member.
 * The plaintext is encrypted at rest (AES-256-GCM, lib/secrets/crypto.ts), decrypted only here +
 * the owner-authed endpoint, and NEVER logged (audit records keys/flags only).
 */

export interface MemberAuth {
  teamId: string;
  memberId: string;
}

export interface MemberSecret {
  secret: string;
  meta: Record<string, unknown>;
  updatedAt: string;
}

/** Upsert a member's secret for a provider (encrypts at rest; audits keys/flags only). */
export async function setMemberSecret(
  db: DbClient,
  auth: MemberAuth,
  provider: string,
  secret: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  const p = provider.trim().toLowerCase();
  if (!p) throw new Error("provider is required");
  if (!secret) throw new Error("secret is required");
  const { error } = await db
    .from("member_secrets")
    .upsert(
      {
        team_id: auth.teamId,
        member_id: auth.memberId,
        provider: p,
        secret_ciphertext: encryptSecret(secret),
        meta,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "team_id,member_id,provider" }
    );
  if (error) throw new Error(`member secret upsert failed: ${error.message}`);
  await audit(db, {
    team_id: auth.teamId,
    actor_kind: "member",
    member_id: auth.memberId,
    action: "member_secret.set",
    target_type: "member_secret",
    target_id: p,
    meta: { provider: p, secretSet: true, ...(meta.acquired_via ? { acquired_via: meta.acquired_via } : {}) }, // never the value
  });
}

/** Read + decrypt a member's secret, or null if not connected. Server-only. */
export async function getMemberSecret(
  db: DbClient,
  teamId: string,
  memberId: string,
  provider: string
): Promise<MemberSecret | null> {
  const p = provider.trim().toLowerCase();
  const { data, error } = await db
    .from("member_secrets")
    .select("secret_ciphertext, meta, updated_at")
    .eq("team_id", teamId)
    .eq("member_id", memberId)
    .eq("provider", p)
    .maybeSingle();
  if (error) throw new Error(`member secret read failed: ${error.message}`);
  if (!data) return null;
  return {
    secret: decryptSecret(data.secret_ciphertext as string),
    meta: (data.meta as Record<string, unknown>) ?? {},
    updatedAt: data.updated_at as string,
  };
}

/** Delete a member's secret for a provider (disconnect). Audited. */
export async function deleteMemberSecret(
  db: DbClient,
  auth: MemberAuth,
  provider: string
): Promise<void> {
  const p = provider.trim().toLowerCase();
  const { error } = await db
    .from("member_secrets")
    .delete()
    .eq("team_id", auth.teamId)
    .eq("member_id", auth.memberId)
    .eq("provider", p);
  if (error) throw new Error(`member secret delete failed: ${error.message}`);
  await audit(db, {
    team_id: auth.teamId,
    actor_kind: "member",
    member_id: auth.memberId,
    action: "member_secret.deleted",
    target_type: "member_secret",
    target_id: p,
    meta: { provider: p },
  });
}
