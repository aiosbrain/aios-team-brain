import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { getMemberProfile } from "@/lib/metrics/codebases";
import { getMemberContext } from "@/lib/identity/context";
import { getMemberAvatar } from "@/lib/identity/profile";
import { parseRange } from "@/lib/metrics/range";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { CommitHeatmap } from "@/components/codebases/commit-heatmap";
import { MemberContextPanel } from "@/components/people/member-context";
import { ContextEditor } from "@/components/people/context-editor";
import { MyApiKeys, type MyKeyRow } from "@/components/people/my-api-keys";
import { MemberAvatar } from "@/components/people/member-avatar";
import { AvatarUpload } from "@/components/people/avatar-upload";

export const metadata: Metadata = { title: "Profile" };

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="prism-card px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-ink-tertiary">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink">{value}</p>
    </div>
  );
}

export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string; handle: string }>;
  searchParams: Promise<{ range?: string }>;
}) {

  const { team: teamSlug, handle } = await params;
  const range = parseRange((await searchParams).range);
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;
  const me = await currentMember(team.id);
  if (!me) return null;

  const decodedHandle = decodeURIComponent(handle);
  const p = await getMemberProfile(db, team.id, decodedHandle, range, me.tier);

  if (!p) {
    // getMemberProfile gates on canSeeCodebases(tier) — an external-tier member (a client/
    // consultant collaborator) can't see codebase contribution stats, so it returns null even
    // for their OWN handle. That's the correct tier gate for commit metrics, but it must not
    // also block them from managing their own API key — resolve "is this actually me" directly
    // against the members table, independent of the tier-gated profile query.
    const { data: meRow } = await db
      .from("members")
      .select("actor_handle, github_login")
      .eq("id", me.id)
      .maybeSingle();
    const m = meRow as { actor_handle: string | null; github_login: string | null } | null;
    const lc = decodedHandle.toLowerCase();
    const isSelfByHandle =
      me.id === decodedHandle ||
      m?.actor_handle?.toLowerCase() === lc ||
      m?.github_login?.toLowerCase() === lc;

    if (!isSelfByHandle) notFound();

    const { data: keyRows } = await db
      .from("api_keys")
      .select("id, key_id, name, created_at, last_used_at, revoked_at")
      .eq("team_id", team.id)
      .eq("member_id", me.id)
      .order("created_at", { ascending: false });

    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        <h1 className="font-display text-2xl font-semibold text-ink">Your account</h1>
        <MyApiKeys teamSlug={teamSlug} keys={(keyRows ?? []) as MyKeyRow[]} />
      </div>
    );
  }

  const context = await getMemberContext(db, team.id, p.member_id, me.tier);
  const canEdit = !!context && (me.id === p.member_id || me.role === "admin");
  const isSelf = me.id === p.member_id;

  const avatarPerson = {
    displayName: p.name,
    avatarUrl: p.avatar_url,
    avatarDataUrl: await getMemberAvatar(db, p.member_id),
  };

  let myKeys: MyKeyRow[] = [];
  if (isSelf) {
    const { data } = await db
      .from("api_keys")
      .select("id, key_id, name, created_at, last_used_at, revoked_at")
      .eq("team_id", team.id)
      .eq("member_id", me.id)
      .order("created_at", { ascending: false });
    myKeys = (data ?? []) as MyKeyRow[];
  }

  const aiPct = p.totals.commits ? Math.round((100 * p.totals.ai_commits) / p.totals.commits) : 0;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div>
        <Link
          href={`/t/${teamSlug}/codebases`}
          className="inline-flex items-center gap-1 text-xs text-ink-tertiary hover:text-ink-secondary"
        >
          <ArrowLeft className="size-3" /> Codebases
        </Link>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {canEdit ? (
              <AvatarUpload teamSlug={teamSlug} memberId={p.member_id} person={avatarPerson} />
            ) : (
              <MemberAvatar person={avatarPerson} size={56} />
            )}
            <div>
              <h1 className="font-display text-2xl text-ink">{p.name}</h1>
              <div className="mt-0.5 flex items-center gap-3 text-xs text-ink-tertiary">
                <span className="capitalize">{p.role}</span>
                {p.github_login ? (
                  <a
                    href={`https://github.com/${p.github_login}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-violet"
                  >
                    @{p.github_login}
                  </a>
                ) : null}
              </div>
            </div>
          </div>
          <RangeSelector value={range} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Commits" value={p.totals.commits} />
        <Stat label="AI-assisted" value={`${aiPct}%`} />
        <Stat label="Active days" value={p.totals.active_days} />
        <Stat label="Repos" value={p.repos.length} />
      </div>

      {context ? <MemberContextPanel context={context} /> : null}
      {canEdit && context ? (
        <ContextEditor teamSlug={teamSlug} memberId={p.member_id} context={context} />
      ) : null}
      {isSelf ? <MyApiKeys teamSlug={teamSlug} keys={myKeys} /> : null}

      <section className="prism-card flex flex-col gap-3 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Commit activity (all repos)
        </h2>
        <CommitHeatmap days={p.days} />
      </section>

      {p.repos.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
            By codebase
          </h2>
          <div className="prism-card divide-y divide-border-subtle">
            {p.repos.map((r) => (
              <Link
                key={r.slug}
                href={`/t/${teamSlug}/codebases/${r.slug}/contributors/m:${p.member_id}`}
                className="flex items-center justify-between px-4 py-3 text-sm hover:bg-surface-card-hover"
              >
                <span className="font-medium text-ink">{r.slug}</span>
                <span className="text-ink-secondary">
                  {r.commits} commits
                  <span className="ml-2 text-ink-tertiary">
                    {r.commits ? Math.round((100 * r.ai_commits) / r.commits) : 0}% AI
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
