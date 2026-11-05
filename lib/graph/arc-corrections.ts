import "server-only";
import type { DbClient } from "@/lib/db/types";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import {
  ArcSynthesisAuthorizationChangedError,
  authorizedItemIdsForArcPartition,
} from "./arc-input-authorization";

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
  /** Server-captured from the exact cached arc. Callers never submit this over the wire. */
  source_item_ids?: readonly string[];
  source_correction_revision_ids?: readonly string[];
  provenance_state?: "unproven" | "incomplete" | "complete";
  captured_authorization_epoch?: number | null;
}

export interface StoredArcCorrection extends ArcCorrectionInput {
  id: string;
  revision_id: string | null;
  revision_number: number;
  group_key: string;
  source_dependency_count: number;
  parent_revision_count: number;
  created_by: string | null;
  updated_at: string;
}

/** How many corrections feed a synthesis. Bounded because they all go into the prompt — an unbounded
 *  history would crowd out the facts the arcs are supposed to be about. Newest first. */
export const CORRECTION_PROMPT_LIMIT = 20;

export async function arcCorrectionVersion(teamId: string, lock = false): Promise<number> {
  if (process.env.NODE_ENV === "test" && !process.env.DATABASE_URL) return 0;
  const result = await runSql<{ version: string | number }>(
    `select version from team_arc_correction_versions where team_id = $1${lock ? " for update" : ""}`,
    [teamId],
  );
  return Number(result.rows[0]?.version ?? 0);
}

/**
 * Upsert corrections for a team. Latest take per arc PER SCOPE wins (`arc_corrections_scope_arc_key`) —
 * two corrections on the same arc in one scope would otherwise argue inside one prompt, while the
 * same arc corrected in two DIFFERENT scopes is two independent editorial acts (Fable 6b High 2).
 */
export async function recordArcCorrections(
  _db: DbClient,
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
  const normalized = [...byArc.values()].map((c) => {
    const sourceItemIds = [...new Set(c.source_item_ids ?? [])];
    const parentRevisionIds = [...new Set(c.source_correction_revision_ids ?? [])];
    const complete = c.provenance_state === "complete"
      && sourceItemIds.length > 0
      && Number.isSafeInteger(c.captured_authorization_epoch)
      && Number(c.captured_authorization_epoch) > 0;
    return {
      input: c,
      sourceItemIds,
      parentRevisionIds,
      provenanceState: complete ? "complete" : c.provenance_state === "incomplete" ? "incomplete" : "unproven",
    } as const;
  });
  await withTransaction(async () => {
    for (const { input, sourceItemIds, parentRevisionIds, provenanceState } of normalized) {
      // Serialize on the logical identity. Text/dependencies are append-only revisions; the logical row
      // only advances its current pointer, so a concurrent editor can never replace another revision's
      // authority evidence.
      const logical = await runSql<{ id: string }>(
        `insert into arc_corrections
           (team_id, arc_id, arc_title, corrected_text, group_key, provenance_state,
            source_dependency_count, captured_authorization_epoch, created_by, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         on conflict (team_id,group_key,arc_id) do update set
           arc_title=excluded.arc_title, corrected_text=excluded.corrected_text,
           provenance_state=excluded.provenance_state,
           source_dependency_count=excluded.source_dependency_count,
           captured_authorization_epoch=excluded.captured_authorization_epoch,
           created_by=excluded.created_by, updated_at=now()
         returning id`,
        [teamId, input.arc_id, input.arc_title, input.corrected_text, groupKey, provenanceState,
          sourceItemIds.length, input.captured_authorization_epoch ?? null, memberId],
      );
      const correctionId = logical.rows[0]?.id;
      if (!correctionId) throw new Error("recordArcCorrections failed to resolve logical correction");
      await runSql(`select id from arc_corrections where id = $1 for update`, [correctionId]);
      const revision = await runSql<{ id: string }>(
        `insert into arc_correction_revisions
           (correction_id, revision_number, corrected_text, provenance_state,
            source_dependency_count, parent_revision_count, captured_authorization_epoch, created_by)
         select $1, coalesce(max(revision_number),0)+1, $2,$3,$4,$5,$6,$7
         from arc_correction_revisions where correction_id=$1 returning id`,
        [correctionId, input.corrected_text, provenanceState, sourceItemIds.length, parentRevisionIds.length,
          input.captured_authorization_epoch ?? null, memberId],
      );
      const revisionId = revision.rows[0]?.id;
      if (!revisionId) throw new Error("recordArcCorrections failed to create revision");
      for (const sourceItemId of sourceItemIds) {
        await runSql(
          `insert into arc_correction_revision_dependencies (revision_id,team_id,source_item_id)
           values ($1,$2,$3)`,
          [revisionId, teamId, sourceItemId],
        );
      }
      let insertedParents = 0;
      for (const parentRevisionId of parentRevisionIds) {
        const parent = await runSql(
          `insert into arc_correction_revision_parents (revision_id,parent_revision_id)
           select $1,r.id from arc_correction_revisions r
           join arc_corrections c on c.id=r.correction_id
           where r.id=$2 and c.team_id=$3 on conflict do nothing`,
          [revisionId, parentRevisionId, teamId],
        );
        insertedParents += parent.rowCount;
      }
      if (insertedParents !== parentRevisionIds.length) {
        await runSql(`update arc_correction_revisions set provenance_state='incomplete' where id=$1`, [revisionId]);
      }
      await runSql(`update arc_corrections set current_revision_id=$2 where id=$1`, [correctionId, revisionId]);
    }
    await runSql(
      `insert into team_arc_correction_versions (team_id,version,updated_at) values ($1,1,now())
       on conflict (team_id) do update set version=team_arc_correction_versions.version+1, updated_at=now()`,
      [teamId],
    );
    await runSql(`update arc_cache set computed_at='1970-01-01T00:00:00Z' where team_id=$1`, [teamId]);
  });
}

