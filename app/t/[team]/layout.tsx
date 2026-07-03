import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { serverClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { isPostgresBackend } from "@/lib/db/backend";
import { TeamNav, type NavEntry, type NavLeaf } from "@/components/team-nav";

function NoTeamScreen({ slug }: { slug: string }) {
  return (
    <main className="flex flex-1 items-center justify-center bg-surface-raised px-6">
      <div className="prism-card flex max-w-md flex-col items-center gap-3 px-8 py-12 text-center">
        <CircleAlert className="size-8 text-violet" strokeWidth={1.5} />
        <h1 className="text-xl font-semibold text-ink">No team here for you</h1>
        <p className="text-sm text-ink-secondary">
          Either <span className="font-mono text-xs">{slug}</span> doesn&apos;t exist or you&apos;re
          not a member yet. Team Brain is invite-only — ask your team admin to add your email,
          then sign in again.
        </p>
        <Link href="/login" className="btn-ghost mt-2">
          Back to sign in
        </Link>
      </div>
    </main>
  );
}

export default async function TeamLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ team: string }>;
}) {
  const { team: teamSlug } = await params;
  const supabase = await serverClient();

  const user = await getSessionUser();
  if (!user) return <NoTeamScreen slug={teamSlug} />;

  // RLS: this returns a row only if the signed-in user is an active member.
  const { data: team } = await supabase
    .from("teams")
    .select("id, slug, name")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return <NoTeamScreen slug={teamSlug} />;

  const { data: me } = await supabase
    .from("members")
    .select("id, role, display_name, tier")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return <NoTeamScreen slug={teamSlug} />;

  const base = `/t/${team.slug}`;

  // Settings groups the low-frequency config surfaces; Admin is appended only for admins.
  const settingsChildren: NavLeaf[] = [
    { icon: "teamtools", label: "Team tools", href: `${base}/team-tools` },
  ];
  if (me.role === "admin") {
    settingsChildren.push({ icon: "admin", label: "Admin", href: `${base}/admin` });
  }

  // Grouped IA: ~6 primary entries. "Work" gathers the operational surfaces; Skills folds
  // into Data (reached at /library/skills, not a top-level peer). Codebase analytics
  // live only on the postgres backend (canonical schema).
  const items: NavEntry[] = [
    { icon: "home", label: "Home", href: base, exact: true },
    {
      label: "Work",
      children: [
        { icon: "tasks", label: "Tasks", href: `${base}/tasks` },
        // Projects hidden for now — the tab currently surfaces ingestion namespaces (slack, commits,
        // github-*, …) rather than human work-projects. Unhide once it shows real projects.
        // { icon: "projects", label: "Projects", href: `${base}/projects` },
        { icon: "decisions", label: "Decisions", href: `${base}/decisions` },
      ],
    },
    { icon: "library", label: "Data", href: `${base}/library` },
  ];
  if (isPostgresBackend()) {
    items.push({ icon: "codebases", label: "Codebases", href: `${base}/codebases` });
    items.push({ icon: "maturity", label: "Maturity", href: `${base}/maturity` });
  }
  items.push({ icon: "learning", label: "Learning", href: `${base}/learning` });
  items.push({ icon: "query", label: "Query", href: `${base}/query` });
  items.push({ label: "Settings", children: settingsChildren });

  return (
    <div className="flex min-h-dvh flex-1 bg-surface-raised">
      <aside className="frosted sticky top-0 flex h-dvh w-60 shrink-0 flex-col border-r border-border-subtle px-4 py-6">
        <div className="mb-8 px-3">
          <p className="font-display text-[11px] font-semibold uppercase tracking-[0.18em] text-gradient-prism">
            Team Brain
          </p>
          <h2 className="mt-1 truncate font-display text-lg font-semibold text-ink" title={team.name}>
            {team.name}
          </h2>
        </div>
        <TeamNav items={items} />
        <div className="mt-auto border-t border-border-subtle px-3 pt-4">
          <p className="truncate text-sm font-medium text-ink">{me.display_name}</p>
          <p className="text-xs capitalize text-ink-tertiary">
            {me.role} · {me.tier} tier
          </p>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-8">{children}</main>
    </div>
  );
}
