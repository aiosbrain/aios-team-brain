import type { Metadata } from "next";
import { Blocks } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { visibleItems } from "@/lib/auth/visibility";
import { EmptyState } from "@/components/empty-state";
import { timeAgo } from "@/components/format";

export const metadata: Metadata = { title: "Team Tools" };

type BlueprintItem = { body: string | null; actor: string; updated_at: string; frontmatter: Record<string, unknown> | null };
type Connector = { enabled?: boolean; name?: string; transport?: string; instance?: Record<string, string> };

export default async function TeamToolsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  // Latest published blueprint for the team; tier-filtered in app code (no RLS in pg mode).
  const { data } = await visibleItems(
    db
      .from("items")
      .select("body, actor, updated_at, frontmatter")
      .eq("team_id", team.id)
      .eq("kind", "blueprint")
      .order("updated_at", { ascending: false })
      .limit(1),
    me?.tier ?? "external"
  ).maybeSingle();
  const bp = data as BlueprintItem | null;

  let connectors: Array<[string, Connector]> = [];
  let publishedBy = bp?.actor || "";
  if (bp?.body) {
    try {
      const parsed = JSON.parse(bp.body) as { connectors?: Record<string, Connector>; published_by?: string };
      connectors = Object.entries(parsed.connectors || {}).filter(([, c]) => c.enabled);
      publishedBy = parsed.published_by || publishedBy;
    } catch { /* malformed blueprint */ }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Team tools</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          The integrations your team uses. Each person connects these in their own workspace with
          their own credentials — keys never leave their machine, and are never sent here.
        </p>
      </div>

      {connectors.length === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No team tools published yet"
          action="A team lead publishes the tool set from their AIOS Workspace (Team tab → Publish). It'll appear here for everyone to connect."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {connectors.map(([id, c]) => (
              <div key={id} className="prism-card flex flex-col gap-2 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{c.name || id}</span>
                  {c.transport ? <span className="text-[11px] uppercase tracking-wider text-ink-tertiary">{c.transport === "skill" ? "direct API" : c.transport}</span> : null}
                </div>
                {c.instance && Object.keys(c.instance).length > 0 && (
                  <p className="break-all font-mono text-[11px] text-ink-tertiary">
                    {Object.values(c.instance).join(" · ")}
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-ink-tertiary">
            {connectors.length} tool{connectors.length === 1 ? "" : "s"}
            {publishedBy ? ` · published by @${publishedBy}` : ""}
            {bp ? ` · ${timeAgo(bp.updated_at)}` : ""}
          </p>
        </>
      )}
    </div>
  );
}
