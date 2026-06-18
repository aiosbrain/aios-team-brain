import type { Metadata } from "next";
import { History } from "lucide-react";
import { serverClient } from "@/lib/supabase/server";
import { currentMember } from "@/lib/auth/guard";
import { scopeQueryLog } from "@/lib/auth/visibility";
import { QueryChat } from "@/components/query-chat";
import { timeAgo, truncate } from "@/components/format";

export const metadata: Metadata = { title: "Query" };

export default async function QueryPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { team: teamSlug } = await params;
  const { q } = await searchParams;
  const supabase = await serverClient();

  const { data: team } = await supabase
    .from("teams")
    .select("id, name")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  // No RLS in postgres mode: scope query_log in app code. Members see only their own queries;
  // admins see the whole team's (scopeQueryLog, CLAUDE.md §5).
  const me = await currentMember(team.id);
  const { data: recent } = me
    ? await scopeQueryLog(
        supabase
          .from("query_log")
          .select("id, question, answer_preview, cost_usd, latency_ms, created_at")
          .eq("team_id", team.id),
        { isAdmin: me.role === "admin", memberId: me.id }
      )
        .order("created_at", { ascending: false })
        .limit(10)
    : { data: [] };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Query</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Ask {team.name}&apos;s shared memory — answers cite the synced sources they came from.
        </p>
      </div>

      <QueryChat teamSlug={teamSlug} initialQuestion={q} />

      <section className="prism-card px-5 py-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          <History className="size-3.5" /> Recent queries
        </h2>
        {(recent ?? []).length === 0 ? (
          <p className="text-sm text-ink-tertiary">
            No queries yet — ask your first question above.
          </p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {(recent ?? []).map((r) => (
              <li key={r.id} className="py-2.5">
                <p className="text-sm font-medium text-ink">{r.question}</p>
                {r.answer_preview ? (
                  <p className="mt-0.5 text-xs text-ink-secondary">
                    {truncate(r.answer_preview, 160)}
                  </p>
                ) : null}
                <p className="mt-1 text-[11px] text-ink-tertiary">
                  {timeAgo(r.created_at)} · ${Number(r.cost_usd).toFixed(3)} · {r.latency_ms}ms
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
