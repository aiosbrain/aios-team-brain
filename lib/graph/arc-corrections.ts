import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * SOLE WRITER of `arc_corrections` — the durable home for human edits to narrative arcs (Pass-1 H13).
 *
 * These used to live only as `correction:<arc_id>` episodes in Graphiti, written inside a swallowed
 * catch. That made a rebuildable projection the system of record for the one thing in the learning layer
 * a human actually authored: a graph rollback erased every correction, and a failed write reverted the
 * user's edit within one cache TTL with nothing logged. Postgres holds them now; the graph episode is a
 * projection of this table, not the other way round.
 *
 * The write is deliberately NOT best-effort. Everything else on the arc path degrades quietly because a
 * cache can be recomputed — a person's edit cannot. Telling someone their correction saved when it
 * didn't is the worst outcome available here, so a failure propagates and the route answers honestly.
 */

export interface ArcCorrectionInput {
  /** sha(title) today — see the note in the migration; it churns, so it's a dedup key, not a join key. */
  arc_id: string;
  arc_title: string;
  corrected_text: string;
}

export interface StoredArcCorrection extends ArcCorrectionInput {
  created_by: string | null;
  updated_at: string;
}

/** How many corrections feed a synthesis. Bounded because they all go into the prompt — an unbounded
 *  history would crowd out the facts the arcs are supposed to be about. Newest first. */
export const CORRECTION_PROMPT_LIMIT = 20;

/**
 * Upsert corrections for a team. Latest take per arc PER SCOPE wins (`arc_corrections_scope_arc_key`) —
 * two corrections on the same arc in one scope would otherwise argue inside one prompt, while the
 * same arc corrected in two DIFFERENT scopes is two independent editorial acts (Fable 6b High 2).
 */
export async function recordArcCorrections(
  db: DbClient,
  teamId: string,
  memberId: string | null,
  corrections: readonly ArcCorrectionInput[],
  /** PCCC6B-1: the SYNTHESIS SCOPE this correction was made in (the arc-cache group_key of the
   *  arcs the corrector was looking at). A correction only ever feeds same-scope synthesis. */
  groupKey: string
): Promise<void> {
  if (corrections.length === 0) return;
  // Last write wins within a batch. Postgres refuses an ON CONFLICT that would touch the same row twice
  // ("cannot affect row a second time"), and the API takes an array — so a caller that isn't the UI can
  // send two takes on one arc and get a 500 instead of a save.
  const byArc = new Map(corrections.map((c) => [c.arc_id, c]));
  const now = new Date().toISOString();
  const { error } = await db.from("arc_corrections").upsert(
    [...byArc.values()].map((c) => ({
      team_id: teamId,
      arc_id: c.arc_id,
      arc_title: c.arc_title,
      corrected_text: c.corrected_text,
      group_key: groupKey,
      created_by: memberId,
      updated_at: now,
    })),
    // Per-SCOPE identity (Fable 6b High 2): `arc_id` is sha(title) and near-identical scopes
    // synthesize identical titles, so a team-global conflict target let member B's correction
    // silently MOVE member A's row into B's scope — A's next exact-match read lost it and A's
    // arcs reverted (H13, cross-member). One take per arc PER SCOPE.
    { onConflict: "team_id,group_key,arc_id" }
  );
  if (error) throw new Error(`recordArcCorrections failed: ${error.message}`);
}

/**
 * Every correction that should inform this team's next synthesis, newest first.
 *
 * Read on EVERY synthesis, not just the recompute that created one. That's what makes a correction
 * durable in the way that matters: it used to reach later synthesis only by having become a Graphiti
 * fact, so wiping the graph didn't just lose the record — it lost the influence. Reading from Postgres
 * means a rebuilt graph still produces corrected arcs.
 *
 * Reports `ok: false` rather than degrading quietly. "Synthesis without corrections" sounds like a safe
 * fallback and is not: pre-correction behaviour IS the version a human rejected. Swallowing the error
 * would drop them from `userPrompt`, change `factsHash`, re-run the model, and stamp the uncorrected
 * arcs FRESH for 4h — H13's exact user-visible symptom (the edit reverts on its own) coming back through
 * a new door, and H11's shape besides. The caller marks the synthesis degraded instead, which keeps the
 * corrected prior and retries soon.
 */
export async function listArcCorrections(
  db: DbClient,
  teamId: string,
  /** PCCC6B-1 scope rule: EXACT group_key match only — a correction never feeds a different scope.
   *  `includeLegacy` additionally admits pre-6b `''` rows; ONLY the tier path may set it (legacy
   *  rows are tier-scope by construction — the recompute route has always refused external
   *  principals — and a partition scope accepting them would be the laundering this closes). */
  scope: { groupKey: string; includeLegacy: boolean },
  limit = CORRECTION_PROMPT_LIMIT
): Promise<{ corrections: StoredArcCorrection[]; ok: boolean }> {
  try {
    const { data, error } = await db
      .from("arc_corrections")
      .select("arc_id, arc_title, corrected_text, created_by, updated_at")
      .eq("team_id", teamId)
      .in("group_key", scope.includeLegacy ? [scope.groupKey, ""] : [scope.groupKey])
      .order("updated_at", { ascending: false })
      // A whole batch is written with ONE `now`, so `updated_at` alone leaves equal-timestamp rows in
      // whatever order the plan returns. That flips the prompt's order between refreshes, which flips
      // `factsHash`, which intermittently defeats the reuse skip — the same reason `recentFacts` is
      // uuid-tiebroken.
      .order("arc_id", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);
    // NEWEST take per arc across the ADMITTED scope set (second-pass 6b Medium): the tier read
    // admits [tierKey, ''] — a pre-6b legacy row and its post-6b re-correction are DIFFERENT rows
    // under the per-scope arbiter, and without this both takes argue inside one prompt forever
    // (the exact state the unique exists to prevent, reintroduced across the migration boundary).
    // Rows arrive updated_at DESC, so first-seen per arc_id is the newest. A superseded twin
    // briefly costs one of the LIMIT slots — bounded, and it ages out of the window.
    const newestPerArc: Record<string, unknown>[] = [];
    const seenArcs = new Set<string>();
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const arcId = String(r.arc_id ?? "");
      if (seenArcs.has(arcId)) continue;
      seenArcs.add(arcId);
      newestPerArc.push(r);
    }
    const corrections = newestPerArc.map((r) => ({
      arc_id: String(r.arc_id ?? ""),
      arc_title: String(r.arc_title ?? ""),
      corrected_text: String(r.corrected_text ?? ""),
      created_by: (r.created_by as string | null) ?? null,
      updated_at:
        r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at ?? ""),
    }));
    return { corrections, ok: true };
  } catch (err) {
    console.error(
      "[arcs] could not read stored corrections — refusing to synthesize without them:",
      err instanceof Error ? err.message : err
    );
    return { corrections: [], ok: false };
  }
}
