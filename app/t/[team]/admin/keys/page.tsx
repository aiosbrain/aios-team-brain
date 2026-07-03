import { serverClient } from "@/lib/supabase/server";
import { IssueKey, RevokeKeyButton } from "@/components/admin/issue-key";
import { timeAgo } from "@/components/format";

export default async function KeysAdminPage({
  params,
}: {
  params: Promise<{ team: string }>;
}) {
  const { team: teamSlug } = await params;
  const supabase = await serverClient();

  const { data: team } = await supabase
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const [{ data: keys }, { data: members }] = await Promise.all([
    supabase
      .from("api_keys")
      .select("id, key_id, name, created_at, last_used_at, revoked_at, members(display_name, actor_handle)")
      .eq("team_id", team.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("members")
      .select("id, display_name, actor_handle")
      .eq("team_id", team.id)
      .order("display_name"),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-secondary">
          Per-member sync keys for the <code>aios</code> CLI. Members can generate their own from
          their profile page — use this to issue one on their behalf instead, or revoke any key.
          Secrets are hashed at rest and shown exactly once at issue time.
        </p>
        <IssueKey teamSlug={teamSlug} members={members ?? []} />
      </div>
      <div className="prism-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <th className="px-4 py-3">Key</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3">Last used</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {(keys ?? []).map((k) => {
              const member = k.members as unknown as { display_name: string; actor_handle: string } | null;
              return (
                <tr key={k.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-3 font-mono text-xs text-ink-secondary">aios_{k.key_id}_…</td>
                  <td className="px-4 py-3 text-ink">{k.name}</td>
                  <td className="px-4 py-3 text-ink-secondary">
                    {member ? `${member.display_name} (${member.actor_handle})` : "—"}
                  </td>
                  <td className="px-4 py-3 text-ink-tertiary">
                    {k.last_used_at ? timeAgo(k.last_used_at) : "never"}
                  </td>
                  <td className="px-4 py-3">
                    {k.revoked_at ? (
                      <span className="text-xs text-red-600">revoked</span>
                    ) : (
                      <span className="text-xs text-emerald-600">active</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!k.revoked_at && <RevokeKeyButton teamSlug={teamSlug} apiKeyId={k.id} />}
                  </td>
                </tr>
              );
            })}
            {(keys ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-ink-tertiary">
                  No keys yet — members can generate their own from their profile page, or issue
                  one here for them.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
