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
        const heal = await ensureProjectGraphPointer(db, { teamId: input.teamId, projectId: (existing as ProjectRow).id });
        // A failing heal must not hide behind the duplicate-name error (Codex Medium 3): a
        // half-created project would otherwise stay unpointed forever with every retry reading
        // "already exists" — dark under PCCC-6's fail-closed read, invisible to the operator.
        if (!heal.ok) {
          return { ok: false, error: `a project "${slug}" already exists — and its graph pointer is unhealed: ${heal.error}` };
        }
        // ENFB-2 D1, REVISED at the Fable diff review (HIGH 1): the duplicate arm must grant
        // NOTHING. The drafted "converge on an empty initiative" heal keyed the grant on the
        // CALLER, and `projects` records no creator — so ANY member re-submitting a known or
        // guessed name would have granted THEMSELVES onto a stranger's restricted container
        // (a project grant is an item-membership grant; everything later curated in would have
        // served them). A creator stranded by a crash between insert and grant retries into
        // "already exists" without visibility — rare, and the repair is the deliberate,
        // audited admin grant path (the ENFB-1 self-grant shape), not a self-service arm.
      }
      return { ok: false, error: `a project "${slug}" already exists` };
    }
    return { ok: false, error: error?.message ?? "could not create project" };
  }
  // ENFB-2 D1: the creator grant fires BEFORE the pointer write (round-2 blocker 4 ordering:
  // a pointer failure must not strand a granted-less row), and only on this fresh-insert path
  // where the row is BY CONSTRUCTION an empty initiative this member just minted. Without it,
  // §2.1 row-visibility would hide the new project from its own creator everywhere (the
  // round-1 dead-UI-path blocker). Grant failure is LOUD: a created-but-ungranted initiative
  // is invisible to its creator, which is exactly the stranding this exists to prevent.
  const grant = await grantProjectToCreator(db, input.teamId, (data as ProjectRow).id, me.id);
  if (!grant.ok) {
    return { ok: false, error: `project created but the creator grant failed (${grant.error}) — an admin can repair it with: admin.ts grant-project <your-person-group> ${slug}` };
  }
  // PCCC-4: every creation path records the project's graph partition pointer.
  const ptr = await ensureProjectGraphPointer(db, { teamId: input.teamId, projectId: (data as ProjectRow).id });
  if (!ptr.ok) return { ok: false, error: ptr.error };
  return { ok: true, project: data as ProjectRow };
}

/** The D1 grant: creator's person singleton → the project, through the sole-writer group
 *  module (lib/access/groups is the only legal writer of groups/group_members/project_groups). */
async function grantProjectToCreator(
  db: Awaited<ReturnType<typeof serverClient>>,
  teamId: string,
  projectId: string,
  creatorId: string
): Promise<{ ok: boolean; error?: string }> {
  const { ensurePersonSingleton, grantProjectToGroup } = await import("@/lib/access/groups");
  const singleton = await ensurePersonSingleton(db, teamId, creatorId, creatorId);
  if (!singleton.ok || !singleton.groupId) return { ok: false, error: singleton.error ?? "no singleton" };
  const granted = await grantProjectToGroup(db, teamId, projectId, singleton.groupId, creatorId);
  if (!granted.ok) return { ok: false, error: granted.error };
  return { ok: true };
}

