import { serverClient } from "@/lib/db/server";
import { timeAgo } from "@/components/format";

export default async function AuditAdminPage({
  params,
}: {
  params: Promise<{ team: string }>;
}) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const { data: entries } = await db
    .from("audit_log")
    .select("id, actor_kind, action, target_type, target_id, meta, ip, created_at")
    .eq("team_id", team.id)
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        Append-only trail of every sync write, auth failure, and key operation. Last 200 entries.
      </p>
      <div className="prism-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">Detail</th>
            </tr>
          </thead>
          <tbody>
            {(entries ?? []).map((e) => (
              <tr key={e.id} className="border-b border-border-subtle last:border-0 align-top">
                <td className="whitespace-nowrap px-4 py-3 text-ink-tertiary">
                  {timeAgo(e.created_at)}
                </td>
                <td className="px-4 py-3 text-ink-secondary">{e.actor_kind}</td>
                <td className="px-4 py-3 font-mono text-xs text-ink">{e.action}</td>
                <td className="px-4 py-3 text-ink-secondary">
                  {e.target_type ? `${e.target_type}` : "—"}
                </td>
                <td className="max-w-md px-4 py-3 font-mono text-xs text-ink-tertiary">
                  {e.meta && Object.keys(e.meta as object).length > 0
                    ? JSON.stringify(e.meta).slice(0, 120)
                    : "—"}
                </td>
              </tr>
            ))}
            {(entries ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-ink-tertiary">
                  Nothing audited yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
