import "server-only";
import { runSql } from "@/lib/db/pg/pool";

export interface WelcomeContext {
  teamName: string;
  inviteeName: string;
  /** null when the member was created outside the invite UI (no audited actor). */
  inviterName: string | null;
}

/**
 * Resolve the "Welcome, {name} — you're joining {team}, invited by {inviter}" copy for a
 * member's first login. Inviter identity is derived from the append-only `audit_log`
 * (the `member.created` event recorded when they were invited) rather than a dedicated
 * `invited_by` column — no schema change needed, and it degrades gracefully to null for
 * members created without an audited actor (e.g. via the CLI as `system`).
 */
export async function getWelcomeContext(teamSlug: string, email: string): Promise<WelcomeContext | null> {
  const { rows } = await runSql<{ team_name: string; member_id: string; display_name: string }>(
    `select t.name as team_name, m.id as member_id, m.display_name
       from members m
       join teams t on t.id = m.team_id
      where t.slug = $1 and m.email = $2 and m.status <> 'disabled'`,
    [teamSlug, email]
  );
  const row = rows[0];
  if (!row) return null;

  const { rows: inviterRows } = await runSql<{ display_name: string }>(
    `select inviter.display_name
       from audit_log a
       join members inviter on inviter.id = a.member_id
      where a.target_type = 'member' and a.target_id = $1 and a.action = 'member.created'
      order by a.created_at desc
      limit 1`,
    [row.member_id]
  );

  return {
    teamName: row.team_name,
    inviteeName: row.display_name,
    inviterName: inviterRows[0]?.display_name ?? null,
  };
}
