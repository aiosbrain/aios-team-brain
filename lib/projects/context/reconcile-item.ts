import "server-only";
import type { DbClient } from "@/lib/db/types";
import { commitPolicyRefusal } from "@/lib/db/pg/tx";
import { GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";
import { reconcileItemUnitLocked } from "@/lib/projects/context/units";
import {
  closeMembershipIntoLocked,
  ensureIncludeMembershipLocked,
  noWideningGate,
  type MembershipRefusalReason,
} from "@/lib/projects/context/memberships";
import {
  contextFailureMessage,
  lockItemContext,
  runContextTransaction,
  type LockedItemContext,
} from "@/lib/projects/context/transaction";

export interface ReconcileItemResult {
  ok: boolean;
  error?: string;
  skipped?: boolean;
  unitId?: string;
  unitCreated?: boolean;
  membershipCreated?: boolean;
  spared?: number;
  refused?: boolean;
  refusalReason?: MembershipRefusalReason;
}

export interface SystemProjectIds {
  general: string;
  externalShared: string;
}

/** Resolve the exact team-owned system topology; read failure is distinct from missing bootstrap. */
export async function systemProjectIds(
  db: DbClient,
  teamId: string
): Promise<SystemProjectIds | null | undefined> {
  const { data, error } = await db
    .from("projects")
    .select("id, slug")
    .eq("team_id", teamId)
    .eq("kind", "system")
    .in("slug", [GENERAL_SLUG, EXTERNAL_SHARED_SLUG]);
  if (error) return undefined;
  const bySlug = new Map(((data ?? []) as { id: string; slug: string }[]).map((row) => [row.slug, row.id]));
  const general = bySlug.get(GENERAL_SLUG);
  const externalShared = bySlug.get(EXTERNAL_SHARED_SLUG);
  return general && externalShared ? { general, externalShared } : null;
}

/** Supplied backfill ids are hints, never authority. */
export async function validatedSystemProjectIds(
  db: DbClient,
  teamId: string,
  hints?: SystemProjectIds
): Promise<SystemProjectIds | null | undefined> {
  if (!hints) return systemProjectIds(db, teamId);
  const { data, error } = await db
    .from("projects")
    .select("id, slug, kind")
    .eq("team_id", teamId)
    .eq("kind", "system")
    .in("id", [hints.general, hints.externalShared]);
  if (error) return undefined;
  const rows = (data ?? []) as { id: string; slug: string; kind: string }[];
  const general = rows.find(
    (row) => row.id === hints.general && row.slug === GENERAL_SLUG && row.kind === "system"
  );
  const external = rows.find(
    (row) =>
      row.id === hints.externalShared &&
      row.slug === EXTERNAL_SHARED_SLUG &&
      row.kind === "system"
  );
  // Hints are explicit references supplied by a caller that claims bootstrap already resolved;
  // a wrong team/kind/slug is stale authority, not the benign "not bootstrapped yet" state.
  return general && external ? hints : undefined;
}

/** Shared core: caller already owns the one item row lock and supplies validated topology. */
export async function reconcileLockedItemContext(
  context: LockedItemContext,
  projects: SystemProjectIds
): Promise<ReconcileItemResult> {
  const unit = await reconcileItemUnitLocked(context);
  if (!unit.ok || !unit.unitId || !unit.audience) {
    return { ok: false, error: `unit: ${unit.error ?? "missing unit result"}` };
  }

  const target = unit.audience === "external" ? projects.externalShared : projects.general;
  const other = unit.audience === "external" ? projects.general : projects.externalShared;
  const narrowing = unit.audience === "team";

  if (narrowing) {
    const preflight = await noWideningGate(
      context.session.db,
      context.teamId,
      target,
      unit.audience
    );
    if (!preflight.ok) {
      return {
        ok: false,
        error: `membership: ${preflight.error}`,
        refused: preflight.refused,
        refusalReason: preflight.refusalReason,
      };
    }

    const closed = await closeMembershipIntoLocked(context, unit.unitId, other);
    if (!closed.ok) return { ok: false, error: `move: ${closed.error}` };
    const opened = await ensureIncludeMembershipLocked(context, {
      projectId: target,
      contextUnitId: unit.unitId,
    });
    if (!opened.ok) {
      return {
        ok: false,
        error: `membership: ${opened.error}`,
        refused: opened.refused,
        refusalReason: opened.refusalReason,
        spared: closed.spared,
      };
    }
    return {
      ok: true,
      unitId: unit.unitId,
      unitCreated: unit.created,
      membershipCreated: opened.created,
      spared: closed.spared,
    };
  }

  const opened = await ensureIncludeMembershipLocked(context, {
    projectId: target,
    contextUnitId: unit.unitId,
  });
  if (!opened.ok) {
    return {
      ok: false,
      error: `membership: ${opened.error}`,
      refused: opened.refused,
      refusalReason: opened.refusalReason,
    };
  }
  const closed = await closeMembershipIntoLocked(context, unit.unitId, other);
  if (!closed.ok) return { ok: false, error: `move: ${closed.error}` };
  return {
    ok: true,
    unitId: unit.unitId,
    unitCreated: unit.created,
    membershipCreated: opened.created,
    spared: closed.spared,
  };
}

/** Public standalone reconcile: one transaction, one row lock, no nested checkout. */
export async function reconcileItemContext(
  db: DbClient,
  teamId: string,
  itemId: string,
  hints?: SystemProjectIds
): Promise<ReconcileItemResult> {
  try {
    return await runContextTransaction(db, async (session) => {
      const context = await lockItemContext(session, teamId, itemId);
      if (!context) return { ok: true, skipped: true };
      const projects = await validatedSystemProjectIds(session.db, teamId, hints);
      if (projects === undefined) return { ok: false, error: "system project read failed" };
      if (projects === null) return { ok: true, skipped: true };
      const result = await reconcileLockedItemContext(context, projects);
      // Human target exclusions deliberately commit the established directional standing state.
      if (!result.ok && result.refusalReason === "protected-target-exclusion") {
        return commitPolicyRefusal(result);
      }
      return result;
    });
  } catch (error) {
    return { ok: false, error: contextFailureMessage(error) };
  }
}
