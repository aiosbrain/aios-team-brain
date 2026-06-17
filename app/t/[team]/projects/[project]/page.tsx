import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleCheck, CircleX, FolderOpen } from "lucide-react";
import { serverClient } from "@/lib/supabase/server";
import { currentMember } from "@/lib/auth/guard";
import { visibleItems } from "@/lib/auth/visibility";
import { KindBadge } from "@/components/kind-badge";
import { TierBadge } from "@/components/tier-badge";
import { EmptyState } from "@/components/empty-state";
import { fmtDate, timeAgo } from "@/components/format";

type Item = {
  id: string;
  path: string;
  kind: string;
  access: string;
  actor: string;
  frontmatter: Record<string, unknown>;
  synced_at: string;
};

type Decision = {
  id: string;
  row_key: string;
  decided_at: string | null;
  title: string;
  decided_by: string;
  still_valid: boolean;
};

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ team: string; project: string }>;
}) {
  const { team: teamSlug, project: projectSlug } = await params;
  const supabase = await serverClient();

  const { data: team } = await supabase
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const { data: project } = await supabase
    .from("projects")
    .select("id, slug, name, last_synced_at")
    .eq("team_id", team.id)
    .eq("slug", projectSlug)
    .maybeSingle();
  if (!project) notFound();

  const me = await currentMember(team.id);
  const [{ data: items }, { data: decisions }, { data: roster }] = await Promise.all([
    visibleItems(
      supabase
        .from("items")
        .select("id, path, kind, access, actor, frontmatter, synced_at")
        .eq("team_id", team.id)
        .eq("project_id", project.id)
        .order("path"),
      me?.tier ?? "external"
    ),
    supabase
      .from("decisions")
      .select("id, row_key, decided_at, title, decided_by, still_valid")
      .eq("team_id", team.id)
      .eq("project_id", project.id)
      .order("decided_at", { ascending: false }),
    supabase
      .from("members")
      .select("id, display_name, actor_handle, role")
      .eq("team_id", team.id)
      .eq("status", "active")
      .order("display_name"),
  ]);

  const itemRows = (items ?? []) as Item[];
  const decisionRows = (decisions ?? []) as Decision[];

  // Spine: group items by top-level directory of path
  const spine = new Map<string, Item[]>();
  for (const it of itemRows) {
    const top = it.path.includes("/") ? it.path.split("/")[0] : "(root)";
    spine.set(top, [...(spine.get(top) ?? []), it]);
  }
  const spineDirs = [...spine.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Deliverables grouped by frontmatter sprint
  const deliverables = itemRows.filter((it) => it.kind === "deliverable");
  const bySprint = new Map<string, Item[]>();
  for (const d of deliverables) {
    const sprint = String(d.frontmatter?.sprint ?? "unscheduled");
    bySprint.set(sprint, [...(bySprint.get(sprint) ?? []), d]);
  }
  const sprints = [...bySprint.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Contributors: members whose actor_handle shows up on this project's items
  const actorHandles = new Set(itemRows.map((it) => it.actor).filter(Boolean));
  const contributors = (roster ?? []).filter((m) => actorHandles.has(m.actor_handle));
  const memberList = contributors.length > 0 ? contributors : (roster ?? []);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <Link
          href={`/t/${teamSlug}/projects`}
          className="text-xs text-ink-tertiary hover:text-violet"
        >
          ← Projects
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-ink">{project.name || project.slug}</h1>
        <p className="text-sm text-ink-tertiary">
          <span className="font-mono text-xs">{project.slug}</span> · last synced{" "}
          {timeAgo(project.last_synced_at)}
        </p>
      </div>

      {itemRows.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="Nothing synced for this project yet"
          action="Run aios push from the project repo to populate the spine, deliverables and decisions."
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Spine overview */}
          <section className="prism-card px-5 py-4 lg:col-span-2">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
              Spine
            </h2>
            <div className="flex flex-col gap-4">
              {spineDirs.map(([dir, dirItems]) => (
                <div key={dir}>
                  <p className="mb-1.5 flex items-center gap-2 font-mono text-xs font-semibold text-violet">
                    <FolderOpen className="size-3.5" /> {dir}/
                    <span className="font-body font-normal text-ink-tertiary">
                      {dirItems.length}
                    </span>
                  </p>
                  <ul className="ml-1 flex flex-col gap-1 border-l border-border-subtle pl-4">
                    {dirItems.map((it) => (
                      <li key={it.id} className="flex items-center gap-2">
                        <Link
                          href={`/t/${teamSlug}/library/${it.id}`}
                          className="min-w-0 truncate font-mono text-xs text-ink-secondary hover:text-violet"
                          title={it.path}
                        >
                          {it.path.split("/").slice(1).join("/") || it.path}
                        </Link>
                        <KindBadge kind={it.kind} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          <div className="flex flex-col gap-6">
            {/* Deliverables by sprint */}
            <section className="prism-card px-5 py-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
                Deliverables
              </h2>
              {sprints.length === 0 ? (
                <p className="text-sm text-ink-tertiary">No deliverables synced yet.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {sprints.map(([sprint, ds]) => (
                    <div key={sprint}>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-violet">
                        {sprint}
                      </p>
                      <ul className="flex flex-col gap-1">
                        {ds.map((d) => (
                          <li key={d.id} className="flex items-center justify-between gap-2">
                            <Link
                              href={`/t/${teamSlug}/library/${d.id}`}
                              className="min-w-0 truncate text-sm text-ink-secondary hover:text-violet"
                              title={d.path}
                            >
                              {String(d.frontmatter?.title ?? d.path.split("/").pop())}
                            </Link>
                            <TierBadge tier={d.access} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Members */}
            <section className="prism-card px-5 py-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
                {contributors.length > 0 ? "Contributors" : "Team members"}
              </h2>
              <ul className="flex flex-col gap-2">
                {memberList.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-ink">{m.display_name}</span>
                    <span className="font-mono text-xs text-ink-tertiary">@{m.actor_handle}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      )}

      {/* Decisions for this project */}
      <section className="prism-card overflow-x-auto">
        <h2 className="px-5 pt-4 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Decisions
        </h2>
        {decisionRows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-tertiary">
            No decisions recorded for this project yet — they materialize from the synced
            decision-log.
          </p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-border-default text-left text-xs uppercase tracking-wider text-ink-tertiary">
                <th className="px-5 py-2.5 font-medium">#</th>
                <th className="px-5 py-2.5 font-medium">Date</th>
                <th className="px-5 py-2.5 font-medium">Title</th>
                <th className="px-5 py-2.5 font-medium">By</th>
                <th className="px-5 py-2.5 font-medium">Valid</th>
              </tr>
            </thead>
            <tbody>
              {decisionRows.map((d) => (
                <tr key={d.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-5 py-2.5 font-mono text-xs text-ink-tertiary">{d.row_key}</td>
                  <td className="px-5 py-2.5 text-ink-secondary">{fmtDate(d.decided_at)}</td>
                  <td className="px-5 py-2.5 text-ink">{d.title}</td>
                  <td className="px-5 py-2.5 text-ink-secondary">{d.decided_by || "—"}</td>
                  <td className="px-5 py-2.5">
                    {d.still_valid ? (
                      <CircleCheck className="size-4 text-emerald-600" />
                    ) : (
                      <CircleX className="size-4 text-red" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
