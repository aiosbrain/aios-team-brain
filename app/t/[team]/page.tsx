import Link from "next/link";
import { AlertTriangle, FileText, Rocket, Search, Users } from "lucide-react";
import { serverClient } from "@/lib/supabase/server";
import { KindBadge } from "@/components/kind-badge";
import { CopySnippet } from "@/components/copy-snippet";
import { timeAgo, truncate } from "@/components/format";

type ActivityItem = {
  id: string;
  path: string;
  kind: string;
  actor: string;
  synced_at: string;
  projects: { slug: string } | null;
};

type TaskRow = { id: string; title: string; assignee: string; status: string };

type Commitment = {
  id: string;
  entity_id: string;
  name: string;
  attrs: Record<string, unknown>;
};

const COMMITMENT_BADGE: Record<string, string> = {
  open: "bg-blue/8 text-blue border-blue/25",
  at_risk: "bg-amber/10 text-amber-700 border-amber/30",
  overdue: "bg-red/8 text-red border-red/25",
  broken: "bg-red/15 text-red border-red/40",
};

const STATUS_LABEL: Record<string, string> = {
  in_progress: "in progress",
  blocked: "blocked",
  ready: "ready",
};

function SetupChecklist({ teamSlug }: { teamSlug: string }) {
  const steps = [
    <span key="1">
      Invite your team in{" "}
      <Link href={`/t/${teamSlug}/admin/members`} className="text-violet underline underline-offset-2">
        Admin → Members
      </Link>
    </span>,
    <span key="2">
      Issue an API key in{" "}
      <Link href={`/t/${teamSlug}/admin/keys`} className="text-violet underline underline-offset-2">
        Admin → Keys
      </Link>
    </span>,
    <span key="3">
      Run <code className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-xs">aios push</code>{" "}
      from your project repo
    </span>,
    <span key="4">
      Ask your first question in{" "}
      <Link href={`/t/${teamSlug}/query`} className="text-violet underline underline-offset-2">
        Query
      </Link>
    </span>,
  ];

  return (
    <div className="bg-gradient-prism rounded-2xl p-[1px]">
      <div className="rounded-2xl bg-surface-inset px-8 py-10">
        <div className="mb-4 flex items-center gap-3">
          <Rocket className="size-6 text-violet" strokeWidth={1.5} />
          <h2 className="text-xl font-semibold text-ink">Get your team brain online</h2>
        </div>
        <p className="mb-6 text-sm text-ink-secondary">
          Nothing has been synced yet. Four steps and your team&apos;s memory starts compounding:
        </p>
        <ol className="mb-6 flex flex-col gap-3">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-sm text-ink-secondary">
              <span className="bg-gradient-prism mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <CopySnippet text="export AIOS_API_KEY=aios_…_… && aios push" />
      </div>
    </div>
  );
}

