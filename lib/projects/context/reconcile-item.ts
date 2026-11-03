import "server-only";
import type { DbClient } from "@/lib/db/types";
import { commitPolicyRefusal } from "@/lib/db/pg/tx";
import { GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";
import { reconcileItemUnitLocked } from "@/lib/projects/context/units";
import {
  closeMembershipIntoLocked,
  ensureIncludeMembershipLocked,
  systemIntegrityGate,
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
  /** The skip was the Drive-ownership refusal: nothing was read past it and nothing was written. */
  driveOwned?: boolean;
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

/**
 * DRIVE OWNERSHIP, decided on the item this transaction has LOCKED. A Google Drive document's
 * context is derived solely from its connections' surviving audience claims; the generic routing
 * below would place it in General / external-shared by tier (Drive documents are stored `external`)
 * and close a claim-authorized placement in the opposite system project.
 *
 * Either signal alone is ownership, the same definition the ingest owner refuses on:
 *   - the locked row's own stored provenance (`frontmatter.source = 'gdrive'`), or
 *   - an exact same-team provider mapping for this item, read here, on this session, after the row
 *     lock — because stored provenance can be missing or altered, which is precisely how such a row
 *     slips past the frontmatter-only filters at the call sites.
 * Nothing else is consulted, by design: a mapping's `connection_id` is NULL for every claimed
 * document, and the connection may be disabled, disconnected, unleased or without a live claim —
 * none of which hands the document to the generic owner.
 *
 * A mapping read that fails, or answers anything but one boolean, THROWS: it runs before any write,
 * so the caller's transaction ends having written nothing.
 */
async function driveOwnsLockedItem(context: LockedItemContext): Promise<boolean> {
  const frontmatter = context.item.frontmatter;
  if (frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter) && frontmatter.source === "gdrive") {
    return true;
  }
  const result = await context.session.executeSql<{ drive_mapped: boolean | null }>(
    `select exists(
       select 1 from source_item_mappings m
        where m.team_id = $1 and m.item_id = $2 and m.source = 'gdrive'
     ) as drive_mapped`,
    [context.teamId, context.itemId]
  );
  const answer = result.rows[0]?.drive_mapped;
  if (result.rows.length !== 1 || typeof answer !== "boolean") {
    throw new Error("Drive ownership could not be read for a locked item");
  }
  return answer;
}

/** Shared core: caller already owns the one item row lock and supplies validated topology. */
export async function reconcileLockedItemContext(
  context: LockedItemContext,
  projects: SystemProjectIds
): Promise<ReconcileItemResult> {
  // FIRST, before the unit mirror or any membership is touched: a Drive-owned item is not this
  // owner's to place. The call sites filter on stored provenance; this is the authoritative check.
  if (await driveOwnsLockedItem(context)) return { ok: true, skipped: true, driveOwned: true };

  const unit = await reconcileItemUnitLocked(context);
  if (!unit.ok || !unit.unitId || !unit.audience) {
    return { ok: false, error: `unit: ${unit.error ?? "missing unit result"}` };
  }

  const target = unit.audience === "external" ? projects.externalShared : projects.general;
  const other = unit.audience === "external" ? projects.general : projects.externalShared;
  const narrowing = unit.audience === "team";

  // TIERRET-1 preflight, BOTH directions, before any membership mutation: the routed system target
  // must match the LOCKED item's audience and hold only sanctioned grants (`systemIntegrityGate`).
  // The unit mirror was re-copied from the locked item above in this same transaction; the gate
  // still reads `context.item.access` itself (N1 — the mirror is never the authority). The writer
  // repeats it authoritatively. Narrowing needs it most (it CLOSES first); widening opens first, so
  // the writer gate would also refuse before any close — the preflight just names it earlier.
  const preflight = await systemIntegrityGate(context.session.db, context.teamId, target, context.item.access);
  if (!preflight.ok) {
    return {
      ok: false,
      error: `membership: ${preflight.error}`,
      refused: preflight.refused,
      refusalReason: preflight.refusalReason,
    };
  }

  if (narrowing) {
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
