import "server-only";
import type { DbClient } from "@/lib/db/types";
import { autoFlipIfReady } from "./access-enforcement";
import { resolvePositiveInt } from "@/lib/util/env";

/**
 * PRET-2 — the scheduler's auto-flip pass (spec docs/design/pret2-convergence-gated-flip.md
 * §1.2), extracted from the tick closure so the dm tier can drive a pass directly and the
 * call-site guard has a module to pin.
 *
 * Cost model: `autoFlipIfReady` is stage-ordered — the team read (mode + hold), the warning
 * scan (two adapter queries, no per-agent oracle loop) are CHEAP and run for EVERY permissive
 * team every pass; the EXPENSIVE stage (prepare→drain→assess) is entered only by warning-free
 * candidates under the `drainAllowed` budget, at most `PRET_FLIP_MAX_PER_TICK` per pass.
 *
 * FAIR ROTATION (Codex H1: without it, teams with PERMANENT blockers enumerated first consume
 * every drain slot every tick and starve ready teams forever — the deferral latch dedups AUDIT
 * ROWS, deliberately, so audit timestamps cannot order the queue): a per-process monotonic
 * attempt sequence. Every team whose expensive stage RAN moves to the back; never-attempted
 * teams go first. Per-process on purpose — it needs no schema and no clock, restarts merely
 * re-shuffle a bounded (≤ budget per tick) burst, and concurrent instances each converge
 * independently because the flip itself is guarded + idempotent.
 */
export const PRET_FLIP_MAX_PER_TICK = resolvePositiveInt(process.env.PRET_FLIP_MAX_PER_TICK, 3);

const lastDrainSeq = new Map<string, number>();
let drainSeq = 0;

/** Test hook: clear the rotation memory so suites are order-independent. */
export function resetAutoFlipRotation(): void {
  lastDrainSeq.clear();
  drainSeq = 0;
}

export interface AutoFlipPassResult {
  /** Teams whose expensive flip attempt ran this pass (≤ PRET_FLIP_MAX_PER_TICK). */
  attempted: string[];
  flipped: string[];
  /** Teams deferred this pass (cheap OR expensive stage), with their reasons for the trace. */
  deferred: Array<{ teamId: string; blockers: string[]; warnings: string[]; error?: string }>;
  /** Set when the PASS ITSELF could not run (the fleet enumeration failed) — the scheduler
   *  records a FAILED run so the mechanism cannot stop silently (Codex M3). */
  error?: string;
}

export async function runAutoFlipPass(db: DbClient): Promise<AutoFlipPassResult> {
  const result: AutoFlipPassResult = { attempted: [], flipped: [], deferred: [] };
  const { data, error } = await db.from("teams").select("id").eq("access_enforcement", "permissive");
  if (error) {
    // Fail closed AND loud: no team flips, and the scheduler records a failed auto_flip run —
    // an enumeration outage must not read as "fleet converged" (Codex M3).
    return { ...result, error: `teams enumeration failed: ${error.message}` };
  }
  // Never-attempted first (seq 0), then oldest drain attempt first; team id as the
  // deterministic tiebreak.
  const teams = ((data ?? []) as { id: string }[])
    .map((t) => t.id)
    .sort((a, b) => (lastDrainSeq.get(a) ?? 0) - (lastDrainSeq.get(b) ?? 0) || a.localeCompare(b));
  let drainBudget = PRET_FLIP_MAX_PER_TICK;
  for (const teamId of teams) {
    // EVERY permissive team gets the cheap stages every pass; only the expensive stage is
    // budgeted (`drainAllowed`). A ready team past the budget queues silently; a flipped team
    // leaves the permissive set; a drained-but-refused team rotates to the back of the queue.
    const r = await autoFlipIfReady(db, teamId, { drainAllowed: drainBudget > 0 });
    if (r.drained) {
      drainBudget--;
      lastDrainSeq.set(teamId, ++drainSeq);
      result.attempted.push(teamId);
    }
    if (r.flipped) result.flipped.push(teamId);
    if (r.deferred) result.deferred.push({ teamId, ...r.deferred });
  }
  return result;
}
