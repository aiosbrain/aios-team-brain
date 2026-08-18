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
 * A delegated agent token's resolved principal (spec §10). Distinct from ApiAuth on purpose:
 * routes must OPT IN to delegated tokens — GET /api/v1/items (Phase A) and POST /api/v1/query
 * (Phase B slice 3, always oracle-attenuated) do; every other route's `authenticateApiKey`
 * rejects the `aiosd_` prefix as malformed (fail closed).
 */
export type AgentApiAuth = {
  kind: "agent";
  teamId: string;
  /** The launching principal. */
  memberId: string;
  onBehalfOf: string | null;
  projectScope: string[] | null;
  /** Strictest tier across both legs. */
  memberTier: "team" | "external";
  agentTokenId: string;
};

/** True when the Authorization header carries a delegated agent token (aiosd_ prefix). */
export function isAgentBearer(req: Request): boolean {
  return /^Bearer\s+aiosd_/.test(req.headers.get("authorization") || "");
}

/**
 * Bearer auth for delegated agent tokens (`aiosd_<token_id>_<secret>`). Same discipline as
 * authenticateApiKey: null on any failure (caller responds 401), failures audited, the
 * X-AIOS-Team header must match the token's team.
 */
export async function authenticateAgentToken(req: Request): Promise<AgentApiAuth | null> {
  const { verifyAgentToken, markAgentTokenUsed } = await import("@/lib/access/agent-tokens");
  const header = req.headers.get("authorization") || "";
  const teamHeader = req.headers.get("x-aios-team") || "";
  const db = adminClient();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

  const bearer = header.replace(/^Bearer\s+/, "");
  const principal = await verifyAgentToken(db, bearer);
  if (!principal) {
    await audit(db, {
      team_id: null,
      actor_kind: "system",
      action: "auth.failed",
      meta: { reason: "invalid_agent_token", team_header: teamHeader },
      ip,
    });
    return null;
  }
  if (teamHeader && teamHeader !== principal.teamId) {
    const { data: team } = await db.from("teams").select("slug").eq("id", principal.teamId).maybeSingle();
    if (teamHeader !== (team as { slug: string } | null)?.slug) {
      await audit(db, {
        team_id: null,
        actor_kind: "system",
        action: "auth.failed",
        meta: { reason: "team_mismatch", team_header: teamHeader },
        ip,
      });
      return null;
    }
  }
  void markAgentTokenUsed(db, principal.tokenRowId);
  // §10: tokens audit on mint/USE/revoke. Best-effort like every audit; the actor is the
  // launching member (audit_log.api_key_id is the api_keys namespace, not agent_tokens).
  // If polling volume ever makes this noisy, sample/coalesce here — never silently drop.
  void audit(db, {
    team_id: principal.teamId,
    actor_kind: "member",
    member_id: principal.memberId,
    action: "access.token_used",
    target_type: "agent_token",
    target_id: principal.tokenRowId,
    meta: { on_behalf_of: principal.onBehalfOf, scoped: principal.projectScope != null },
    ip,
  });
  return {
    kind: "agent",
    teamId: principal.teamId,
    memberId: principal.memberId,
    onBehalfOf: principal.onBehalfOf,
    projectScope: principal.projectScope,
    memberTier: principal.effectiveTier,
    agentTokenId: principal.tokenRowId,
  };
}

export async function markApiKeyUsed(apiKeyId: string): Promise<boolean> {
  try {
    const { error } = await adminClient()
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", apiKeyId);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Bearer key auth for the sync API. Key format: aios_<key_id>_<secret>.
 * We look up by key_id and compare sha256(secret) with timingSafeEqual.
 * Returns null on any failure (caller responds 401); failures are audited.
 */
export async function authenticateApiKey(
  req: Request,
  { recordUsage = true }: { recordUsage?: boolean } = {},
): Promise<ApiAuth | null> {
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

  // Usage telemetry must not make otherwise-valid API requests fail. The /me validation
  // route opts out and persists this marker synchronously as its explicit contract.
  if (recordUsage) void markApiKeyUsed(key.id);

  // PRET-4 §1a: the VALUE every downstream consumer receives as `memberTier` is POSTURE —
  // membership in the everyone built-in — not the members.tier record. Same vocabulary, so
  // every consumer survives verbatim; the source is now explicit membership state. A resolver
  // error fails the request closed (auth returns null → 401), never a silent widen/narrow.
  let posture: "team" | "external";
  try {
    const { resolveViewerPosture } = await import("@/lib/access/posture");
    posture = await resolveViewerPosture(db, key.team_id, key.member_id);
  } catch (e) {
    console.error("[auth] posture resolution failed:", e instanceof Error ? e.message : e);
    return fail("posture_unresolvable");
  }

  return {
    teamId: key.team_id,
    memberId: key.member_id,
    memberTier: posture,
    memberRole: member.role,
    apiKeyId: key.id,
    actorHandle: member.actor_handle,
    displayName: member.display_name,
    email: member.email,
  };
}
