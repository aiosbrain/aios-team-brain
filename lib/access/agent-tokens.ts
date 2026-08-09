import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { isPrincipal } from "@/lib/access/eligibility";

/**
 * Delegated agent tokens (spec §10) — the SINGLE writer for `agent_tokens` (guarded by
 * test/guards/access-single-writer.test.ts). Wire format `aiosd_<token_id>_<secret>`, hashed
 * secret, api_keys discipline. The token stores WHO (launcher + optional acting-as) and the
 * attenuation set; it never stores a visibility snapshot — effective access is computed live
 * per request by the oracle's triple intersection, which is what makes spawn inheritance
 * track the principal's current groups.
 */

export const AGENT_TOKEN_REGEX = /^aiosd_([A-Za-z0-9]+)_([A-Za-z0-9_-]+)$/;

export interface MintArgs {
  /** The launching principal — the token authenticates AS this member. */
  memberId: string;
  /** Acting-as (a human the launcher represents); null/undefined = self. */
  onBehalfOf?: string | null;
  /** Attenuation: null/undefined = unattenuated (spawn default); [] = sees nothing. */
  projectScope?: string[] | null;
  name?: string;
  expiresAt?: string | null;
}

export interface MintResult {
  ok: boolean;
  error?: string;
  /** The full bearer token — returned exactly once, never stored or logged. */
  token?: string;
  tokenRowId?: string;
}

export interface AgentTokenPrincipal {
  tokenRowId: string;
  teamId: string;
  memberId: string;
  onBehalfOf: string | null;
  projectScope: string[] | null;
  /** Strictest tier across both legs: external if EITHER member is external-tier. */
  effectiveTier: "team" | "external";
}

type TokenRow = {
  id: string;
  team_id: string;
  member_id: string;
  on_behalf_of: string | null;
  project_scope: string[] | null;
  token_hash: string;
  expires_at: string | null;
  revoked_at: string | null;
};

type MemberRow = { id: string; kind: string; is_connector: boolean; status: string; tier: "team" | "external" };

async function getMember(db: DbClient, teamId: string, memberId: string): Promise<MemberRow | null> {
  const { data } = await db
    .from("members")
    .select("id, kind, is_connector, status, tier")
    .eq("team_id", teamId)
    .eq("id", memberId)
    .maybeSingle();
  return (data as MemberRow) ?? null;
}

/** Mint a token. Refused unless BOTH legs (launcher, and acting-as when set) are principals. */
export async function mintAgentToken(
  db: DbClient,
  teamId: string,
  args: MintArgs,
  actorMemberId: string
): Promise<MintResult> {
  const launcher = await getMember(db, teamId, args.memberId);
  if (!launcher) return { ok: false, error: "launching member not found" };
  if (!isPrincipal(launcher)) return { ok: false, error: "launching member is not a principal" };
  if (args.onBehalfOf) {
    const rep = await getMember(db, teamId, args.onBehalfOf);
    if (!rep) return { ok: false, error: "on_behalf_of member not found" };
    if (!isPrincipal(rep)) return { ok: false, error: "on_behalf_of member is not a principal" };
  }

  const tokenId = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const { data, error } = await db
    .from("agent_tokens")
    .insert({
      team_id: teamId,
      member_id: args.memberId,
      on_behalf_of: args.onBehalfOf ?? null,
      project_scope: args.projectScope ?? null,
      token_id: tokenId,
      token_hash: createHash("sha256").update(secret).digest("hex"),
      name: args.name ?? "",
      created_by: actorMemberId,
      expires_at: args.expiresAt ?? null,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };

  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actorMemberId,
    action: "access.token_minted",
    target_type: "agent_tokens",
    target_id: data.id,
    // Never the secret. Scope + legs are the security-relevant provenance.
    meta: {
      member_id: args.memberId,
      on_behalf_of: args.onBehalfOf ?? null,
      scoped: args.projectScope != null,
      scope_size: args.projectScope?.length ?? null,
    },
  });
  return { ok: true, token: `aiosd_${tokenId}_${secret}`, tokenRowId: data.id as string };
}

/**
 * Verify a bearer credential. Fail-closed on every path: unknown/revoked/expired token, hash
 * mismatch, or EITHER leg no longer a principal → null. Re-checking the legs at verify time is
 * what makes revoking a person's principal-hood (deactivate, kind flip) kill their tokens on
 * the next request rather than at the next cleanup.
 */
export async function verifyAgentToken(
  db: DbClient,
  bearer: string
): Promise<AgentTokenPrincipal | null> {
  const m = bearer.match(AGENT_TOKEN_REGEX);
  if (!m) return null;
  const [, tokenId, secret] = m;

  const { data } = await db
    .from("agent_tokens")
    .select("id, team_id, member_id, on_behalf_of, project_scope, token_hash, expires_at, revoked_at")
    .eq("token_id", tokenId)
    .maybeSingle();
  const row = data as TokenRow | null;
  if (!row || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  const candidate = createHash("sha256").update(secret).digest();
  const stored = Buffer.from(row.token_hash, "hex");
  if (stored.length !== candidate.length || !timingSafeEqual(stored, candidate)) return null;

  const launcher = await getMember(db, row.team_id, row.member_id);
  if (!launcher || !isPrincipal(launcher)) return null;
  let repTier: "team" | "external" | null = null;
  if (row.on_behalf_of) {
    const rep = await getMember(db, row.team_id, row.on_behalf_of);
    if (!rep || !isPrincipal(rep)) return null;
    repTier = rep.tier;
  }

  return {
    tokenRowId: row.id,
    teamId: row.team_id,
    memberId: row.member_id,
    onBehalfOf: row.on_behalf_of,
    projectScope: row.project_scope,
    effectiveTier: launcher.tier === "external" || repTier === "external" ? "external" : "team",
  };
}

/** Revoke. Idempotent; audited. */
export async function revokeAgentToken(
  db: DbClient,
  teamId: string,
  tokenRowId: string,
  actorMemberId: string
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db
    .from("agent_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("id", tokenRowId);
  if (error) return { ok: false, error: error.message };
  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actorMemberId,
    action: "access.token_revoked",
    target_type: "agent_tokens",
    target_id: tokenRowId,
  });
  return { ok: true };
}

/** Usage telemetry — best-effort, never fails a request. */
export async function markAgentTokenUsed(db: DbClient, tokenRowId: string): Promise<void> {
  try {
    await db.from("agent_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", tokenRowId);
  } catch {
    // telemetry must never take the request down
  }
}
