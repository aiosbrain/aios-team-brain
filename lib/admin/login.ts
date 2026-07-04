import "server-only";
import type { DbClient } from "@/lib/db/types";
import { issueMagicToken } from "@/lib/auth/pg-login";
import { audit } from "@/lib/api/audit";
import type { ActorContext } from "./members";

/**
 * Shared admin primitive: mint a magic-link login token for an existing member
 * (invite-only — issueMagicToken returns null if the email has no member). Returns
 * the raw token and, when a base URL is given, the ready-to-click confirm URL.
 * The raw token is a credential: surface once, never log it.
 */
export async function issueLoginLink(
  admin: DbClient,
  teamId: string,
  email: string,
  opts: { nextPath?: string; ttlMinutes?: number; baseUrl?: string; actor?: ActorContext } = {}
): Promise<{ token: string | null; url: string | null }> {
  const e = email.trim().toLowerCase();
  const raw = await issueMagicToken(e, opts.nextPath ?? "/", opts.ttlMinutes);
  if (!raw) return { token: null, url: null };

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "login_link.issued",
    target_type: "member",
    meta: { email: e, ttl_minutes: opts.ttlMinutes ?? null },
  });

  const url = opts.baseUrl
    ? `${opts.baseUrl.replace(/\/$/, "")}/auth/confirm?token=${raw}`
    : null;
  return { token: raw, url };
}
