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
 * Upsert corrections for a team. Latest take per arc wins (`unique (team_id, arc_id)`) — two corrections
 * on the same arc would otherwise argue with each other inside one prompt.
 */
export async function recordArcCorrections(
  db: DbClient,
  teamId: string,
  memberId: string | null,
  corrections: readonly ArcCorrectionInput[]
): Promise<void> {
  if (corrections.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await db.from("arc_corrections").upsert(
    corrections.map((c) => ({
      team_id: teamId,
      arc_id: c.arc_id,
      arc_title: c.arc_title,
      corrected_text: c.corrected_text,
      created_by: memberId,
      updated_at: now,
    })),
    { onConflict: "team_id,arc_id" }
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
 * Best-effort: a correction that can't be read should not take the arcs panel down with it. It degrades
 * to "synthesis without corrections", which is the pre-correction behaviour, and the row is still there
 * for the next attempt.
 */
export async function listArcCorrections(
  db: DbClient,
  teamId: string,
  limit = CORRECTION_PROMPT_LIMIT
): Promise<StoredArcCorrection[]> {
  try {
    const { data, error } = await db
      .from("arc_corrections")
      .select("arc_id, arc_title, corrected_text, created_by, updated_at")
      .eq("team_id", teamId)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      arc_id: String(r.arc_id ?? ""),
      arc_title: String(r.arc_title ?? ""),
      corrected_text: String(r.corrected_text ?? ""),
      created_by: (r.created_by as string | null) ?? null,
      updated_at:
        r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at ?? ""),
    }));
  } catch (err) {
    console.error(
      "[arcs] could not read stored corrections — synthesizing without them:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}
