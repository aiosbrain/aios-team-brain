import "server-only";
import type { DbClient } from "@/lib/db/types";
import { autoFlipIfReady } from "./access-enforcement";
import { resolvePositiveInt } from "@/lib/util/env";

/**
 * PRET-2 — the scheduler's auto-flip pass (spec docs/design/pret2-convergence-gated-flip.md
 * §1.2), extracted from the tick closure so the dm tier can drive a pass directly and the
 * call-site guard has a module to pin.
 *
 * Cost model: `autoFlipIfReady` is stage-ordered — mode read, hold read, warning scan are CHEAP
 * (a members read + at most one oracle call per agent; audit reads ride the
 * `(team_id, created_at desc)` index filtered by action). The EXPENSIVE stage (the full
 * prepare→drain→assess sequence) is entered only by warning-free candidates, and THAT is what
 * the rate limit bounds: every permissive team gets the cheap stages every pass (so a changed
 * team un-latches promptly and cheap deferrals cannot starve the queue), while at most
 * `PRET_FLIP_MAX_PER_TICK` teams may enter the drain stage per pass. A flipped team leaves the
 * permissive set, so the fleet converges without any rotation bookkeeping.
 */
export const PRET_FLIP_MAX_PER_TICK = resolvePositiveInt(process.env.PRET_FLIP_MAX_PER_TICK, 3);

export interface AutoFlipPassResult {
  /** Teams whose expensive flip attempt ran this pass (≤ PRET_FLIP_MAX_PER_TICK). */
  attempted: string[];
  flipped: string[];
  /** Teams deferred this pass (cheap OR expensive stage), with their reasons for the trace. */
  deferred: Array<{ teamId: string; blockers: string[]; warnings: string[]; error?: string }>;
}

export async function runAutoFlipPass(db: DbClient): Promise<AutoFlipPassResult> {
  const result: AutoFlipPassResult = { attempted: [], flipped: [], deferred: [] };
  const { data, error } = await db.from("teams").select("id").eq("access_enforcement", "permissive");
  if (error) return result; // a teams-read failure flips nothing — default-deny, next tick retries
  let drainBudget = PRET_FLIP_MAX_PER_TICK;
  for (const t of (data ?? []) as { id: string }[]) {
    // EVERY permissive team gets the cheap stages every pass; only the expensive stage is
    // budgeted (`drainAllowed`). A ready team past the budget queues silently; a flipped team
    // leaves the permissive set, so the fleet converges with no rotation bookkeeping.
    const r = await autoFlipIfReady(db, t.id, { drainAllowed: drainBudget > 0 });
    if (r.drained) {
      drainBudget--;
      result.attempted.push(t.id);
    }
    if (r.flipped) result.flipped.push(t.id);
    if (r.deferred) result.deferred.push({ teamId: t.id, ...r.deferred });
  }
  return result;
}
