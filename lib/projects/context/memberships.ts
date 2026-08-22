import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * THE single writer for `project_context_memberships` (spec §"project_context_memberships";
 * guarded by test/guards/access-single-writer.test.ts). The membership is the content→project
 * edge the oracle reads to answer canSee. Invariant: at most one CURRENT row (`valid_to is
 * null`) per (team, project, unit). Moving closes the old row and opens the new; this slice
 * only needs idempotent include-ensure for the §11 backfill — force/exclude/move arrive with
 * the curation UI (Phase D).
 */

export type MembershipMethod =
  | "ingestion_project"
  | "explicit_ref"
  | "rule"
  | "embedding"
  | "llm"
  | "manual"
  // EXCLSHADOW-1: the repair include written when reconcile closes an AUTOMATIC exclude
  // found in the item's target SYSTEM project (the table is its own audit trail — this value
  // is how a repair stays legible). CHECK-widened by migration 20260820150000.
  | "exclude_shadow_repair";

export interface EnsureIncludeArgs {
  projectId: string;
  contextUnitId: string;
  method?: MembershipMethod;
  decidedBy?: string | null;
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  created?: boolean;
  /** Set when a write was refused by the no-widening gate (distinct from a DB error). */
  refused?: boolean;
}

/**
 * Can the target project be reached by the built-in `external` group — TRI-STATE (AUDITFIX-4).
 *
 * It used to return a bare `boolean` and destructure only `data`. The pg adapter RETURNS errors
 * rather than throwing, so a failed read became `[]` → `some()` false → the caller's `&&`
 * short-circuited → **the no-widening gate silently disappeared** and the widening placement was
 * written. A bare boolean has nowhere to say "I could not determine this", which is why this is a
 * signature change rather than an error check.
 *
 * `{ok:false}` is NOT "not reachable" — the caller must refuse, not proceed. `project_groups`
 * decides who receives the project, so under a membership-only access model an undetermined read
 * makes uncertainty MORE consequential, not less.
 */
type ExternalReach = { ok: true; reachable: boolean } | { ok: false; error: string };

async function projectIsExternalVisible(db: DbClient, teamId: string, projectId: string): Promise<ExternalReach> {
  const { data, error } = await db
    .from("project_groups")
    .select("groups(slug)")
    .eq("team_id", teamId)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as { groups: { slug: string } | null }[];
  return { ok: true, reachable: rows.some((r) => r.groups?.slug === "external") };
}

/**
 * Ensure a CURRENT include membership of a unit into a project. Idempotent: if a current row
 * already exists for the pair it is a no-op (never a second row — the partial unique on
 * `valid_to is null` also backstops a race). Auto-mode by default; the §11 backfill uses
 * method `ingestion_project`.
 */
/**
 * THE no-widening rule, in one place, callable WITHOUT writing (AUDITFIX-4 §3a3).
 *
 * `reconcileItemContext` needs the answer BEFORE it performs a destructive close on a narrowing
 * move — otherwise a `project_groups` read outage closes the old membership and then refuses the new
 * one, leaving the item in NEITHER project. Having the writer be the only place that can ask was the
 * second-order defect; this is the same rule with one owner and two callers.
 *
 * It fixes DESTRUCTIVENESS only. A preflight `ok:false` pins the backfill cursor exactly as any
 * other failure does (the deliberate retry-not-skip of `backfill.ts`), so a persistent reachability
 * outage still blocks later candidates for that team — correctness over throughput, by design.
 */
export async function noWideningGate(
  db: DbClient,
  teamId: string,
  projectId: string,
  unitAudience: string
): Promise<WriteResult> {
  if (unitAudience !== "team") return { ok: true };
  const reach = await projectIsExternalVisible(db, teamId, projectId);
  // UNDETERMINED refuses (AUDITFIX-4). Deliberately NOT `refused:true` — that flag means "the gate
  // said no", a settled answer a sweep need not retry; this is "the gate could not answer", which it
  // must retry. Collapsing the two would turn a transient outage into a permanent skip.
  if (!reach.ok) return { ok: false, error: `no-widening: external reachability undetermined — ${reach.error}` };
  if (reach.reachable) {
    return { ok: false, refused: true, error: "no-widening: a team-audience unit cannot enter an external-visible project" };
  }
  return { ok: true };
}