/** Rollback never mutates history: it advances the logical pointer to an existing immutable revision. */
export async function rollbackArcCorrection(teamId: string, correctionId: string, revisionId: string): Promise<void> {
  await withTransaction(async () => {
    const target = await runSql<{ id: string }>(
      `select r.id from arc_correction_revisions r join arc_corrections c on c.id=r.correction_id
       where r.id=$1 and c.id=$2 and c.team_id=$3 for update`,
      [revisionId, correctionId, teamId],
    );
    if (!target.rows[0]) throw new Error("correction revision not found");
    await runSql(`update arc_corrections set current_revision_id=$2, updated_at=now() where id=$1`, [correctionId, revisionId]);
    await runSql(
      `insert into team_arc_correction_versions (team_id,version,updated_at) values ($1,1,now())
       on conflict (team_id) do update set version=team_arc_correction_versions.version+1, updated_at=now()`,
      [teamId],
    );
    await runSql(`update arc_cache set computed_at='1970-01-01T00:00:00Z' where team_id=$1`, [teamId]);
  });
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
  _db: DbClient,
  teamId: string,
  /** PCCC6B-1 scope rule: EXACT group_key match only — a correction never feeds a different scope.
   *  `includeLegacy` additionally admits pre-6b `''` rows; ONLY the tier path may set it (legacy
   *  rows are tier-scope by construction — the recompute route has always refused external
   *  principals — and a partition scope accepting them would be the laundering this closes). */
  scope: { groupKey: string; includeLegacy: boolean },
  limit = CORRECTION_PROMPT_LIMIT
): Promise<{ corrections: StoredArcCorrection[]; ok: boolean }> {
  try {
    const result = await runSql<Record<string, unknown>>(
      `select c.id, c.arc_id, c.arc_title, c.group_key, c.created_by, c.updated_at,
              r.id as revision_id, coalesce(r.revision_number,0) as revision_number,
              coalesce(r.corrected_text,c.corrected_text) as corrected_text,
              coalesce(r.provenance_state,c.provenance_state,'unproven') as provenance_state,
              coalesce(r.source_dependency_count,c.source_dependency_count,0) as source_dependency_count,
              coalesce(r.parent_revision_count,0) as parent_revision_count,
              coalesce(r.captured_authorization_epoch,c.captured_authorization_epoch) as captured_authorization_epoch
       from arc_corrections c
       left join arc_correction_revisions r on r.id=c.current_revision_id
       where c.team_id=$1 and c.group_key = any($2::text[])
       order by c.updated_at desc, c.arc_id asc limit $3`,
      [teamId, scope.includeLegacy ? [scope.groupKey, ""] : [scope.groupKey], limit],
    );
    // ONE take per arc across the ADMITTED scope set (second-pass 6b Medium): the tier read
    // admits [tierKey, ''] — a pre-6b legacy row and its post-6b re-correction are DIFFERENT rows
    // under the per-scope arbiter, and without this both takes argue inside one prompt forever
    // (the exact state the unique exists to prevent, reintroduced across the migration boundary).
    // The winner rule is SEMANTIC, not clock-based: a SCOPED row beats the legacy ('') row for
    // its arc regardless of timestamps — recordArcCorrections stamps the APP clock at millisecond
    // precision while raw/legacy rows carry the DB clock at microsecond precision, so a
    // re-correction written <1ms after (or with app/DB clock skew against) the legacy row FLOORS
    // to an earlier updated_at and "newest-first" resurrected the rejected take (caught red in
    // CI + a loaded local run, green standalone — QMIR-1's CI, latent since 6b). Among rows of
    // the SAME legacy-ness the per-scope unique guarantees one row per arc, so updated_at order
    // never has to arbitrate within a class. A superseded twin briefly costs one of the LIMIT
    // slots — bounded, and it ages out of the window.
    const newestPerArc: Record<string, unknown>[] = [];
    const winnerIdx = new Map<string, number>();
    for (const r of result.rows) {
      const arcId = String(r.arc_id ?? "");
      const held = winnerIdx.get(arcId);
      if (held === undefined) {
        winnerIdx.set(arcId, newestPerArc.length);
        newestPerArc.push(r);
      } else if (String(newestPerArc[held].group_key ?? "") === "" && String(r.group_key ?? "") !== "") {
        newestPerArc[held] = r; // the scoped re-correction supersedes its legacy row, in place
      }
    }
    const corrections = newestPerArc.map((r) => ({
      id: String(r.id ?? ""),
      revision_id: r.revision_id == null ? null : String(r.revision_id),
      revision_number: Number(r.revision_number ?? 0),
      arc_id: String(r.arc_id ?? ""),
      arc_title: String(r.arc_title ?? ""),
      corrected_text: String(r.corrected_text ?? ""),
      group_key: String(r.group_key ?? ""),
      provenance_state: String(r.provenance_state ?? "unproven") as StoredArcCorrection["provenance_state"],
      source_dependency_count: Number(r.source_dependency_count ?? 0),
      parent_revision_count: Number(r.parent_revision_count ?? 0),
      captured_authorization_epoch: r.captured_authorization_epoch == null
        ? null
        : Number(r.captured_authorization_epoch),
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

/**
 * Synthesis/projection reader. History and eligibility are deliberately separate: an unproven,
 * incomplete, deleted, or revoked correction remains inspectable in `arc_corrections`, but never
 * becomes prompt/graph prose. The captured epoch is audit metadata only; live dependency authority is
 * always re-resolved under `expectedAuthorizationEpoch`.
 */
export async function listAuthorizedArcCorrections(
  db: DbClient,
  teamId: string,
  scope: { groupKey: string; partitionGroup: string; expectedAuthorizationEpoch: number },
  limit = CORRECTION_PROMPT_LIMIT,
): Promise<{ corrections: StoredArcCorrection[]; ok: boolean }> {
  const history = await listArcCorrections(db, teamId, { groupKey: scope.groupKey, includeLegacy: false }, limit);
  if (!history.ok) return history;
  const candidates = history.corrections.filter(
    (correction) => correction.revision_id != null
      && correction.provenance_state === "complete" && correction.source_dependency_count > 0,
  );
  if (candidates.length === 0) return { corrections: [], ok: true };
  try {
    const { data, error } = await db.from("arc_correction_revision_dependencies")
      .select("revision_id,source_item_id")
      .eq("team_id", teamId)
      .in("revision_id", candidates.map((correction) => correction.revision_id).filter(Boolean));
    if (error) throw new Error(error.message);
    const dependencies = new Map<string, Set<string>>();
    for (const row of (data ?? []) as Array<{ revision_id: string; source_item_id: string }>) {
      const ids = dependencies.get(row.revision_id) ?? new Set<string>();
      ids.add(row.source_item_id);
      dependencies.set(row.revision_id, ids);
    }
    const revisionIds = candidates.map((correction) => correction.revision_id).filter((id): id is string => !!id);
    const parentRead = await db.from("arc_correction_revision_parents")
      .select("revision_id,parent_revision_id").in("revision_id", revisionIds);
    if (parentRead.error) throw new Error(parentRead.error.message);
    const parents = new Map<string, Set<string>>();
    for (const row of (parentRead.data ?? []) as Array<{ revision_id: string; parent_revision_id: string }>) {
      const ids = parents.get(row.revision_id) ?? new Set<string>();
      ids.add(row.parent_revision_id);
      parents.set(row.revision_id, ids);
    }
    const allParentIds = [...new Set([...parents.values()].flatMap((ids) => [...ids]))];
    const parentStates = new Map<string, string>();
    if (allParentIds.length) {
      const stateRead = await db.from("arc_correction_revisions").select("id,provenance_state").in("id", allParentIds);
      if (stateRead.error) throw new Error(stateRead.error.message);
      for (const row of (stateRead.data ?? []) as Array<{ id: string; provenance_state: string }>) {
        parentStates.set(row.id, row.provenance_state);
      }
    }
    const authorized = await authorizedItemIdsForArcPartition(db, {
      teamId,
      partitionGroup: scope.partitionGroup,
      expectedAuthorizationEpoch: scope.expectedAuthorizationEpoch,
    });
    return {
      corrections: candidates.flatMap((correction) => {
        const ids = correction.revision_id ? dependencies.get(correction.revision_id) : null;
        const parentIds = correction.revision_id ? (parents.get(correction.revision_id) ?? new Set<string>()) : new Set<string>();
        const eligible = correction.revision_id != null && ids != null
          && ids.size === correction.source_dependency_count
          && [...ids].every((id) => authorized.has(id))
          && parentIds.size === correction.parent_revision_count
          && [...parentIds].every((id) => parentStates.get(id) === "complete");
        return eligible ? [{
          ...correction,
          source_item_ids: [...ids!].sort(),
          source_correction_revision_ids: [...parentIds].sort(),
        }] : [];
      }),
      ok: true,
    };
  } catch (error) {
    // An epoch change is not an ordinary provenance-read failure: the route's bounded retry must
    // rebuild the partition, visible arc set, correction dependencies, and prompt under one new
    // authorization epoch. Converting it to `ok: false` would let the old attempt limp onward with
    // an empty correction set instead of re-resolving the caller's authority.
    if (error instanceof ArcSynthesisAuthorizationChangedError) throw error;
    console.error(
      "[arcs] could not authorize correction dependencies — refusing correction prose:",
      error instanceof Error ? error.message : error,
    );
    return { corrections: [], ok: false };
  }
}
