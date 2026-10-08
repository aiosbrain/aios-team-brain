import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { DbClient } from "@/lib/db/types";

const ALG = "HS256";
const TTL_S = 600;

/**
 * The browser half of the OAuth `state`. `start` mints a random binding, sets it as this cookie in
 * the browser that began the connection, and signs only its hash into the state. A state can then
 * be redeemed only by a request that also carries the cookie: a state that leaked (a copied
 * authorize URL, a referrer, a log line) is worthless in any other browser, so nobody can finish
 * someone else's connection with a Google account of their own.
 */
export const GDRIVE_OAUTH_BINDING_COOKIE = "aios_gdrive_oauth";

export function gdriveOAuthBindingCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax, not strict: Google returns the browser here by a cross-site top-level navigation.
    sameSite: "lax",
    path: "/api/auth/gdrive/callback",
    maxAge: TTL_S,
  };
}

export function newGoogleDriveOAuthBinding(): string {
  return randomBytes(32).toString("base64url");
}

interface Claims {
  memberId: string;
  teamId: string;
  nonce: string;
  integrationName: string;
  teamSlug: string;
  /** sha256 of the initiating browser's binding cookie. */
  browser: string;
}

type BoundContext = Omit<Claims, "nonce" | "browser">;

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 16) throw new Error("Google Drive OAuth state requires AUTH_SECRET (>=16 chars)");
  return new TextEncoder().encode(value);
}

function bindingHash(binding: string): string {
  return createHash("sha256").update(binding).digest("base64url");
}

export async function createGoogleDriveOAuthState(
  db: DbClient,
  input: BoundContext & { browserBinding: string },
): Promise<string> {
  const { browserBinding, ...context } = input;
  if (!browserBinding) throw new Error("Google Drive OAuth state requires a browser binding");
  const nonce = randomUUID();
  const expiresAt = new Date(Date.now() + TTL_S * 1000).toISOString();
  const { error } = await db.from("oauth_states").insert({
    nonce,
    team_id: context.teamId,
    member_id: context.memberId,
    provider: "gdrive",
    expires_at: expiresAt,
  });
  if (error) throw new Error(`oauth state insert failed: ${error.message}`);
  return new SignJWT({ ...context, nonce, browser: bindingHash(browserBinding) })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${TTL_S}s`)
    .sign(secret());
}

/**
 * Verify the state, require the initiating browser's binding, and only then consume the nonce.
 * A request without the matching cookie is refused BEFORE the nonce is touched, so presenting a
 * leaked state from another browser neither redeems it nor burns it for its rightful owner.
 */
export async function consumeGoogleDriveOAuthState(
  db: DbClient,
  token: string | null | undefined,
  browserBinding: string | null | undefined,
): Promise<BoundContext | null> {
  if (!token || !browserBinding) return null;
  let claims: Claims;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: [ALG] });
    for (const key of ["memberId", "teamId", "nonce", "integrationName", "teamSlug", "browser"] as const) {
      if (typeof payload[key] !== "string" || !payload[key]) return null;
    }
    claims = payload as unknown as Claims;
  } catch {
    return null;
  }
  const expected = Buffer.from(claims.browser);
  const presented = Buffer.from(bindingHash(browserBinding));
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
  const { data, error } = await db
    .from("oauth_states")
    .update({ used_at: new Date().toISOString() })
    .eq("nonce", claims.nonce)
    .eq("provider", "gdrive")
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("team_id, member_id")
    .maybeSingle();
  if (error || !data || data.team_id !== claims.teamId || data.member_id !== claims.memberId) return null;
  return {
    teamId: claims.teamId,
    memberId: claims.memberId,
    integrationName: claims.integrationName,
    teamSlug: claims.teamSlug,
  };
}