export default async function TeamHome({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const supabase = await serverClient();

  const { data: team } = await supabase
    .from("teams")
    .select("id, name")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null; // layout already rendered the no-team screen

  const { count: itemCount } = await supabase
    .from("items")
    .select("id", { count: "exact", head: true })
    .eq("team_id", team.id);

  if (!itemCount) {
    return (
      <div className="mx-auto max-w-3xl pt-8">
        <h1 className="mb-6 text-2xl font-semibold text-ink">Home</h1>
        <SetupChecklist teamSlug={teamSlug} />
      </div>
    );
  }

  const [{ data: activity }, { data: openTasks }, { data: commitments }, { data: transcripts }] =
    await Promise.all([
      supabase
        .from("items")
        .select("id, path, kind, actor, synced_at, projects(slug)")
        .eq("team_id", team.id)
        .order("synced_at", { ascending: false })
        .limit(15),
      supabase
        .from("tasks")
        .select("id, title, assignee, status")
        .eq("team_id", team.id)
        .in("status", ["in_progress", "blocked", "ready"])
        .order("updated_at", { ascending: false })
        .limit(200),
      supabase
        .from("graph_entities")
        .select("id, entity_id, name, attrs")
        .eq("team_id", team.id)
        .eq("entity_type", "commitment")
        .in("attrs->>status", ["open", "overdue", "at_risk", "broken"])
        .limit(20),
      supabase
        .from("items")
        .select("id, path, actor, synced_at, projects(slug)")
        .eq("team_id", team.id)
        .eq("kind", "transcript")
        .order("synced_at", { ascending: false })
        .limit(5),
    ]);

  // group open tasks by assignee
  const byAssignee = new Map<string, TaskRow[]>();
  for (const t of (openTasks ?? []) as TaskRow[]) {
    const key = t.assignee || "unassigned";
    byAssignee.set(key, [...(byAssignee.get(key) ?? []), t]);
  }
  const assignees = [...byAssignee.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-ink">Home</h1>
      </div>

      {/* Query box → ./query?q=… */}
      <form action={`/t/${teamSlug}/query`} method="get" className="prism-card prism-card-hover flex items-center gap-3 px-4 py-3">
        <Search className="size-4 shrink-0 text-violet" />
        <input
          type="text"
          name="q"
          placeholder={`Ask ${team.name}'s brain anything…`}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-tertiary"
        />
        <button type="submit" className="btn-prism !py-1.5">
          Ask
        </button>
      </form>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Activity feed */}
        <section className="prism-card px-5 py-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
            Recent activity
          </h2>
          <ul className="divide-y divide-border-subtle">
            {((activity ?? []) as unknown as ActivityItem[]).map((it) => (
              <li key={it.id} className="flex items-center gap-3 py-2.5">
                <KindBadge kind={it.kind} />
                <Link
                  href={`/t/${teamSlug}/library/${it.id}`}
                  className="min-w-0 flex-1 truncate font-mono text-xs text-ink hover:text-violet"
                  title={it.path}
                >
                  {it.path}
                </Link>
                <span className="hidden shrink-0 text-xs text-ink-tertiary sm:inline">
                  {it.actor || "—"} · {it.projects?.slug ?? "—"}
                </span>
                <span className="shrink-0 text-xs text-ink-tertiary">{timeAgo(it.synced_at)}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="flex flex-col gap-6">
          {/* Commitments at risk */}
          <section className="prism-card px-5 py-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
              <AlertTriangle className="size-3.5 text-amber" /> Commitments at risk
            </h2>
            {(commitments ?? []).length === 0 ? (
              <p className="text-sm text-ink-tertiary">No open or at-risk commitments.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {((commitments ?? []) as Commitment[]).map((c) => {
                  const status = String(c.attrs?.status ?? "open");
                  const badge = COMMITMENT_BADGE[status] ?? COMMITMENT_BADGE.open;
                  return (
                    <li key={c.id} className="flex items-start justify-between gap-2">
                      <span className="text-sm text-ink-secondary">
                        {truncate(c.name || String(c.attrs?.description ?? c.entity_id), 70)}
                      </span>
                      <span
                        className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge}`}
                      >
                        {status.replace("_", " ")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Recent transcripts */}
          <section className="prism-card px-5 py-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
              <FileText className="size-3.5 text-blue" /> Recent transcripts
            </h2>
            {(transcripts ?? []).length === 0 ? (
              <p className="text-sm text-ink-tertiary">No transcripts synced yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {((transcripts ?? []) as unknown as ActivityItem[]).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2">
                    <Link
                      href={`/t/${teamSlug}/library/${t.id}`}
                      className="min-w-0 truncate font-mono text-xs text-ink hover:text-violet"
                      title={t.path}
                    >
                      {t.path.split("/").pop()}
                    </Link>
                    <span className="shrink-0 text-xs text-ink-tertiary">{timeAgo(t.synced_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {/* Open tasks by member */}
      <section className="prism-card px-5 py-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          <Users className="size-3.5 text-violet" /> Open tasks by member
        </h2>
        {assignees.length === 0 ? (
          <p className="text-sm text-ink-tertiary">
            No tasks in flight —{" "}
            <Link href={`/t/${teamSlug}/tasks`} className="text-violet underline underline-offset-2">
              open the board
            </Link>{" "}
            to plan the sprint.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {assignees.map(([assignee, tasks]) => (
              <div key={assignee} className="rounded-lg border border-border-subtle bg-surface-inset px-4 py-3">
                <p className="mb-2 flex items-center justify-between text-sm font-semibold text-ink">
                  {assignee}
                  <span className="text-xs font-normal text-ink-tertiary">{tasks.length}</span>
                </p>
                <ul className="flex flex-col gap-1.5">
                  {tasks.slice(0, 5).map((t) => (
                    <li key={t.id} className="flex items-center gap-2 text-xs text-ink-secondary">
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${
                          t.status === "blocked"
                            ? "bg-red"
                            : t.status === "in_progress"
                              ? "bg-violet"
                              : "bg-cyan"
                        }`}
                        title={STATUS_LABEL[t.status] ?? t.status}
                      />
                      <span className="truncate">{t.title}</span>
                    </li>
                  ))}
                  {tasks.length > 5 ? (
                    <li className="text-xs text-ink-tertiary">+{tasks.length - 5} more</li>
                  ) : null}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
