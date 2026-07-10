import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { activateInvitedMembership } from "@/lib/auth/pg-login";
import { TeamNav, type NavEntry, type NavLeaf } from "@/components/team-nav";
import { SignOutButton } from "@/components/account/sign-out-button";

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
  const db = await serverClient();

  const user = await getSessionUser();
  if (!user) return <NoTeamScreen slug={teamSlug} />;

  // Membership is enforced below via the `me` lookup (app-code access control).
  const { data: team } = await db
    .from("teams")
    .select("id, slug, name")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return <NoTeamScreen slug={teamSlug} />;

  const { data: me } = await db
    .from("members")
    .select("id, role, display_name, tier, status")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .neq("status", "disabled")
    .maybeSingle();
  if (!me) return <NoTeamScreen slug={teamSlug} />;
  // Team-scoped activation, deferred half: signing in never activates memberships in teams the
  // login carried no context for (see linkMemberByEmail) — the invited row flips to active here,
  // on the member's own first visit to this team.
  if (me.status === "invited") await activateInvitedMembership(team.id, user.id);

  const base = `/t/${team.slug}`;

  // Settings groups the low-frequency config surfaces; Admin is appended only for admins.
  const settingsChildren: NavLeaf[] = [
    { icon: "account", label: "Account", href: `${base}/account` },
    { icon: "teamtools", label: "Team tools", href: `${base}/team-tools` },
  ];
  if (me.role === "admin") {
    settingsChildren.push({ icon: "admin", label: "Admin", href: `${base}/admin` });
  }

  // Lean primary IA (2026-07-10, product call). Removed from the left nav — routes still resolve by
  // direct URL, only the nav entry was cut: "Tasks" (/tasks), "Maturity" (/maturity), "Decisions"
  // (/decisions, empty + unused). "Data" moved under Admin → Data (verification/debug view, now
  // admin-gated). The "Work" group is dropped (nothing left in it; Projects stays commented out).
  // "Meetings" stays a top-level entry — a new, actively-used surface, not part of the trim.
  const items: NavEntry[] = [
    { icon: "home", label: "Home", href: base, exact: true },
    { icon: "codebases", label: "Codebases", href: `${base}/codebases` },
    { icon: "meetings", label: "Meetings", href: `${base}/meetings` },
    { icon: "learning", label: "Learning", href: `${base}/learning` },
    { icon: "query", label: "Query", href: `${base}/query` },
    { label: "Settings", children: settingsChildren },
  ];

  return (
    <div className="flex min-h-dvh flex-1 bg-surface-raised">
      <aside className="frosted sticky top-0 flex h-dvh w-60 shrink-0 flex-col border-r border-border-subtle px-4 py-6">
        <div className="mb-8 px-3">
          <p className="font-display text-[11px] uppercase tracking-[0.18em] text-gradient-prism">
            Team Brain
          </p>
          <h2 className="mt-1 truncate font-display text-lg text-ink" title={team.name}>
            {team.name}
          </h2>
        </div>
        <TeamNav items={items} />
        <div className="mt-auto border-t border-border-subtle px-3 pt-4">
          <p className="truncate text-sm font-medium text-ink">{me.display_name}</p>
          <p className="text-xs capitalize text-ink-tertiary">
            {me.role} · {me.tier} tier
          </p>
          <div className="mt-2">
            <SignOutButton />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-8">{children}</main>
    </div>
  );
}
