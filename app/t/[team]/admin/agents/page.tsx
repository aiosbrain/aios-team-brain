import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin } from "@/lib/auth/guard";
import { visibleProjectRows } from "@/lib/access/enforce";
import { MintAgentToken, RevokeAgentTokenButton } from "@/components/admin/mint-agent-token";
import { timeAgo } from "@/components/format";

export const metadata: Metadata = { title: "Agents" };

/**
 * Admin → Agents (AGENTUI-1): mint / list / revoke delegated agent tokens.
 *
 * GATING: this page calls `requireTeamAdmin` ITSELF rather than leaning on the admin layout. Next's
 * own guidance is that a layout check does not prevent a nested segment from running or from
 * entering the RSC payload, and there is no RLS behind it (CLAUDE.md §5) — so the layout is defence
 * in depth, not the control. `teamId` is taken from the gate's result, never from the slug.
 *
 * PROJECT READ: the picker is gated by `visibleProjectRows` (ENFB-2), not a raw team-wide select.
 * Being an admin is authority to MANAGE, not a bypass of the access chain — and it yields a
 * property worth having: an admin cannot scope a token to a project they cannot themselves see.
 * Fail-closed: on a substrate error the helper returns an empty set, so the picker offers nothing
 * rather than everything.
 *
 * The select list deliberately EXCLUDES `token_hash`. The page has no use for it, and a server
 * component holding hash material is one prop-pass from serializing it to the browser. (The keys
 * page this is modelled on selects `key_id`, not `key_hash` — same discipline.)
 */

type TokenRow = {
  id: string;
  name: string;
  member_id: string;
  on_behalf_of: string | null;
  project_scope: string[] | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** `null` = inherit the launcher's projects · `[]` = sees nothing · array = restricted. */
function describeScope(scope: string[] | null, names: Map<string, string>): string {
  if (scope === null) return "inherits launcher";
  if (scope.length === 0) return "sees nothing";
  return scope.map((id) => names.get(id) ?? id.slice(0, 8)).join(", ");
}

export default async function AgentsAdminPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;

  const ctx = await requireTeamAdmin(teamSlug);
  if (!ctx) notFound();

  const db = adminClient();
  const visible = await visibleProjectRows(db, { teamId: ctx.teamId, memberId: ctx.memberId });

  const [{ data: tokens }, { data: members }, { data: projects }] = await Promise.all([
    db
      .from("agent_tokens")
      .select("id, name, member_id, on_behalf_of, project_scope, expires_at, last_used_at, revoked_at")
      .eq("team_id", ctx.teamId)
      .order("created_at", { ascending: false }),
    // Resolved separately, not via an embedded `members(...)` select: the pg adapter has no
    // `agent_tokens` relationship and the table has TWO member legs, so the embedded form fails.
    db.from("members").select("id, display_name, actor_handle").eq("team_id", ctx.teamId).order("display_name"),
    visible.ids.size > 0
      ? db.from("projects").select("id, name, slug").eq("team_id", ctx.teamId).in("id", [...visible.ids]).order("name")
      : Promise.resolve({ data: [] as { id: string; name: string; slug: string }[] }),
  ]);

  const memberList = (members ?? []) as { id: string; display_name: string; actor_handle: string }[];
  const projectList = (projects ?? []) as { id: string; name: string; slug: string }[];
  const memberNames = new Map(memberList.map((m) => [m.id, m.display_name]));
  const projectNames = new Map(projectList.map((p) => [p.id, p.name || p.slug]));
  const rows = (tokens ?? []) as TokenRow[];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="max-w-3xl text-sm text-ink-secondary">
          <p>
            Delegated tokens let an agent read the brain <em>as</em> a member, narrowed to chosen
            projects and an expiry date. Unlike an API key, a delegated token creates no chat threads
            — so agent queries stay out of that member&apos;s Query tab. Secrets are hashed at rest and
            shown exactly once.
          </p>
          <p className="mt-2 text-ink-tertiary">
            <strong className="text-ink-secondary">Read-only today.</strong> Delegated tokens work for{" "}
            <code>aios query</code> and item reads. They are <em>not</em> accepted for writes, so{" "}
            <code>aios push</code> with one returns 401 — an agent that pushes still needs its own API
            key. Queries also count against the launching member&apos;s daily quota, so prefer minting
            against a dedicated agent member rather than your own account.
          </p>
        </div>
        <MintAgentToken teamSlug={teamSlug} members={memberList} projects={projectList} />
      </div>

      <div className="prism-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Acts as</th>
              <th className="px-4 py-3">Projects</th>
              <th className="px-4 py-3">Expires</th>
              <th className="px-4 py-3">Last used</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              return (
                <tr key={t.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-3 text-ink">{t.name || "—"}</td>
                  <td className="px-4 py-3 text-ink-secondary">
                    {memberNames.get(t.member_id) ?? "—"}
                    {t.on_behalf_of ? ` → ${memberNames.get(t.on_behalf_of) ?? "?"}` : ""}
                  </td>
                  <td className="px-4 py-3 text-ink-secondary">
                    {describeScope(t.project_scope, projectNames)}
                  </td>
                  <td className="px-4 py-3 text-ink-tertiary">
                    {t.expires_at ? timeAgo(t.expires_at) : "never"}
                  </td>
                  <td className="px-4 py-3 text-ink-tertiary">
                    {t.last_used_at ? timeAgo(t.last_used_at) : "never"}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {/* No render-time clock read: React's purity rule forbids it, and evading the
                        rule via a helper that calls Date.now() internally would be evasion, not a
                        fix. The Expires column carries the same information — `timeAgo` renders a
                        past date as "… ago", which reads as expired without render depending on
                        the current time. */}
                    {t.revoked_at ? (
                      <span className="text-red-600">revoked</span>
                    ) : (
                      <span className="text-emerald-600">active</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!t.revoked_at && <RevokeAgentTokenButton teamSlug={teamSlug} tokenRowId={t.id} />}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-ink-tertiary">
                  No agent tokens yet. Mint one to give an agent read access without handing over a
                  member API key.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
