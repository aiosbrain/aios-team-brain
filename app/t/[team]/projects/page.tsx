import type { Metadata } from "next";
import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { visibleProjectCards } from "@/lib/access/enforce";
import { EmptyState } from "@/components/empty-state";
import { NewProjectButton } from "@/components/projects/new-project-button";
import { timeAgo } from "@/components/format";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  // ENFB-2 §2.1: the inventory serves ROW-VISIBLE projects only (granted ∪ content-visible),
  // with VIEWER-visible counts — the previous ungated read served every initiative's name and
  // content volume to any team member. No member → empty list (fail closed).
  const viewer = await currentMember(team.id);
  const cards = viewer
    ? await visibleProjectCards(db, { teamId: team.id, memberId: viewer.id })
    : { rows: [] as Awaited<ReturnType<typeof visibleProjectCards>>["rows"] };
  // A substrate ERROR is not an empty inventory (Fable diff L8) — surface it to the error
  // boundary instead of rendering the misleading "No projects yet" onboarding state.
  if ("error" in cards && cards.error) throw new Error("project visibility resolution failed");
  const rows = cards.rows;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">Projects</h1>
        <NewProjectButton teamId={team.id} />
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          action="Create one with the New project button, or run aios push from a repo (issue an API key in Admin → Keys first) and projects appear automatically."
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
                <h2 className="font-display text-lg text-ink">{p.name || p.slug}</h2>
                <p className="font-mono text-xs text-ink-tertiary">{p.slug}</p>
              </div>
              <div className="mt-auto flex items-center gap-4 text-xs text-ink-secondary">
                <span>
                  <span className="font-semibold text-ink">{p.visibleItems}</span> items
                </span>
                <span>
                  <span className="font-semibold text-ink">{p.visibleTasks}</span> tasks
                </span>
                <span className="ml-auto text-ink-tertiary">
                  {p.last_synced_at ? `synced ${timeAgo(p.last_synced_at)}` : "not synced yet"}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
