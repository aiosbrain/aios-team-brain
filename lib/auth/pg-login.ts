import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { runSql } from "@/lib/db/pg/pool";
import { hashPassword, verifyPasswordHash } from "./password";
import type { SessionUser } from "./pg-session";

/**
 * Postgres-backend login primitives: a local auth_users table (email + password_hash), member
 * linking by email (mirrors the Supabase confirm flow), email+password sign-in, and single-use,
 * expiring magic-link tokens (sha256-at-rest) in auth_tokens — retained as an operator/admin-CLI
 * "one-time login link" tool (scripts/admin.ts `login-link`), not the primary sign-in path.
 * Invite-only throughout: passwords/tokens are only ever set/issued for an existing member row.
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

/**
 * Grant a session for an email already known to be a valid, verified sign-in (password checked,
 * or a redeemed magic token) — NOT a public entry point (callers below gate it). Ensures the auth
 * user, force-links the member to it (handles rows seeded active with a different/empty
 * auth_user_id), activates an invited row, and returns the session user.
 */
async function grantSession(email: string): Promise<SessionUser> {
  const id = await ensureAuthUser(email);
  await runSql(
    `update members
        set auth_user_id = $1,
            status = case when status = 'invited' then 'active' else status end
      where email = $2 and status <> 'disabled'`,
    [id, email]
  );
  return { id, email };
}

/**
 * Email+password login (audit M1/M2b — replaces the earlier trust-any-known-email passwordless
 * flow). Rejects unless: the email belongs to a non-disabled member, a password has actually been
 * set (an admin-created account with no password yet cannot be logged into), and it matches.
 */
export async function loginWithPassword(email: string, password: string): Promise<SessionUser | null> {
  if (!(await emailHasMember(email))) return null;
  const { rows } = await runSql<{ password_hash: string | null }>(
    `select password_hash from auth_users where email = $1`,
    [email]
  );
  const hash = rows[0]?.password_hash;
  if (!hash) return null; // no password set yet — ask an admin, don't fall back to passwordless
  if (!(await verifyPasswordHash(password, hash))) return null;
  return grantSession(email);
}

/** Admin sets (or resets) a member's password directly — no current-password check. */
export async function adminSetPassword(email: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await runSql(
    `insert into auth_users (email, password_hash) values ($1, $2)
       on conflict (email) do update set password_hash = excluded.password_hash`,
    [email, hash]
  );
}

/**
 * Self-service password change. Verifies `currentPassword` against the signed-in user's stored
 * hash before writing the new one — `authUserId` comes from the caller's own session (`sub`), so
 * this can only ever change the caller's own password.
 */
export async function changePassword(
  authUserId: string,
  currentPassword: string,
  newPassword: string
): Promise<boolean> {
  const { rows } = await runSql<{ password_hash: string | null }>(
    `select password_hash from auth_users where id = $1`,
    [authUserId]
  );
  const hash = rows[0]?.password_hash;
  if (!hash || !(await verifyPasswordHash(currentPassword, hash))) return false;
  const newHash = await hashPassword(newPassword);
  await runSql(`update auth_users set password_hash = $1 where id = $2`, [newHash, authUserId]);
  return true;
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
  /** True iff this redemption activated an 'invited' member — the caller should show
   * the one-time welcome screen instead of dropping straight onto the dashboard. */
  firstLogin: boolean;
}

function teamSlugFromNextPath(nextPath: string): string | null {
  const m = /^\/t\/([^/?]+)/.exec(nextPath);
  return m ? m[1] : null;
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

  // Capture 'invited' status BEFORE linkMemberByEmail activates it below.
  let firstLogin = false;
  const teamSlug = teamSlugFromNextPath(tok.next_path);
  if (teamSlug) {
    const { rows: memberRows } = await runSql<{ status: string }>(
      `select m.status
         from members m
         join teams t on t.id = m.team_id
        where t.slug = $1 and m.email = $2 and m.status <> 'disabled'`,
      [teamSlug, tok.email]
    );
    firstLogin = memberRows[0]?.status === "invited";
  }

  const id = await ensureAuthUser(tok.email);
  await linkMemberByEmail(id, tok.email);
  return { user: { id, email: tok.email }, nextPath: tok.next_path, firstLogin };
}
