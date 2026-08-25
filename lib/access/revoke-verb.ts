import type { RevokeResult } from "@/lib/access/groups";
import { isProtectedProject } from "@/lib/access/system-projects";

/**
 * REVOKE-1: the `revoke-project` CLI verb's PURE decision layer — extracted so the
 * die-before-writer promises are testable with an injected (spying) writer while
 * `scripts/admin.ts` stays thin wiring like every other verb. The WRITER
 * (`revokeProjectFromGroup`) holds the real invariants (system-kind refusal, the admin
 * predicate, check order); this layer only sequences resolution and improves messages —
 * including the system-kind PREFLIGHT, which exists purely so an operator reads a sentence
 * naming the substrate instead of a bare writer error.
 */
export interface RevokeVerbDeps {
  resolveGroupId(groupSlug: string): Promise<string | null>;
  resolveProject(projectSlug: string): Promise<{ id: string; kind: string; slug: string } | null>;
  resolveMemberIdByEmail(email: string): Promise<string | null>;
  revoke(projectId: string, groupId: string, authorizedByMemberId: string): Promise<RevokeResult>;
}

export interface RevokeVerbArgs {
  groupSlug?: string;
  projectSlug?: string;
  actorEmail?: string;
}

export type RevokeVerbOutcome =
  | { ok: true; revoked: boolean }
  | { ok: false; error: string };

export const REVOKE_USAGE =
  "usage: revoke-project <group-slug> <project-slug> --actor <admin-email> [--team <id|slug>]";

export async function runRevokeProjectVerb(
  deps: RevokeVerbDeps,
  args: RevokeVerbArgs
): Promise<RevokeVerbOutcome> {
  // D1: a destructive narrowing may not be attributed to nobody — no named authorizer, no
  // resolution, no writer call.
  if (!args.groupSlug || !args.projectSlug) return { ok: false, error: REVOKE_USAGE };
  if (!args.actorEmail) {
    return { ok: false, error: `--actor <admin-email> is required — a revoke must name the admin who authorized it\n${REVOKE_USAGE}` };
  }

  const groupId = await deps.resolveGroupId(args.groupSlug);
  if (!groupId) return { ok: false, error: `no group '${args.groupSlug}' on this team` };
  const project = await deps.resolveProject(args.projectSlug);
  if (!project) return { ok: false, error: `no project '${args.projectSlug}' on this team` };
  if (isProtectedProject(project)) {
    // Preflight for message quality only — the writer refuses independently (D2).
    //
    // ⚠️ AUDITFIX-21 widened this from `kind === "system"` to the same predicate the writer now uses.
    // It has to move WITH the writer: while this tested only the kind, `revoke-project everyone general`
    // against a reserved-slug `kind='source'` project passed the preflight AND the writer's old
    // kind-only refusal, and deleted the substrate edge.
    // The sentence has to be TRUE for both shapes this now refuses. Saying "is a SYSTEM project"
    // about a kind='source' row is simply false — the diff review caught it — but the SYSTEM wording
    // is also the shipped contract for a system project, pinned by test/admin-cli-revoke.test.ts.
    // So it is conditional: each kind gets an accurate sentence, and both name the substrate.
    const what =
      project.kind === "system"
        ? `'${args.projectSlug}' is a SYSTEM project — its grants are the access substrate (general/external-shared ↔ the builtins)`
        : `'${args.projectSlug}' holds a reserved substrate slug and is about to become a SYSTEM project — its grants are the access substrate (general/external-shared ↔ the builtins)`;
    return { ok: false, error: `${what} and cannot be revoked by this verb. An UNSANCTIONED edge on it is repairable with \`repair-system-edge\`.` };
  }
  const authorizedByMemberId = await deps.resolveMemberIdByEmail(args.actorEmail);
  if (!authorizedByMemberId) return { ok: false, error: `no member '${args.actorEmail}' on this team` };

  const r = await deps.revoke(project.id, groupId, authorizedByMemberId);
  if (!r.ok) return { ok: false, error: r.error ?? "revoke failed" };
  return { ok: true, revoked: r.revoked === true };
}