export async function ensureIncludeMembership(
  db: DbClient,
  teamId: string,
  args: EnsureIncludeArgs
): Promise<WriteResult> {
  // No-widening gate (tier dimension): a team-audience unit must never enter an external-visible
  // project. Read the unit's inherited audience and refuse the widening placement outright.
  const { data: unitRow } = await db
    .from("project_context_units")
    .select("audience")
    .eq("team_id", teamId)
    .eq("id", args.contextUnitId)
    .maybeSingle();
  if (!unitRow) return { ok: false, error: "context unit not found" };
  const gate = await noWideningGate(db, teamId, args.projectId, (unitRow as { audience: string }).audience);
  if (!gate.ok) return gate;

  // EXCLSHADOW-1 D1b: the probe is UNFILTERED (the partial unique index guarantees ≤1
  // current row per pair) and BRANCHES — an exclude is never returned as convergence. The
  // hot path (include found / nothing found) costs exactly what it did before; only the
  // rare exclude branch pays the extra reads.
  const { data: existing } = await db
    .from("project_context_memberships")
    .select("id, decision, mode")
    .eq("team_id", teamId)
    .eq("project_id", args.projectId)
    .eq("context_unit_id", args.contextUnitId)
    .is("valid_to", null)
    .maybeSingle();
  const current = existing as { id: string; decision: string; mode: string } | null;
  if (current) {
    if (current.decision === "include") return { ok: true, created: false };
    return repairExcludeShadow(db, teamId, args, current);
  }

  const { error } = await db.from("project_context_memberships").insert({
    team_id: teamId,
    project_id: args.projectId,
    context_unit_id: args.contextUnitId,
    decision: "include",
    mode: "auto",
    method: args.method ?? "ingestion_project",
    decided_by: args.decidedBy ?? null,
  });
  if (error) {
    // Race loser on pcm_current_idx: another writer created the current row first — converge.
    const { data: winner } = await db
      .from("project_context_memberships")
      .select("id, decision")
      .eq("team_id", teamId)
      .eq("project_id", args.projectId)
      .eq("context_unit_id", args.contextUnitId)
      .is("valid_to", null)
      .maybeSingle();
    // EXCLSHADOW-1 D1c: the race-loser takes the SAME branch discipline — converged ONLY on
    // a current INCLUDE. An unfiltered "any current row = converged" here would resurrect
    // the silent exclude masquerade through the back door for exactly the states the repair
    // is scoped out of (explicit/force excludes, non-system projects).
    const w = winner as { decision?: string } | null;
    if (w && w.decision === "include") return { ok: true, created: false };
    if (w) return { ok: false, error: "current membership is a non-include row (exclude) — not converged" };
    return { ok: false, error: error.message };
  }
  return { ok: true, created: true };
}

/**
 * EXCLSHADOW-1: repair an AUTOMATIC exclude found in the target SYSTEM project — the state
 * that made an item invisible to every enforced read (`enforce` serves only includes) while
 * reading as `created:false` convergence. THE SCOPE IS THE RULING (spec D1, from
 * classification invariant 3): an explicit (any non-auto mode) exclude is an operator's
 * recorded decision and is NEVER auto-repaired; a non-system project is a curation surface
 * this repair must not touch. Both conditions live HERE, in the writer — not in any caller.
 * Close-first is index-forced: the partial unique index refuses a second current row, so the
 * exclude's `valid_to` must be stamped before the include can exist.
 */
