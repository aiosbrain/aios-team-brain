import Link from "next/link";
import { notFound } from "next/navigation";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { canSeeAccess } from "@/lib/auth/visibility";
import { Markdown } from "@/components/markdown";
import { KindBadge } from "@/components/kind-badge";
import { TierBadge } from "@/components/tier-badge";
import { fmtDate, timeAgo } from "@/components/format";

export default async function LibraryItemPage({
  params,
}: {
  params: Promise<{ team: string; itemId: string }>;
}) {
  const { team: teamSlug, itemId } = await params;
  const supabase = await serverClient();

  const { data: team } = await supabase
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const { data: item } = await supabase
    .from("items")
    .select(
      "id, path, kind, access, body, content_sha256, actor, synced_at, updated_at, projects(slug), members(display_name), item_versions(count)"
    )
    .eq("team_id", team.id)
    .eq("id", itemId)
    .maybeSingle();
  // Tier check (no RLS backstop in postgres mode): hide above-tier items as 404.
  const me = await currentMember(team.id);
  if (!item || !canSeeAccess(me?.tier ?? "external", item.access as string)) notFound();

  const project = item.projects as unknown as { slug: string } | null;
  const member = item.members as unknown as { display_name: string } | null;
  const versionCount =
    (item.item_versions as unknown as { count: number }[] | null)?.[0]?.count ?? 0;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <Link href={`/t/${teamSlug}/library`} className="text-xs text-ink-tertiary hover:text-violet">
          ← Data
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <KindBadge kind={item.kind} />
          <TierBadge tier={item.access} />
        </div>
        <h1 className="mt-2 break-all font-mono text-lg font-semibold text-ink">{item.path}</h1>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_16rem]">
        <article className="prism-card bg-surface-inset px-7 py-6">
          {item.body ? (
            <Markdown>{item.body}</Markdown>
          ) : (
            <p className="text-sm text-ink-tertiary">This item has no body content.</p>
          )}
        </article>

        {/* Provenance panel */}
        <aside className="prism-card h-fit px-5 py-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
            Provenance
          </h2>
          <dl className="flex flex-col gap-3 text-sm">
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-ink-tertiary">Pushed by</dt>
              <dd className="text-ink">
                {member?.display_name ?? "—"}
                {item.actor ? (
                  <span className="ml-1 font-mono text-xs text-ink-tertiary">@{item.actor}</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-ink-tertiary">Project</dt>
              <dd>
                {project?.slug ? (
                  <Link
                    href={`/t/${teamSlug}/projects/${project.slug}`}
                    className="text-violet hover:underline"
                  >
                    {project.slug}
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-ink-tertiary">Path</dt>
              <dd className="break-all font-mono text-xs text-ink-secondary">{item.path}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-ink-tertiary">SHA-256</dt>
              <dd className="font-mono text-xs text-ink-secondary" title={item.content_sha256}>
                {item.content_sha256.slice(0, 16)}…
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-ink-tertiary">Synced</dt>
              <dd className="text-ink-secondary" title={fmtDate(item.synced_at)}>
                {timeAgo(item.synced_at)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-ink-tertiary">Versions</dt>
              <dd className="text-ink-secondary">
                {versionCount} {versionCount === 1 ? "version" : "versions"}
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}
