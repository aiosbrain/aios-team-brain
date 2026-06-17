import type { Metadata } from "next";
import Link from "next/link";
import { Library } from "lucide-react";
import { serverClient } from "@/lib/supabase/server";
import { currentMember } from "@/lib/auth/guard";
import { visibleItems } from "@/lib/auth/visibility";
import { KindBadge } from "@/components/kind-badge";
import { TierBadge } from "@/components/tier-badge";
import { EmptyState } from "@/components/empty-state";
import { timeAgo } from "@/components/format";

export const metadata: Metadata = { title: "Library" };

const KINDS = ["deliverable", "transcript", "decision", "task", "artifact", "skill"] as const;

type LibraryItem = {
  id: string;
  path: string;
  kind: string;
  access: string;
  actor: string;
  synced_at: string;
  projects: { slug: string } | null;
};

export default async function LibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  const { team: teamSlug } = await params;
  const { kind } = await searchParams;
  const supabase = await serverClient();

  const { data: team } = await supabase
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  const tier = me?.tier ?? "external";

  let query = supabase
    .from("items")
    .select("id, path, kind, access, actor, synced_at, projects(slug)")
    .eq("team_id", team.id)
    .order("synced_at", { ascending: false })
    .limit(200);
  query = visibleItems(query, tier); // external viewers never see team/admin content
  if (kind && (KINDS as readonly string[]).includes(kind)) {
    query = query.eq("kind", kind);
  }
  const { data: items } = await query;
  const rows = (items ?? []) as unknown as LibraryItem[];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <h1 className="text-2xl font-semibold text-ink">Library</h1>

      {/* kind filter */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/t/${teamSlug}/library`}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            !kind
              ? "border-violet/40 bg-violet/10 text-violet"
              : "border-border-default text-ink-secondary hover:border-violet/30"
          }`}
        >
          All
        </Link>
        {KINDS.map((k) => (
          <Link
            key={k}
            href={`/t/${teamSlug}/library?kind=${k}`}
            className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors ${
              kind === k
                ? "border-violet/40 bg-violet/10 text-violet"
                : "border-border-default text-ink-secondary hover:border-violet/30"
            }`}
          >
            {k}s
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Library}
          title={kind ? `No ${kind}s in the library` : "The library is empty"}
          action={
            kind
              ? "Clear the filter or push content of this kind with aios push from a project repo."
              : "Everything your team syncs lands here. Issue an API key in Admin → Keys and run aios push from a repo to fill the shelves."
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((it) => (
            <Link
              key={it.id}
              href={`/t/${teamSlug}/library/${it.id}`}
              className="prism-card prism-card-hover flex flex-col gap-2.5 px-4 py-4"
            >
              <div className="flex items-center gap-2">
                <KindBadge kind={it.kind} />
                <TierBadge tier={it.access} />
              </div>
              <p className="break-all font-mono text-xs leading-relaxed text-ink" title={it.path}>
                {it.path}
              </p>
              <p className="mt-auto flex items-center justify-between text-[11px] text-ink-tertiary">
                <span>
                  {it.projects?.slug ?? "—"}
                  {it.actor ? ` · @${it.actor}` : ""}
                </span>
                <span>{timeAgo(it.synced_at)}</span>
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
