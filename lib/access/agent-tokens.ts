import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { isPrincipal } from "@/lib/access/eligibility";
import {
  INVALID_REQUEST,
  isRequestObject,
  parseTokenMintScope,
  storedProjectScope,
  type TokenMintScope,
} from "@/lib/access/agent-token-scope";

/**
 * Delegated agent tokens (spec §10) — the SINGLE writer for `agent_tokens` (guarded by
 * test/guards/access-single-writer.test.ts). Wire format `aiosd_<token_id>_<secret>`, hashed
 * secret, api_keys discipline. The token stores WHO (launcher + optional acting-as) and the
 * attenuation set; it never stores a visibility snapshot — effective access is computed live
 * per request by the oracle's triple intersection, which is what makes an all-reachable token
 * track the principal's current groups.
 *
 * AUDITFIX-19: minting requires an explicit `scope` choice — there is no default. This server-only
 * primitive validates its eligible legs and the choice itself; it is NOT an admin gate
 * (`actorMemberId` is provenance), and the public admin action applies its own stricter policy.
 */

export const AGENT_TOKEN_REGEX = /^aiosd_([A-Za-z0-9]+)_([A-Za-z0-9_-]+)$/;

export interface MintArgs {
  /** The launching principal — the token authenticates AS this member. */
  memberId: string;
  /**
   * REQUIRED deliberate choice. `all-reachable` stores NULL (no attenuation beyond the live legs);
   * `projects` stores the canonical lowercase list (intersection only). Omission is refused, and a
   * new mint can never request `[]` — though a stored `[]` still means "sees nothing".
   */
  scope: TokenMintScope;
  /** Acting-as (a human the launcher represents); null/undefined = self. */
  onBehalfOf?: string | null;
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

type CapturedMint = {
  memberId: string;
  onBehalfOf: string | null;
  name: string | undefined;
  expiresAt: string | null;
  projectScope: string[] | null;
};

/**
 * Read every request field ONCE, synchronously: the whole request is shape-guarded first, then the
 * scope is re-parsed into this module's own canonical copy — independently of any caller that already
 * validated it — and mapped to its stored form.
 */
function captureMintArgs(args: unknown): { ok: true; mint: CapturedMint } | { ok: false; error: string } {
  if (!isRequestObject(args)) return { ok: false, error: INVALID_REQUEST };
  const request = args as Partial<MintArgs>;
  const memberId = request.memberId as string;
  const onBehalfOf = request.onBehalfOf ?? null;
  const name = request.name;
  const expiresAt = request.expiresAt ?? null;
  const parsed = parseTokenMintScope(args);
  if (!parsed.ok) return parsed;
  return { ok: true, mint: { memberId, onBehalfOf, name, expiresAt, projectScope: storedProjectScope(parsed.scope) } };
}

/**
 * Mint a token. Refused unless the request carries a valid explicit scope choice AND both legs
 * (launcher, and acting-as when set) are principals.
 *
 * The request is captured BEFORE the first database read or secret generation. Member reads, the
 * inserted row and the mint audit all use the captured values, so a caller mutating its object while
 * a read is pending cannot make the row and its audit describe different requests.
 */
export async function mintAgentToken(
  db: DbClient,
  teamId: string,
  args: MintArgs,
  actorMemberId: string
): Promise<MintResult> {
  const captured = captureMintArgs(args);
  if (!captured.ok) return { ok: false, error: captured.error };
  const { memberId, onBehalfOf, name, expiresAt, projectScope } = captured.mint;

  const launcher = await getMember(db, teamId, memberId);
  if (!launcher) return { ok: false, error: "launching member not found" };
  if (!isPrincipal(launcher)) return { ok: false, error: "launching member is not a principal" };
  // Phase A alpha restriction (spec §10/§17-A): "no external-tier delegation" — refused at
  // mint AND re-checked at verify, so a tier downgrade after mint kills the token too.
  if (launcher.tier === "external") return { ok: false, error: "external-tier delegation is not supported in Phase A" };
  if (onBehalfOf) {
    const rep = await getMember(db, teamId, onBehalfOf);
    if (!rep) return { ok: false, error: "on_behalf_of member not found" };
    if (!isPrincipal(rep)) return { ok: false, error: "on_behalf_of member is not a principal" };
    if (rep.tier === "external") return { ok: false, error: "external-tier delegation is not supported in Phase A" };
  }

  const tokenId = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const { data, error } = await db
    .from("agent_tokens")
    .insert({
      team_id: teamId,
      member_id: memberId,
      on_behalf_of: onBehalfOf,
      project_scope: projectScope,
      token_id: tokenId,
      token_hash: createHash("sha256").update(secret).digest("hex"),
      name: name ?? "",
      created_by: actorMemberId,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };

  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actorMemberId,
    action: "access.token_minted",
    target_type: "agent_token",
    target_id: data.id,
    // Never the secret. Scope + legs are the security-relevant provenance — the CAPTURED legs, so
    // the audit always describes the row that was actually inserted.
    meta: {
      member_id: memberId,
      on_behalf_of: onBehalfOf,
      scoped: projectScope !== null,
      scope_size: projectScope?.length ?? null,
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
  // Strictest tier from THIS function's own leg reads — never hardcoded (slice-2 Codex High):
  // computed BEFORE the Phase A refusal so the value stays live code, keeping the route's
  // isRestrictedTier filter as real defense in depth and surviving Phase B relaxing the
  // refusal without a silent hole.
  const effectiveTier: "team" | "external" =
    launcher.tier === "external" || repTier === "external" ? "external" : "team";
  // Phase A alpha restriction: no external-tier delegation on either leg (re-checked live —
  // a tier downgrade after mint kills the token on the next request).
  if (effectiveTier === "external") return null;

  return {
    tokenRowId: row.id,
    teamId: row.team_id,
    memberId: row.member_id,
    onBehalfOf: row.on_behalf_of,
    projectScope: row.project_scope,
    effectiveTier,
  };
}

/** Revoke. Idempotent; audited. */
export async function revokeAgentToken(
  db: DbClient,
  teamId: string,
  tokenRowId: string,
  actorMemberId: string
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await db
    .from("agent_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("id", tokenRowId)
    .is("revoked_at", null)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || (data as unknown[]).length === 0) {
    // Zero rows: either already revoked (idempotent success — keep the ORIGINAL revoked_at
    // and never write a second audit row) or no such token (an error, and never audited —
    // the audit log must not claim phantom revocations).
    const { data: existing } = await db
      .from("agent_tokens")
      .select("revoked_at")
      .eq("team_id", teamId)
      .eq("id", tokenRowId)
      .maybeSingle();
    if ((existing as { revoked_at: string | null } | null)?.revoked_at) return { ok: true };
    return { ok: false, error: "no such token" };
  }
  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actorMemberId,
    action: "access.token_revoked",
    target_type: "agent_token",
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
