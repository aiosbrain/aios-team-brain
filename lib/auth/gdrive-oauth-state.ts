import "server-only";
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { DbClient } from "@/lib/db/types";

const ALG = "HS256";
const TTL_S = 600;

interface Claims {
  memberId: string;
  teamId: string;
  nonce: string;
  integrationName: string;
  teamSlug: string;
}

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 16) throw new Error("Google Drive OAuth state requires AUTH_SECRET (>=16 chars)");
  return new TextEncoder().encode(value);
}

export async function createGoogleDriveOAuthState(
  db: DbClient,
  input: Omit<Claims, "nonce">,
): Promise<string> {
  const nonce = randomUUID();
  const expiresAt = new Date(Date.now() + TTL_S * 1000).toISOString();
  const { error } = await db.from("oauth_states").insert({
    nonce,
    team_id: input.teamId,
    member_id: input.memberId,
    provider: "gdrive",
    expires_at: expiresAt,
  });
  if (error) throw new Error(`oauth state insert failed: ${error.message}`);
  return new SignJWT({ ...input, nonce })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${TTL_S}s`)
    .sign(secret());
}

export async function consumeGoogleDriveOAuthState(
  db: DbClient,
  token: string | null | undefined,
): Promise<Omit<Claims, "nonce"> | null> {
  if (!token) return null;
  let claims: Claims;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: [ALG] });
    for (const key of ["memberId", "teamId", "nonce", "integrationName", "teamSlug"] as const) {
      if (typeof payload[key] !== "string" || !payload[key]) return null;
    }
    claims = payload as unknown as Claims;
  } catch {
    return null;
  }
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
