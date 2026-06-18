"use server";

import { serverClient } from "@/lib/supabase/server";
import { currentMember } from "@/lib/auth/guard";
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

  const supabase = await serverClient();
  const { data, error } = await supabase
    .from("projects")
    .insert({ team_id: input.teamId, slug, name })
    .select("id, slug, name")
    .single();
  if (error || !data) {
    if (/duplicate key|unique constraint/i.test(error?.message ?? "")) {
      return { ok: false, error: `a project "${slug}" already exists` };
    }
    return { ok: false, error: error?.message ?? "could not create project" };
  }
  return { ok: true, project: data as ProjectRow };
}
