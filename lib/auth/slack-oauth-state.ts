import "server-only";
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { DbClient } from "@/lib/db/types";

/**
 * The single owner of the one-click Slack OAuth `state` — both the signed JWT and the
 * server-side single-use nonce that backs it (`oauth_states`).
 *
 * `start` calls {@link createSlackOAuthState} (mints a nonce row + a short-TTL HS256 JWT binding
 * {memberId, teamId, nonce}); `callback` calls {@link consumeSlackOAuthState} (verifies the JWT and
 * ATOMICALLY consumes the nonce — `update … where used_at is null and not expired … returning`).
 *
 * The signed JWT alone stops CSRF/forgery (attacker can't mint a valid state without AUTH_SECRET);
 * the single-use nonce adds replay protection + one-start→one-binding. Residual (documented): a
 * leaked *unused* state within its 10-min TTL could still be paired with an attacker `code` on first
 * use — fully closing that needs browser-session binding (PKCE), infeasible for a headless API-key
 * `start`. AUTH_SECRET is read lazily (call time, not import time) so tests can set it in `beforeAll`.
 */

const ALG = "HS256";
const TTL_S = 600; // 10 minutes

export interface SlackOAuthState {
  memberId: string;
  teamId: string;
  nonce: string;
}

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("Slack OAuth state signing requires AUTH_SECRET (>=16 chars).");
  }
  return new TextEncoder().encode(s);
}

/**
 * Mint a single-use state: persist a nonce row (expiring), then sign a short-TTL JWT carrying it.
 * Returns the signed `state` string for the Slack authorize URL.
 */
export async function createSlackOAuthState(
  supabase: DbClient,
  teamId: string,
  memberId: string
): Promise<string> {
  const nonce = randomUUID();
  const expiresAt = new Date(Date.now() + TTL_S * 1000).toISOString();
  const { error } = await supabase
    .from("oauth_states")
    .insert({ nonce, team_id: teamId, member_id: memberId, provider: "slack", expires_at: expiresAt });
  if (error) throw new Error(`oauth state insert failed: ${error.message}`);
  return new SignJWT({ memberId, teamId, nonce })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${TTL_S}s`)
    .sign(secret());
}

/**
 * Verify the state JWT and atomically consume its nonce. Returns {teamId, memberId} on success, or
 * null if the JWT is invalid/expired/tampered, the nonce is unknown/already-used/expired, or the
 * persisted row disagrees with the JWT claims. Single SQL UPDATE … RETURNING → no TOCTOU race.
 */
export async function consumeSlackOAuthState(
  supabase: DbClient,
  token: string | null | undefined
): Promise<{ teamId: string; memberId: string } | null> {
  if (!token) return null;
  let claims: SlackOAuthState;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: [ALG] });
    if (
      typeof payload.memberId !== "string" ||
      typeof payload.teamId !== "string" ||
      typeof payload.nonce !== "string"
    ) {
      return null;
    }
    claims = { memberId: payload.memberId, teamId: payload.teamId, nonce: payload.nonce };
  } catch {
    return null;
  }

  // Atomic single-use consume: succeeds only if the nonce is still unused and unexpired.
  const { data, error } = await supabase
    .from("oauth_states")
    .update({ used_at: new Date().toISOString() })
    .eq("nonce", claims.nonce)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("team_id, member_id")
    .maybeSingle();
  if (error || !data) return null;

  const row = data as { team_id: string; member_id: string };
  // Defense in depth: the persisted binding must match the signed claims.
  if (row.team_id !== claims.teamId || row.member_id !== claims.memberId) return null;
  return { teamId: row.team_id, memberId: row.member_id };
}
