import "server-only";
import type { DbClient, TransactionSession } from "@/lib/db/types";
import {
  EXTERNAL_SHARED_SLUG,
  GENERAL_SLUG,
  isProtectedProject,
  isSanctionedSystemEdge,
  type EdgeGroupIdentity,
} from "@/lib/access/system-projects";
import {
  contextFailureMessage,
  lockItemContext,
  MembershipStateChangedError,
  runContextTransaction,
  type LockedItemContext,
} from "@/lib/projects/context/transaction";

/** THE single writer for `project_context_memberships` (guarded by access-single-writer). */
export type MembershipMethod =
  | "ingestion_project"
  | "explicit_ref"
  | "rule"
  | "embedding"
  | "llm"
  | "manual"
  | "exclude_shadow_repair";

export interface EnsureIncludeArgs {
  projectId: string;
  contextUnitId: string;
  method?: MembershipMethod;
  decidedBy?: string | null;
}

export type MembershipRefusalReason =
  | "system-integrity"
  | "protected-target-exclusion"
  | "membership-state-changed";

export interface WriteResult {
  ok: boolean;
  error?: string;
  created?: boolean;
  refused?: boolean;
  refusalReason?: MembershipRefusalReason;
}

/** The ONE audience → protected-target routing (team → General, external → external-shared). */
const ROUTED_SLUG: Readonly<Record<string, string>> = { team: GENERAL_SLUG, external: EXTERNAL_SHARED_SLUG };

function integrityRefusal(detail: string): WriteResult {
  return { ok: false, refused: true, refusalReason: "system-integrity", error: `system-integrity: ${detail}` };
}

/**
 * TIERRET-1 — the TARGET-INTEGRITY gate that REPLACES `noWideningGate` (AC-09; spec "Concrete change
 * boundary" §3). Shared pure preflight (ingest + reconcile) and the authoritative writer gate.
 *
 * WHAT CHANGED AND WHY. The old gate refused a TEAM unit into any project holding a grant to a group
 * SLUGGED `external` — a label veto over a membership grant, which is exactly what this slice
 * retires: a custom initiative granted to the actual builtin External group may now hold team
 * content (the grant is the sharing act). What the old gate ALSO protected — the two system
 * projects whose grants ARE the access substrate — is now protected precisely:
 *
 *   · ordinary / initiative target → no audience check at all;
 *   · PROTECTED target (`isProtectedProject`: a system project, or a reserved-slug source project
 *     before adoption — no second classifier) →
 *       1. exact ROUTING from `audience`, which callers pass from the LOCKED `items.access` (never
 *          the unit's mirror, never a caller label): team → General, external → external-shared.
 *          An unknown audience or an unknown protected slug refuses;
 *       2. EVERY grant on the target is a sanctioned system edge (`isSanctionedSystemEdge`, the
 *          AUDITFIX-3/23 definition the census uses). An unresolvable group, or any unsanctioned
 *          custom/singleton/builtin edge, refuses — in BOTH directions (N2): a corrupted
 *          external-shared now stops a widening push, a corrupted General a narrowing/backfill.
 *   · missing target → refused (settled).
 *
 * Settled policy refusals are `system-integrity` (`refused: true`); READ errors stay plain errors
 * (`ok:false` without `refused`), so callers keep their error-versus-refusal handling and a substrate
 * outage is never mistaken for a decision. Nothing here mutates. This is NOT serialization against a
 * concurrent administrative grant write — the grant writer's own AUDITFIX-3 prevention covers that.
 */
export async function systemIntegrityGate(
  db: DbClient,
  teamId: string,
  projectId: string,
  audience: string
): Promise<WriteResult> {
  const { data: project, error: projectError } = await db
    .from("projects")
    .select("id, kind, slug")
    .eq("team_id", teamId)
    .eq("id", projectId)
    .maybeSingle();
  if (projectError) return { ok: false, error: `system-integrity: target project read failed — ${projectError.message}` };
  if (!project) return integrityRefusal("target project not found in this team");
  const target = project as { kind: string; slug: string };
  if (!isProtectedProject(target)) return { ok: true };

  const routed = ROUTED_SLUG[audience];
  if (!routed) return integrityRefusal(`unknown audience '${audience}' for a protected target`);
  if (target.slug !== routed) {
    return integrityRefusal(
      `a ${audience}-audience unit may enter only '${routed}', not the protected project '${target.slug}'`
    );
  }

  const { data: grants, error: grantsError } = await db
    .from("project_groups")
    .select("group_id, groups(slug, is_builtin)")
    .eq("team_id", teamId)
    .eq("project_id", projectId);
  if (grantsError) return { ok: false, error: `system-integrity: target grants unreadable — ${grantsError.message}` };
  for (const row of (grants ?? []) as { group_id: string; groups: EdgeGroupIdentity | null }[]) {
    if (!isSanctionedSystemEdge(target.slug, row.groups ?? null)) {
      return integrityRefusal(
        `'${target.slug}' holds an unsanctioned grant to ${row.groups ? `group '${row.groups.slug}'` : `unresolved group ${row.group_id}`} — repair it (AUDITFIX-21) before placing content`
      );
    }
  }
  return { ok: true };
}

