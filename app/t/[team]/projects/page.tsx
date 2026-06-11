import type { Metadata } from "next";
import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { serverClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/empty-state";
import { timeAgo } from "@/components/format";

export const metadata: Metadata = { title: "Projects" };

type ProjectCard = {
  id: string;
  slug: string;
  name: string;
  last_synced_at: string | null;
  items: { count: number }[];
  tasks: { count: number }[];
};

export default async function ProjectsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const supabase = await serverClient();

  const { data: team } = await supabase
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const { data: projects } = await supabase
    .from("projects")
    .select("id, slug, name, last_synced_at, items(count), tasks(count)")
    .eq("team_id", team.id)
    .order("last_synced_at", { ascending: false, nullsFirst: false });

  const rows = (projects ?? []) as unknown as ProjectCard[];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <h1 className="text-2xl font-semibold text-ink">Projects</h1>
      {rows.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          action="Projects are created automatically the first time someone runs aios push from a repo. Issue an API key in Admin → Keys, then push."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((p) => (
            <Link
              key={p.id}
              href={`/t/${teamSlug}/projects/${p.slug}`}
              className="prism-card prism-card-hover flex flex-col gap-3 px-5 py-5"
            >
              <div>
                <h2 className="font-display text-lg font-semibold text-ink">{p.name || p.slug}</h2>
                <p className="font-mono text-xs text-ink-tertiary">{p.slug}</p>
              </div>
              <div className="mt-auto flex items-center gap-4 text-xs text-ink-secondary">
                <span>
                  <span className="font-semibold text-ink">{p.items?.[0]?.count ?? 0}</span> items
                </span>
                <span>
                  <span className="font-semibold text-ink">{p.tasks?.[0]?.count ?? 0}</span> tasks
                </span>
                <span className="ml-auto text-ink-tertiary">
                  synced {timeAgo(p.last_synced_at)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
