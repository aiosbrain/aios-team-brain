"use server";

import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { slugify } from "@/lib/ids";

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
}

/**
 * Create a project from the dashboard. A project is the container Tasks/Decisions
 * hang off, so this unblocks a freshly-cleaned brain (no `aios push` required to get
 * started). Idempotent identity is the `(team_id, slug)` unique constraint — a slug
 * that already exists (e.g. from a prior push) is reported back, not silently merged.
 */
export async function createProjectAction(input: {
  teamId: string;
  name: string;
}): Promise<{ ok: boolean; project?: ProjectRow; error?: string }> {
  const name = input.name.trim();
  const slug = slugify(name);
  if (!name || !slug) return { ok: false, error: "a project name is required" };

  const me = await currentMember(input.teamId);
  if (!me) return { ok: false, error: "not a member of this team" };

  const db = await serverClient();
  // Spec §11/Part II: dashboard-created projects are 'initiative' (ingestion containers are
  // 'source'; the two §11 built-ins are 'system'). This is also what makes the bootstrap's
  // source-only adoption safe: a human creating "General" here mints an initiative, which the
  // bootstrap REFUSES to adopt instead of silently granting it Everyone-visibility
  // (slice-3 Codex High).
  const { data, error } = await db
    .from("projects")
    .insert({ team_id: input.teamId, slug, name, kind: "initiative" })
    .select("id, slug, name")
    .single();
  if (error || !data) {
    if (/duplicate key|unique constraint/i.test(error?.message ?? "")) {
      // Converge the existing row's pointer before refusing (review Medium 3b): if a prior attempt
      // created the row and then failed its pointer write, the retry would otherwise land here
      // forever with the project permanently unpointed — dark under PCCC-6's fail-closed read.
      const { data: existing } = await db
        .from("projects")
        .select("id")
        .eq("team_id", input.teamId)
        .eq("slug", slug)
        .maybeSingle();
      if (existing) {
        await ensureProjectGraphPointer(db, { teamId: input.teamId, projectId: (existing as ProjectRow).id });
      }
      return { ok: false, error: `a project "${slug}" already exists` };
    }
    return { ok: false, error: error?.message ?? "could not create project" };
  }
  // PCCC-4: every creation path records the project's graph partition pointer.
  const ptr = await ensureProjectGraphPointer(db, { teamId: input.teamId, projectId: (data as ProjectRow).id });
  if (!ptr.ok) return { ok: false, error: ptr.error };
  return { ok: true, project: data as ProjectRow };
}