async function repairExcludeShadow(
  db: DbClient,
  teamId: string,
  args: EnsureIncludeArgs,
  row: { id: string; mode: string }
): Promise<WriteResult> {
  if (row.mode !== "auto") {
    return { ok: false, error: "current membership is an explicit exclude — never auto-repaired (classification invariant 3)" };
  }
  const { data: proj } = await db
    .from("projects")
    .select("kind")
    .eq("team_id", teamId)
    .eq("id", args.projectId)
    .maybeSingle();
  if (!proj || (proj as { kind: string }).kind !== "system") {
    return { ok: false, error: "current membership is an exclude in a non-system project — not repaired (a curation surface, not the substrate)" };
  }
  const { error: closeErr } = await db
    .from("project_context_memberships")
    .update({ valid_to: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("id", row.id)
    .is("valid_to", null);
  if (closeErr) return { ok: false, error: `exclude-shadow close failed: ${closeErr.message}` };
  const { error } = await db.from("project_context_memberships").insert({
    team_id: teamId,
    project_id: args.projectId,
    context_unit_id: args.contextUnitId,
    decision: "include",
    mode: "auto",
    method: "exclude_shadow_repair",
    decided_by: args.decidedBy ?? null,
  });
  if (error) {
    // CONCURRENT-REPAIRER convergence (Codex diff M1 — the second-order bug in the first
    // fold): two reconcilers can both read the same auto exclude; the loser's close matches
    // zero rows WITHOUT error, its insert then collides with the winner's include, and
    // returning ok:false here reported a CONVERGED membership as a batch-stopping failure.
    // Same discipline as the plain path's race loser: re-probe, converge ONLY on an include.
    const { data: winner } = await db
      .from("project_context_memberships")
      .select("decision")
      .eq("team_id", teamId)
      .eq("project_id", args.projectId)
      .eq("context_unit_id", args.contextUnitId)
      .is("valid_to", null)
      .maybeSingle();
    if ((winner as { decision?: string } | null)?.decision === "include") {
      return { ok: true, created: false };
    }
    // Half-repair fail direction (spec §2): the exclude is closed and the include absent —
    // the item is now a plain no-current-include candidate, completed by the next pass.
    return { ok: false, error: `exclude-shadow repair: close succeeded, include insert failed (${error.message}) — next pass completes` };
  }
  return { ok: true, created: true };
}

/**
 * Close the CURRENT membership of a unit into ONE specific project (`projectId`), setting
 * `valid_to`. The "close old" half of a tier-flip MOVE: reconcile re-routes the unit to the
 * correct system project and closes the OPPOSITE system project's membership (external→team must
 * stop being served through external-shared — slice-4 Codex H2).
 *
 * Scoped to a single named project ON PURPOSE (slice-5 Codex HIGH): an earlier "close every
 * membership except the target" would, once the Part II curation UI lets a unit belong to
 * initiatives too, silently delete those legitimate initiative assignments on every reconcile.
 * The move only ever swaps between the two system projects, so it closes exactly the other one.
 *
 * CLOSEMODE-1: the close SPARES a human's standing exclusion (`decision='exclude' AND
 * mode <> 'auto'`). Closing it ended the decision's continuing authority, and the round trip then
 * re-included content a human had explicitly excluded from the external tier (the outbound flip
 * deleted the very row invariant 3's return-leg refusal needs). Sparing an exclude is
 * visibility-NEUTRAL — every serving reader filters `decision='include'`, so a current exclude and
 * absence serve identically — and the candidate predicate's ARM 3 carries the same exception
 * (`PROTECTED_EXCLUDE_SQL` in backfill-candidates.ts — keep the two rules textually in step).
 * Includes of ANY mode still close: force-include semantics on system projects are Phase D design
 * (a General survivor would widen for a General-scoped delegated token and diverge from the
 * graph's single-home model — CLOSEMODE-1 design round 1).
 */
export type CloseResult =
  | { ok: true; closed: number; spared: number }
  | { ok: false; error: string };

/** Is this current row a human's standing exclusion, which the move must SPARE (CLOSEMODE-1)? */
type CurrentRow = { id: string; decision: string; mode: string };
const isProtected = (m: CurrentRow): boolean => m.decision === "exclude" && m.mode !== "auto";

export async function closeMembershipInto(
  db: DbClient,
  teamId: string,
  contextUnitId: string,
  projectId: string
): Promise<CloseResult> {
  const readCurrent = async (): Promise<{ ok: true; rows: CurrentRow[] } | { ok: false; error: string }> => {
    const { data, error } = await db
      .from("project_context_memberships")
      .select("id, decision, mode")
      .eq("team_id", teamId)
      .eq("context_unit_id", contextUnitId)
      .eq("project_id", projectId)
      .is("valid_to", null);
    // AUDITFIX-4: the error was DESTRUCTURED AWAY here, so a failed read became `[]` → nothing to
    // close → `{ok:true, closed:0}`. The function reported that it had successfully closed nothing,
    // having failed to look.
    if (error) return { ok: false, error: error.message };
    return { ok: true, rows: (data ?? []) as CurrentRow[] };
  };

  const first = await readCurrent();
  if (!first.ok) return { ok: false, error: `close read failed: ${first.error}` };

  const toClose = first.rows.filter((m) => !isProtected(m));
  const spared = first.rows.length - toClose.length;
  if (toClose.length === 0) return { ok: true, closed: 0, spared };

  let closed = 0;
  for (const row of toClose) {
    // REASSERT the classification in the WHERE clause instead of trusting the id we read
    // (AUDITFIX-4 round 1). Two races this closes: (a) the row was replaced by a different current
    // row, so `valid_to is null` no longer matches this id; (b) the row BECAME a human's standing
    // exclusion between the read and the write, and closing it by id would erase the very thing
    // CLOSEMODE-1 exists to protect. `decision`/`mode` are non-null (schema.sql:1189), so exact
    // equality is a faithful restatement of the predicate — it never closes MORE than the filter did.
    //
    // One statement per row costs nothing real: `pcm_current_idx` is unique on
    // (team_id, project_id, context_unit_id) WHERE valid_to is null, so `toClose` holds at most one.
    // Written as a loop anyway, because a predicate that silently depends on an index elsewhere is
    // how the two drift.
    const { data: affected, error } = await db
      .from("project_context_memberships")
      .update({ valid_to: new Date().toISOString() })
      .eq("team_id", teamId)
      .eq("id", row.id)
      .eq("decision", row.decision)
      .eq("mode", row.mode)
      .is("valid_to", null)
      .select("id"); // RETURNING — `closed` is MEASURED, never assumed from what we read
    if (error) return { ok: false, error: `close failed: ${error.message}` };
    closed += ((affected ?? []) as unknown[]).length;
  }

  if (closed === toClose.length) return { ok: true, closed, spared };

  // Zero (or short) affected rows after a non-empty read means the world moved under us. That is
  // NOT success: reread and let the FINAL STATE decide, because "we closed nothing" and "there is
  // nothing left to close" are different facts and only the second is convergence.
  const after = await readCurrent();
  if (!after.ok) return { ok: false, error: `close reread failed: ${after.error}` };
  const stillClosable = after.rows.filter((m) => !isProtected(m));
  if (stillClosable.length > 0) {
    // The move did NOT move. Reporting success here is the defect this slice is named for.
    return { ok: false, error: `close did not converge: ${stillClosable.length} current row(s) remain closable` };
  }
  // Everything that had to go is gone — by us or by a concurrent writer — and whatever remains is
  // protected. Converged, and `spared` reports the FINAL state rather than the stale first read.
  return { ok: true, closed, spared: after.rows.length };
}