type CurrentRow = { id: string; decision: string; mode: string };
const isProtected = (row: CurrentRow): boolean =>
  row.decision === "exclude" && row.mode !== "auto";

function protectedTarget(): WriteResult {
  return {
    ok: false,
    refused: true,
    refusalReason: "protected-target-exclusion",
    error:
      "current membership is an explicit exclude — never auto-repaired (classification invariant 3)",
  };
}

async function insertInclude(
  context: LockedItemContext,
  args: EnsureIncludeArgs,
  method: MembershipMethod
): Promise<WriteResult> {
  const { error } = await context.session.db.from("project_context_memberships").insert({
    team_id: context.teamId,
    project_id: args.projectId,
    context_unit_id: args.contextUnitId,
    decision: "include",
    mode: "auto",
    method,
    decided_by: args.decidedBy ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, created: true };
}

/** Conditional auto-exclude repair with one authoritative same-transaction reread. */
async function repairExcludeShadow(
  context: LockedItemContext,
  args: EnsureIncludeArgs,
  row: CurrentRow
): Promise<WriteResult> {
  if (row.mode !== "auto") return protectedTarget();

  const { data: project, error: projectError } = await context.session.db
    .from("projects")
    .select("kind")
    .eq("team_id", context.teamId)
    .eq("id", args.projectId)
    .maybeSingle();
  if (projectError) return { ok: false, error: `target project read failed: ${projectError.message}` };
  if (!project || (project as { kind: string }).kind !== "system") {
    return {
      ok: false,
      error:
        "current membership is an exclude in a non-system project — not repaired (a curation surface, not the substrate)",
    };
  }

  const { data: closed, error: closeError } = await context.session.db
    .from("project_context_memberships")
    .update({ valid_to: new Date().toISOString() })
    .eq("team_id", context.teamId)
    .eq("id", row.id)
    .eq("decision", "exclude")
    .eq("mode", "auto")
    .is("valid_to", null)
    .select("id");
  if (closeError) return { ok: false, error: `exclude-shadow close failed: ${closeError.message}` };

  if (((closed ?? []) as unknown[]).length === 0) {
    const { data: reread, error: rereadError } = await context.session.db
      .from("project_context_memberships")
      .select("id, decision, mode")
      .eq("team_id", context.teamId)
      .eq("project_id", args.projectId)
      .eq("context_unit_id", args.contextUnitId)
      .is("valid_to", null)
      .maybeSingle();
    if (rereadError) return { ok: false, error: `exclude-shadow reread failed: ${rereadError.message}` };
    const current = reread as CurrentRow | null;
    if (current?.decision === "include") return { ok: true, created: false };
    if (current && isProtected(current)) return protectedTarget();
    if (!current) return insertInclude(context, args, "exclude_shadow_repair");
    throw new MembershipStateChangedError(
      "membership-state-changed: automatic target exclusion changed without converging"
    );
  }

  return insertInclude(context, args, "exclude_shadow_repair");
}

/** Internal core for callers that already hold the item lock. */
export async function ensureIncludeMembershipLocked(
  context: LockedItemContext,
  args: EnsureIncludeArgs
): Promise<WriteResult> {
  const { data: unit, error: unitError } = await context.session.db
    .from("project_context_units")
    .select("id, source_item_id, audience")
    .eq("team_id", context.teamId)
    .eq("id", args.contextUnitId)
    .eq("source_item_id", context.itemId)
    .eq("unit_kind", "item")
    .maybeSingle();
  if (unitError) return { ok: false, error: `context unit read failed: ${unitError.message}` };
  if (!unit) return { ok: false, error: "context unit not found or no longer belongs to item" };

  // The routing authority is the LOCKED item (N1) — a stale unit mirror can never admit it, and a
  // MISMATCHING mirror is refused before any membership mutation (spec §3, code review 1 LOW-2):
  // reconciliation re-copies the mirror from the locked item in this same transaction before it
  // gets here, so only a caller that skipped that refresh can arrive with a mismatch — in either
  // direction, whatever the target. The refusal names the drift; it never trusts or repairs it.
  const unitAudience = (unit as { audience: string | null }).audience;
  if (unitAudience !== context.item.access) {
    return integrityRefusal(
      `the unit's audience mirror ('${unitAudience}') disagrees with the locked item ('${context.item.access}') — reconcile the unit before placing it`
    );
  }
  const gate = await systemIntegrityGate(
    context.session.db,
    context.teamId,
    args.projectId,
    context.item.access
  );
  if (!gate.ok) return gate;

  const { data: existing, error: existingError } = await context.session.db
    .from("project_context_memberships")
    .select("id, decision, mode")
    .eq("team_id", context.teamId)
    .eq("project_id", args.projectId)
    .eq("context_unit_id", args.contextUnitId)
    .is("valid_to", null)
    .maybeSingle();
  if (existingError) return { ok: false, error: `membership read failed: ${existingError.message}` };
  const current = existing as CurrentRow | null;
  if (current?.decision === "include") return { ok: true, created: false };
  if (current) return repairExcludeShadow(context, args, current);
  return insertInclude(context, args, args.method ?? "ingestion_project");
}

export type CloseResult =
  | { ok: true; closed: number; spared: number }
  | { ok: false; error: string };

/** Internal close core; initiative memberships are never touched by context moves. */
export async function closeMembershipIntoLocked(
  context: LockedItemContext,
  contextUnitId: string,
  projectId: string
): Promise<CloseResult> {
  const readCurrent = async (): Promise<
    { ok: true; rows: CurrentRow[] } | { ok: false; error: string }
  > => {
    const { data, error } = await context.session.db
      .from("project_context_memberships")
      .select("id, decision, mode")
      .eq("team_id", context.teamId)
      .eq("context_unit_id", contextUnitId)
      .eq("project_id", projectId)
      .is("valid_to", null);
    if (error) return { ok: false, error: error.message };
    return { ok: true, rows: (data ?? []) as CurrentRow[] };
  };

  const first = await readCurrent();
  if (!first.ok) return { ok: false, error: `close read failed: ${first.error}` };
  const toClose = first.rows.filter((row) => !isProtected(row));
  const spared = first.rows.length - toClose.length;
  if (toClose.length === 0) return { ok: true, closed: 0, spared };

  let closed = 0;
  for (const row of toClose) {
    const { data: affected, error } = await context.session.db
      .from("project_context_memberships")
      .update({ valid_to: new Date().toISOString() })
      .eq("team_id", context.teamId)
      .eq("id", row.id)
      .eq("decision", row.decision)
      .eq("mode", row.mode)
      .is("valid_to", null)
      .select("id");
    if (error) return { ok: false, error: `close failed: ${error.message}` };
    closed += ((affected ?? []) as unknown[]).length;
  }
  if (closed === toClose.length) return { ok: true, closed, spared };

  const after = await readCurrent();
  if (!after.ok) return { ok: false, error: `close reread failed: ${after.error}` };
  const stillClosable = after.rows.filter((row) => !isProtected(row));
  if (stillClosable.length > 0) {
    return {
      ok: false,
      error: `close did not converge: ${stillClosable.length} current row(s) remain closable`,
    };
  }
  return { ok: true, closed, spared: after.rows.length };
}

async function lockContextForUnit(
  session: TransactionSession,
  teamId: string,
  contextUnitId: string
): Promise<LockedItemContext | null> {
  const { data: before, error } = await session.db
    .from("project_context_units")
    .select("source_item_id")
    .eq("team_id", teamId)
    .eq("id", contextUnitId)
    .eq("unit_kind", "item")
    .maybeSingle();
  if (error) throw new Error(`context unit read failed: ${error.message}`);
  const itemId = (before as { source_item_id?: string } | null)?.source_item_id;
  if (!itemId) return null;
  const context = await lockItemContext(session, teamId, itemId);
  if (!context) return null;
  const { data: after, error: revalidateError } = await session.db
    .from("project_context_units")
    .select("id")
    .eq("team_id", teamId)
    .eq("id", contextUnitId)
    .eq("source_item_id", itemId)
    .eq("unit_kind", "item")
    .maybeSingle();
  if (revalidateError) throw new Error(`context unit revalidation failed: ${revalidateError.message}`);
  return after ? context : null;
}

/** Standalone public writer: resolves the unit's item, locks it, then revalidates the relationship. */
export async function ensureIncludeMembership(
  db: DbClient,
  teamId: string,
  args: EnsureIncludeArgs
): Promise<WriteResult> {
  try {
    return await runContextTransaction(db, async (session) => {
      const context = await lockContextForUnit(session, teamId, args.contextUnitId);
      if (!context) return { ok: false, error: "context unit or item not found" };
      return ensureIncludeMembershipLocked(context, args);
    });
  } catch (error) {
    return { ok: false, error: contextFailureMessage(error) };
  }
}

/** Standalone public close with the same lock/revalidation protocol. */
export async function closeMembershipInto(
  db: DbClient,
  teamId: string,
  contextUnitId: string,
  projectId: string
): Promise<CloseResult> {
  try {
    return await runContextTransaction(db, async (session) => {
      const context = await lockContextForUnit(session, teamId, contextUnitId);
      if (!context) return { ok: false, error: "context unit or item not found" };
      return closeMembershipIntoLocked(context, contextUnitId, projectId);
    });
  } catch (error) {
    return { ok: false, error: contextFailureMessage(error) };
  }
}
