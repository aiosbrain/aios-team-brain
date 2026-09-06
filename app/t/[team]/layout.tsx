import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { activateInvitedMembership } from "@/lib/auth/pg-login";
import { resolveTeamContext } from "@/lib/auth/team-context";
import { TeamNav } from "@/components/team-nav";
import { buildNavItems } from "@/lib/dashboard/nav-items";
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

  // Shared, request-scoped auth: one collapsed query, memoized so the page rendered as `children`
  // this request reuses it instead of re-resolving team + member itself.
  const ctx = await resolveTeamContext(teamSlug);
  if (!ctx) return <NoTeamScreen slug={teamSlug} />;
  const { team, me } = ctx;
  // Team-scoped activation, deferred half: signing in never activates memberships in teams the
  // login carried no context for (see linkMemberByEmail) — the invited row flips to active here,
  // on the member's own first visit to this team.
  if (me.status === "invited") await activateInvitedMembership(team.id, ctx.userId);

  const base = `/t/${team.slug}`;

  const items = buildNavItems({ base, role: me.role });

  return (
    <div className="flex min-h-dvh flex-1 bg-surface-raised">
      {/* `data-staging-offset`: on staging the banner publishes `--staging-banner-h` and this shifts
          down by exactly that, so the sidebar's footer stays on screen. Off staging the var is unset
          and the fallback `0px` keeps today's behaviour byte-for-byte. */}
      <aside
        data-staging-offset
        className="frosted sticky top-[var(--staging-banner-h,0px)] flex h-[calc(100dvh-var(--staging-banner-h,0px))] w-60 shrink-0 flex-col border-r border-border-subtle px-4 py-6"
      >
        {/* No AIOS lockup here on purpose. This is the team's workspace, so the team name is
            the subject and AIOS is the tool it runs on — the mark lives in the favicon, the way
            Slack keeps its own logo out of a workspace sidebar. If this sidebar ever gains a
            collapsed state, collapse to the bare mark in currentColor (DESIGN.md § Brand & Logo). */}
        <div className="mb-8 px-3">
          <p className="font-display text-[10px] uppercase tracking-[0.18em] text-ink-tertiary">
            Team Brain
          </p>
          <h2 className="mt-1.5 truncate font-display text-lg text-ink" title={team.name}>
            {team.name}
          </h2>
        </div>
        <TeamNav items={items} />
        <div className="mt-auto border-t border-border-subtle px-3 pt-4">
          <p className="truncate text-sm font-medium text-ink">{me.displayName}</p>
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
