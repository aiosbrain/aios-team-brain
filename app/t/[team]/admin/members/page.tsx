import { serverClient } from "@/lib/supabase/server";
import { InviteMember } from "@/components/admin/invite-member";

export default async function MembersAdminPage({
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

  const { data: members } = await supabase
    .from("members")
    .select("id, display_name, email, actor_handle, role, tier, status, created_at")
    .eq("team_id", team.id)
    .order("created_at");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-secondary">
          {(members ?? []).length} member(s). Actor handles must match the <code>actor</code> each
          person&apos;s <code>aios</code> CLI resolves — that&apos;s how pushes get attributed.
        </p>
        <InviteMember teamSlug={teamSlug} />
      </div>
      <div className="prism-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Handle</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Tier</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {(members ?? []).map((m) => (
              <tr key={m.id} className="border-b border-border-subtle last:border-0">
                <td className="px-4 py-3 font-medium text-ink">{m.display_name}</td>
                <td className="px-4 py-3 text-ink-secondary">{m.email}</td>
                <td className="px-4 py-3 font-mono text-xs text-ink-secondary">{m.actor_handle}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${m.role === "admin" ? "bg-violet/10 text-violet" : "bg-surface-overlay text-ink-secondary"}`}>
                    {m.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-ink-secondary">{m.tier}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs ${m.status === "active" ? "text-emerald-600" : m.status === "invited" ? "text-amber-600" : "text-ink-tertiary"}`}>
                    {m.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
