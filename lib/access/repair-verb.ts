import type { DbClient } from "@/lib/db/types";
import type { RevokeResult } from "@/lib/access/groups";

/**
 * AUDITFIX-21 — the `repair-system-edge` verb's PURE decision layer, plus the IMPORT-SAFE factory
 * that builds its real dependencies.
 *
 * WHY THE FACTORY LIVES HERE AND NOT IN `scripts/admin.ts`. That file USED TO call `main()` at module
 * scope, so importing it to test anything ran the CLI — there was no seam. STAGINGMARK-4 added an
 * argv-guarded entry and an importable `main(argv)`, so the seam now exists; the factory stays here
 * because the consequence below is what actually justifies it, not the import hazard. The consequence a spec review
 * spelled out: a type-correct `resolveGroup: async () => null` satisfies every behavioural criterion
 * about the pure verb while the shipped command stays permanently broken, and nothing would have
 * caught it. The factory is testable against a fake db; a structural guard pins that the CLI arm
 * actually calls it.
 *
 * The writer holds the invariants (authority first, protected-and-unsanctioned only, delete with
 * RETURNING, audit only a real deletion). This layer only resolves names to ids and improves messages.
 */
export interface RepairVerbDeps {
  resolveGroup(groupSlug: string): Promise<{ id: string; slug: string; is_builtin: boolean } | null>;
  resolveProject(projectSlug: string): Promise<{ id: string; kind: string; slug: string } | null>;
  resolveMemberIdByEmail(email: string): Promise<string | null>;
  repair(projectId: string, groupId: string, authorizedByMemberId: string): Promise<RevokeResult>;
}

export interface RepairVerbArgs {
  groupSlug?: string;
  projectSlug?: string;
  actorEmail?: string;
}

export type RepairVerbOutcome = { ok: true; revoked: boolean } | { ok: false; error: string };

export const REPAIR_USAGE =
  "usage: repair-system-edge <group-slug> <project-slug> --actor <admin-email> [--team <id|slug>]";

export async function runRepairSystemEdgeVerb(
  deps: RepairVerbDeps,
  args: RepairVerbArgs
): Promise<RepairVerbOutcome> {
  // A destructive act may not be attributed to nobody — the same D1 rule the revoke verb holds.
  if (!args.groupSlug || !args.projectSlug) return { ok: false, error: REPAIR_USAGE };
  if (!args.actorEmail) {
    return { ok: false, error: `--actor <admin-email> is required — a repair must name the admin who authorized it\n${REPAIR_USAGE}` };
  }

  const group = await deps.resolveGroup(args.groupSlug);
  if (!group) return { ok: false, error: `no group '${args.groupSlug}' on this team` };
  const project = await deps.resolveProject(args.projectSlug);
  if (!project) return { ok: false, error: `no project '${args.projectSlug}' on this team` };
  const authorizedByMemberId = await deps.resolveMemberIdByEmail(args.actorEmail);
  if (!authorizedByMemberId) return { ok: false, error: `no member '${args.actorEmail}' on this team` };

  // No preflight classification here on purpose: the WRITER owns that decision, and a second copy is
  // how the verb and the writer come to disagree — which is the defect this whole slice repairs.
  const r = await deps.repair(project.id, group.id, authorizedByMemberId);
  if (!r.ok) return { ok: false, error: r.error ?? "repair failed" };
  return { ok: true, revoked: r.revoked === true };
}

/**
 * The REAL dependencies. Import-safe: no module-scope side effects, so a test can drive it with a
 * fake `DbClient` and assert the queries actually select the identity the writer needs. Read errors
 * are SURFACED, not swallowed into `null` — the existing revoke wiring drops them, which turns an
 * undetermined read into a confident "no such group".
 */
export function repairVerbDeps(db: DbClient, teamId: string, via: string): RepairVerbDeps {
  return {
    resolveGroup: async (slug) => {
      const { data, error } = await db
        .from("groups")
        .select("id, slug, is_builtin")
        .eq("team_id", teamId)
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw new Error(`group read failed: ${error.message}`);
      return (data as { id: string; slug: string; is_builtin: boolean } | null) ?? null;
    },
    resolveProject: async (slug) => {
      const { data, error } = await db
        .from("projects")
        .select("id, kind, slug")
        .eq("team_id", teamId)
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw new Error(`project read failed: ${error.message}`);
      return (data as { id: string; kind: string; slug: string } | null) ?? null;
    },
    resolveMemberIdByEmail: async (email) => {
      const { data, error } = await db
        .from("members")
        .select("id")
        .eq("team_id", teamId)
        .eq("email", email)
        .maybeSingle();
      if (error) throw new Error(`member read failed: ${error.message}`);
      return (data as { id: string } | null)?.id ?? null;
    },
    repair: async (projectId, groupId, authorizedByMemberId) => {
      const { revokeUnsanctionedSystemEdge } = await import("@/lib/access/groups");
      return revokeUnsanctionedSystemEdge(db, teamId, { projectId, groupId }, {
        kind: "operator",
        authorizedByMemberId,
        via,
      });
    },
  };
}
