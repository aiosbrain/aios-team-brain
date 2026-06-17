import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { runSql } from "@/lib/db/pg/pool";
import type { SessionUser } from "./pg-session";

/**
 * Postgres-backend login primitives: a local auth_users table, member linking
 * by email (mirrors the Supabase confirm flow), and single-use, expiring
 * magic-link tokens (sha256-at-rest) in auth_tokens. Invite-only: tokens are
 * only issued for emails that already have a member row.
 */

const TOKEN_TTL_MIN = 15;

export async function ensureAuthUser(email: string): Promise<string> {
  const { rows } = await runSql<{ id: string }>(
    `insert into auth_users (email) values ($1)
       on conflict (email) do update set email = excluded.email
     returning id`,
    [email]
  );
  return rows[0].id;
}

/** First login: claim invited member row(s) for this email and activate them. */
export async function linkMemberByEmail(authUserId: string, email: string): Promise<void> {
  await runSql(
    `update members set auth_user_id = $1, status = 'active'
     where email = $2 and auth_user_id is null and status <> 'disabled'`,
    [authUserId, email]
  );
}

export async function emailHasMember(email: string): Promise<boolean> {
  const { rows } = await runSql<{ n: number }>(
    `select count(*)::int n from members where email = $1 and status <> 'disabled'`,
    [email]
  );
  return (rows[0]?.n ?? 0) > 0;
}

/** Issue a magic-link token, or null if the email has no member (invite-only).
 * `ttlMinutes` defaults to the login TTL; admin-minted links may pass a longer one. */
export async function issueMagicToken(
  email: string,
  nextPath: string,
  ttlMinutes: number = TOKEN_TTL_MIN
): Promise<string | null> {
  if (!(await emailHasMember(email))) return null;
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  await runSql(
    `insert into auth_tokens (token_hash, email, next_path, expires_at)
     values ($1, $2, $3, $4)`,
    [hash, email, nextPath, expires]
  );
  return raw;
}

export interface RedeemResult {
  user: SessionUser;
  nextPath: string;
}

/** Verify + consume a magic token; links the member and returns the session user. */
export async function redeemMagicToken(raw: string): Promise<RedeemResult | null> {
  const hash = createHash("sha256").update(raw).digest("hex");
  const { rows } = await runSql<{ email: string; next_path: string }>(
    `update auth_tokens set used_at = now()
     where token_hash = $1 and used_at is null and expires_at > now()
     returning email, next_path`,
    [hash]
  );
  const tok = rows[0];
  if (!tok) return null;
  const id = await ensureAuthUser(tok.email);
  await linkMemberByEmail(id, tok.email);
  return { user: { id, email: tok.email }, nextPath: tok.next_path };
}
