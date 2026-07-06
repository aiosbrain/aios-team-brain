import type { Metadata } from "next";
import Link from "next/link";
import { Blocks } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { visibleItems } from "@/lib/auth/visibility";
import { TierBadge } from "@/components/tier-badge";
import { EmptyState } from "@/components/empty-state";
import { CopySnippet } from "@/components/copy-snippet";
import { timeAgo } from "@/components/format";

export const metadata: Metadata = { title: "Skills" };

type SkillItem = {
  id: string;
  path: string;
  access: string;
  actor: string;
  synced_at: string;
  frontmatter: Record<string, unknown> | null;
  body: string | null;
  projects: { slug: string } | null;
};

function clamp(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 200 ? t.slice(0, 197) + "…" : t;
}

// Derive a human description from the shared SKILL.md body (frontmatter `description:`,
// handling inline + |/> block scalars; else the first heading/paragraph).
function describe(body: string | null): string {
  if (!body) return "";
  const fm = body.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const lines = fm[1].split("\n");
    const i = lines.findIndex((l) => /^description:/.test(l));
    if (i !== -1) {
      const inline = lines[i].replace(/^description:\s*/, "");
      if (inline && !/^[|>]\s*$/.test(inline)) return clamp(inline.replace(/^["']|["']$/g, ""));
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\S/.test(lines[j])) break; // next top-level key
        block.push(lines[j]);
      }
      if (block.length) return clamp(block.join(" "));
    }
  }
  const afterFm = fm ? body.slice(fm[0].length) : body;
  const line = afterFm.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean);
  return line ? clamp(line) : "";
}

function skillName(it: SkillItem): string {
  const fm = it.frontmatter as { skill?: string } | null;
  if (fm?.skill) return fm.skill;
  const m = it.path.match(/\.claude\/skills\/([^/]+)\//);
  return m ? m[1] : it.path;
}

function refCount(it: SkillItem): number {
  const fm = it.frontmatter as { manifest?: { references?: unknown[] } } | null;
  return fm?.manifest?.references?.length ?? 0;
}

export default async function SkillsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  const { data: items } = await visibleItems(
    db
      .from("items")
      .select("id, path, access, actor, synced_at, frontmatter, body, projects(slug)")
      .eq("team_id", team.id)
      .eq("kind", "skill")
      .order("synced_at", { ascending: false })
      .limit(200),
    me?.tier ?? "external"
  );
  const skills = (items ?? []) as unknown as SkillItem[];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Skills</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Shared skills your team has published to the brain. Pull one into your workspace,
          review it, then install — pulled skills are executable code and never auto-activate.
        </p>
      </div>

      {skills.length === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No shared skills yet"
          action="Publish one from a workspace with `aios push skill <name>` — its SKILL.md and reference files land here for the team to pull."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {skills.map((it) => {
            const name = skillName(it);
            const fm = it.frontmatter as { source_project?: string; source_actor?: string } | null;
            return (
              <div key={it.id} className="prism-card flex flex-col gap-3 px-5 py-4">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/t/${teamSlug}/library/${it.id}`} className="font-mono text-sm font-semibold text-ink hover:text-violet">
                    {name}
                  </Link>
                  <TierBadge tier={it.access} />
                </div>
                <p className="text-[13px] leading-relaxed text-ink-secondary">{describe(it.body)}</p>
                <CopySnippet text={`aios pull skill ${name}`} />
                <p className="mt-auto flex items-center justify-between text-[11px] text-ink-tertiary">
                  <span>
                    {refCount(it)} reference file{refCount(it) === 1 ? "" : "s"}
                    {fm?.source_project ? ` · from ${fm.source_project}` : ""}
                    {fm?.source_actor ? ` · @${fm.source_actor}` : ""}
                  </span>
                  <span>{timeAgo(it.synced_at)}</span>
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
