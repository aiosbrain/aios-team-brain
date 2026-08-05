import "server-only";
import { createHash } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { GraphitiClient, type GraphEpisode } from "./graphiti-client";
import { episodeGroupId, isExternalGroupId, type AccessTier } from "./group";
import { episodeName, itemIdFromEpisodeName } from "./episode-name";
import { resolvePositiveInt } from "@/lib/util/env";
import { sourceRules } from "@/lib/ingest/source-rules";
// Re-exported so the graph module's existing importers (and their specs) keep one import path.
export { resolvePositiveInt };

/**
 * Brain → Graphiti projector. Reads already-normalized, tier-tagged rows from the brain (`items` —
 * ALL ingestions: Slack transcripts, GitHub/Notion/Drive deliverables, decisions, tasks, …) and
 * pushes them to Graphiti as episodes. The SOLE writer of `graph_episodes` (the idempotency-state
 * table) — single-writer guarded.
 *
 * Idempotent: re-projecting an unchanged row is a no-op (matched by content hash); changed content
 * re-pushes (Graphiti's temporal model supersedes the old fact). Source of truth stays the brain;
 * Graphiti is a downstream projection.
 */

const SOURCE_TABLE = "items";

/**
 * How many ids go into one `.in(...)` filter. The pg adapter binds each element separately and
 * Postgres hard-caps a statement at 65535 binds, so an unbounded list is a query that simply stops
 * working once a team's corpus grows — silently, at exactly the scale where it matters most.
 */
export const IN_CLAUSE_BATCH = 1000;

/** Split into fixed-size batches. Pure. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Graphiti extracts entities/edges from each episode with its OWN LLM, and that call's OUTPUT is
 * hard-capped (graphiti_core `DEFAULT_MAX_TOKENS`; 16384 — native in the 0.29.3 image and asserted by
 * the build, no longer a patched constant). A dense episode whose extraction output overflows that cap raises `Output length exceeded
 * max tokens` in `resolve_extracted_nodes`, so it's accepted (202) but never becomes facts — the item's
 * work then never appears in the graph or narrative arcs (prod 2026-06/07). Truncating to fit LOSES
 * content, so instead we CHUNK: a large item is projected as several small episodes (`items:<id>#0`,
 * `#1`, …), each ≤ `CHUNK_CHARS`, preserving all content while keeping every episode extractable.
 * `MAX_EPISODE_CHUNKS` caps a pathologically huge item (full text still lives in `items`/pgvector/FTS
 * regardless; median item ~240 chars = a single chunk, unchanged from before). Both env-tunable. See
 * the "202 ≠ extracted" note in docs/ARCHITECTURE.md.
 */
/**
 * Parse a positive-integer env knob, falling back to `fallback` on anything malformed. A bad
 * `GRAPH_CHUNK_CHARS`/`GRAPH_MAX_EPISODE_CHUNKS` must NOT silently break projection: `Number("")` is 0
 * and `Number("abc")` is NaN. A 0/NaN chunk SIZE makes `chunkContent` emit empty-content episodes; a
 * 0/NaN chunk CAP makes it emit none — either way the projector "succeeds" feeding the graph nothing
 * (or garbage). `Math.floor` also closes the fractional hole (0.5 → 0). Pure + exported, unit-tested.
 */
export const CHUNK_CHARS = resolvePositiveInt(process.env.GRAPH_CHUNK_CHARS, 2500);
export const MAX_EPISODE_CHUNKS = resolvePositiveInt(process.env.GRAPH_MAX_EPISODE_CHUNKS, 16);
/**
 * The chunk sizing the per-chunk ledger's hashes were produced under, recorded alongside them
 * (`graph_episodes.chunk_config`). `content_sha256` hashes the WHOLE body and is invariant to
 * chunking, so it cannot detect a config change: raising `MAX_EPISODE_CHUNKS` leaves every early
 * chunk hashing identically while the newly-admitted tail chunks have never been pushed, and a
 * ledger without this would report them as already extracted. A mismatch forces a full push.
 */
export const CHUNK_CONFIG = `${CHUNK_CHARS}x${MAX_EPISODE_CHUNKS}`;

/**
 * How many episodes to scan when resolving an item's chunk names → uuids for a delete (tier-cleanup)
 * or an emptiness check. `listEpisodes` defaults to the most-recent 1000; in a group past that, a
 * reclassified item's episodes fall outside the window, so the delete finds nothing and SILENTLY
 * no-ops — leaving the old-tier facts searchable (Pass-1 review B2). We scan deep so the delete is
 * real for any realistic group; a group larger than this keeps its `pending_delete_group_id` set
 * (reconcile never confirms it empty) rather than reporting a false success.
 */
export const GROUP_SCAN_DEPTH = resolvePositiveInt(process.env.GRAPH_GROUP_SCAN_DEPTH, 100_000);

/**
 * The projector's cadence — how long a pushed episode has to land before the NEXT run could re-push it.
 *
 * Owned here rather than in the scheduler because it has two consumers that must agree: the scheduler
 * (which sets the timer) and reconcile (whose "never landed" grace is derived from it — H7). Two
 * independent readings of one env var is the H6 shape: the copies drift and nothing fails loudly.
 * Guarded by `test/guards/graph-interval-single-source.test.ts`.
 */
export const PROJECTION_MINUTES = resolvePositiveInt(process.env.GRAPH_PROJECT_MINUTES, 60);
export const PROJECTION_INTERVAL_MS = PROJECTION_MINUTES * 60_000;

/**
 * "When it happened" for an episode: the item's PERSISTED `work_at` (Pass-1 review R1).
 *
 * This used to re-derive from frontmatter and fall back to `synced_at`, and the fallback was the bug:
 * `synced_at` is bumped by every 30-minute re-sync tick, so an item the source never dated — a Linear
 * or Plane deliverable, the issues aggregate, any sidecar doc whose metadata key we don't know — was
 * re-stamped "now" on EVERY tick. Backfilling an old corpus flooded the newest-facts pool and pinned
 * arcs about months-old docs at the top of Pulse; a mere tier reclassification re-dated old work as
 * today. The doc's "never now()" claim was technically true and practically false.
 *
 * `work_at` is resolved once at ingest through the same resolver and written down, with `created_at`
 * (never bumped) as its fallback — so an undated item is dated when we FIRST saw it, and stays there.
 *
 * FORWARD-ONLY: episode idempotency is keyed on `sha(item.body)` (+ tier), NOT on the timestamp, so
 * an item already projected under the old sync-time stamp is `skipped` and KEEPS it until its body
 * changes — which a commit never does. Arc impact ages out on its own (arcs read a 7-day window),
 * but historical `valid_at` stays wrong until a backfill re-projects: it must `deleteItemEpisodes`
 * FIRST (a bare `graph_episodes` delete re-pushes duplicates under the same names) and reset the
 * runner's `synced_at` cursor so old rows are re-scanned. Tracked as follow-up, not done here.
 */
export function pickEpisodeTimestamp(item: { work_at?: string | Date | null; synced_at: string }): string {
  // `?? synced_at` is a belt-and-braces path for a row written before the column existed; the migration
  // backfills every row, so it should be unreachable in practice.
  if (!item.work_at) return item.synced_at;
  const d = item.work_at instanceof Date ? item.work_at : new Date(item.work_at);
  return Number.isNaN(d.getTime()) ? item.synced_at : d.toISOString();
}

/**
 * Split an item's body into ≤ `maxChunks` chunks of ≤ `chunkChars` each, preserving every character
 * (content beyond `chunkChars * maxChunks` is dropped — a runaway-size backstop, not the common path).
 * Whitespace-only bodies yield `[]` (nothing to extract). Pure + unit-tested; the chunk boundaries are
 * deterministic so the content hash (taken over the full body) stays stable across runs.
 */
export function chunkContent(body: string, chunkChars = CHUNK_CHARS, maxChunks = MAX_EPISODE_CHUNKS): string[] {
  const text = body ?? "";
  if (!text.trim()) return [];
  // Clamp the params too (not just the env at module load) so a direct caller passing 0/NaN can't
  // emit empty/garbage chunks or stall the loop — belt-and-suspenders around the same landmine.
  const size = resolvePositiveInt(chunkChars, CHUNK_CHARS);
  const cap = resolvePositiveInt(maxChunks, MAX_EPISODE_CHUNKS);
  const chunks: string[] = [];
  for (let i = 0; i < text.length && chunks.length < cap; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

/** Item kinds worth projecting as graph episodes — content-bearing knowledge, not raw config.
 * `skill`/`blueprint` are configuration manifests, not events/knowledge, so they're excluded. */
export const PROJECTABLE_KINDS = ["transcript", "deliverable", "decision", "task", "artifact"] as const;

/** Human label per kind for the episode's source description (provenance the LLM extractor sees). */
const KIND_LABEL: Record<string, string> = {
  transcript: "Transcript",
  deliverable: "Document",
  decision: "Decision",
  task: "Task",
  artifact: "Artifact",
  skill: "Skill",
  blueprint: "Blueprint",
};

export interface ProjectSummary {
  scanned: number;
  /** ITEMS projected. One item becomes 1..MAX_EPISODE_CHUNKS episodes — see `episodes`. */
  projected: number;
  /**
   * EPISODES pushed to Graphiti, which is what extraction actually costs per unit. Distinct from
   * `projected` because `chunkContent` splits a large item into up to `MAX_EPISODE_CHUNKS` (16), so
   * the two differ by the corpus's chunk mix. The cost metric divides LLM calls by THIS — dividing by
   * items instead lets a shift toward chunkier documents look like a model regression.
   */
  episodes: number;
  skipped: number;
  /** Items whose episodes were removed from the EXTERNAL group this batch — a NARROWING reaching the
   * graph. The caller uses it to invalidate the external-tier caches: arcs are synthesized FROM that
   * group, so purging them at reclassification time isn't enough — a rebuild between then and this
   * cleanup re-synthesizes over the still-dirty group and stamps the result FRESH. Direction-aware on
   * purpose: a WIDENING leaks nothing, and purging for it would force a needless cold re-synthesis. */
  externalGroupVacated: number;
  /** `synced_at` of the last row scanned this batch — the cursor the runner pages forward from
   * (audit H2). `undefined` when the batch was empty (nothing left to scan). */
  lastSyncedAt?: string;
}

type ItemRow = {
  id: string;
  /** Persisted work-time (R1) — the episode's `valid_at`. */
  work_at?: string | Date | null;
  kind: string;
  access: AccessTier;
  body: string | null;
  path: string;
  synced_at: string;
  frontmatter: Record<string, unknown> | null;
};

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * RETIRE the graph episodes of items being REMOVED from the brain (the purge path). `graph_episodes`
 * is written only from this module (single-writer guarded), so removal lives here too and
 * `lib/ingest/purge` calls in.
 *
 * Deleting the `items` rows alone is not enough, and the ledger row is the smaller half of why:
 * `graph_episodes` has no FK to `items`, so the row is orphaned — but the real leak is that the
 * extracted FACTS stay searchable in Graphiti forever. For a private channel or a message the author
 * deleted at the source, removing the brain's copy while the graph still answers questions from it
 * is not a removal at all.
 *
 * Durability follows the tier-reclassification cleanup (Pass-1 B2) exactly, for the same reason: the
 * inline delete is best-effort — Graphiti can blip, and its async worker can create a straggler chunk
 * AFTER we listed the group. So the ledger row is KEPT and flagged `pending_delete_group_id`;
 * `reconcileProjectedEpisodes` retries until the group is verified empty and only then drops the row
 * (it recognises a purge tombstone by the item being gone). Deleting the row here would leave nothing
 * to retry — the failure mode B2 exists to prevent, arriving through a new door.
 *
 * Returns the number of ledger rows retired.
 */
export async function retireEpisodesForItems(
  db: DbClient,
  teamId: string,
  itemIds: string[],
  opts: { client?: GraphitiClient } = {}
): Promise<number> {
  if (itemIds.length === 0) return 0;
  type LedgerRow = {
    id: string;
    source_id: string;
    group_id: string;
    pending_delete_group_id: string | null;
  };
  // Chunked: the pg adapter expands `.in()` to one bind per element, and Postgres refuses a statement
  // past 65535 of them. A whole-channel purge can easily exceed a single readable batch.
  const rows: LedgerRow[] = [];
  for (const batch of chunk(itemIds, IN_CLAUSE_BATCH)) {
    const { data, error: readError } = await db
      .from("graph_episodes")
      .select("id, source_id, group_id, pending_delete_group_id")
      .eq("team_id", teamId)
      .eq("source_table", SOURCE_TABLE)
      .in("source_id", batch);
    if (readError) throw new Error(`episode ledger read: ${readError.message}`);
    rows.push(...((data ?? []) as LedgerRow[]));
  }
  if (rows.length === 0) return 0;

  const client = opts.client ?? new GraphitiClient();
  // No Graphiti configured → nothing was ever pushed, so there is nothing to retry and no reconcile
  // pass will ever run to clear a tombstone. Drop the rows outright instead of parking flags that
  // would sit "pending" forever and read as a stuck cleanup.
  //
  // Narrow residue, stated rather than hidden: if Graphiti was configured EARLIER and has since been
  // unset, episodes it holds outlive the ledger row that pointed at them. Re-configuring the same
  // Graphiti and re-projecting is the recovery; there is no in-band way to reach a service the
  // process has no address for.
  if (!client.configured) {
    for (const r of rows) {
      const { error } = await db.from("graph_episodes").delete().eq("id", r.id);
      if (error) throw new Error(`episode ledger delete ${r.id}: ${error.message}`);
    }
    return rows.length;
  }

  const at = new Date().toISOString();
  for (const r of rows) {
    await deleteItemEpisodes(client, r.group_id, r.source_id).catch(() => {});
    // There is exactly ONE flag slot, so a row that already owed a cleanup for a DIFFERENT group is
    // about to have that debt overwritten. Purge that group first: otherwise an item reclassified
    // external→team (whose inline delete blipped) and then purged would clean the team group, lose
    // the pointer to the external one, and leave the purged content searchable at the OLD tier
    // forever with nothing to retry. Best-effort like the rest; if it fails, reconcile re-derives the
    // orphan every pass and the flag is re-pointed there once this group verifies empty.
    if (r.pending_delete_group_id && r.pending_delete_group_id !== r.group_id) {
      await deleteItemEpisodes(client, r.pending_delete_group_id, r.source_id).catch(() => {});
    }
    const { error } = await db
      .from("graph_episodes")
      .update({
        // The "" sentinel marks the content as no longer projected (same as the redaction path), so
        // nothing treats this row as a live projection while the cleanup is outstanding.
        content_sha256: "",
        projected_at: at,
        pending_delete_group_id: r.group_id,
        pending_delete_at: at,
      })
      .eq("id", r.id);
    if (error) throw new Error(`episode retire ${r.id}: ${error.message}`);
  }
  return rows.length;
}

/**
 * Delete ALL of an item's episodes (every chunk: `items:<id>` and `items:<id>#k`) from `groupId`, and
 * return how many were deleted. `/messages` is fire-and-forget and never returns a uuid, so we resolve
 * names→uuids via `listEpisodes` (audit M6), scanning `GROUP_SCAN_DEPTH` deep so the delete doesn't
 * silently no-op on a large group. Throws on a Graphiti error (list or delete) — the caller decides
 * whether to retry (the projector records the group as pending-delete; reconcile finishes it). A chunk
 * the async worker never created simply isn't found and doesn't count.
 */
export async function deleteItemEpisodes(
  client: GraphitiClient,
  groupId: string,
  itemId: string
): Promise<number> {
  const episodes = await client.listEpisodes(groupId, GROUP_SCAN_DEPTH);
  let deleted = 0;
  for (const e of episodes) {
    if (itemIdFromEpisodeName(e.name) === itemId) {
      await client.deleteEpisode(e.uuid);
      deleted++;
    }
  }
  return deleted;
}

/**
 * The episode(s) + provenance for an item, labeled by kind. A normal item → ONE episode (plain
 * `items:<id>` name, unchanged from before); a large item → SEVERAL chunk episodes (`items:<id>#k`,
 * each ≤ CHUNK_CHARS, "(part k/N)" in the description) so every chunk stays under Graphiti's extraction
 * cap. Empty body → `[]` (skipped upstream — nothing to extract).
 */
function toEpisodes(item: ItemRow): GraphEpisode[] {
  const fm = item.frontmatter ?? {};
  const title = typeof fm.title === "string" ? fm.title : undefined;
  const url = typeof fm.source_url === "string" ? fm.source_url : undefined;
  const ts = pickEpisodeTimestamp(item); // when it happened (see helper)
  const label = KIND_LABEL[item.kind] ?? "Item";
  const chunks = chunkContent(item.body ?? "");
  const total = chunks.length;
  return chunks.map((content, i) => ({
    content,
    timestamp: ts,
    sourceDescription: `${label} — ${title ?? item.path}${total > 1 ? ` (part ${i + 1}/${total})` : ""}${url ? ` (${url})` : ""}`,
    name: episodeName(item.id, i, total),
  }));
}

/**
 * Project this team's items into Graphiti. `kinds` selects which item kinds to project (default:
 * PROJECTABLE_KINDS — all content-bearing ingestions). `since` (ISO) bounds the backfill; `limit`
 * caps a single run (episodes are LLM-extracted on Graphiti's side — keep runs bounded). Rows with
 * an empty body are skipped (nothing to extract).
 */
export async function projectItemsToGraph(
  db: DbClient,
  args: {
    teamId: string;
    teamSlug: string;
    client?: GraphitiClient;
    kinds?: readonly string[];
    since?: string;
    limit?: number;
  }
): Promise<ProjectSummary> {
  const client = args.client ?? new GraphitiClient();
  const limit = args.limit ?? 50;
  const kinds: readonly string[] = args.kinds ?? PROJECTABLE_KINDS;

  let q = db
    .from("items")
    .select("id, kind, access, body, path, synced_at, work_at, frontmatter")
    .eq("team_id", args.teamId)
    .order("synced_at", { ascending: true })
    .limit(limit);
  // The DEFAULT (full) projection scans EVERY kind and decides projectability per row below, so an item
  // whose kind changed to a non-projectable one (deliverable → skill) still reaches the cleanup branch
  // instead of dropping out of the projector's view with its old episodes stranded in the graph — a
  // permanent tier leak by the same mechanism B2 closes. A caller that names `kinds` explicitly
  // (projectSlackToGraph) keeps its exact scope: it must not touch other kinds' episodes.
  if (args.kinds) q = q.in("kind", args.kinds as string[]);
  if (args.since) q = q.gt("synced_at", args.since);
  const { data, error } = await q;
  if (error) throw new Error(`project: load items failed: ${error.message}`);
  const rows = (data ?? []) as ItemRow[];

  let projected = 0;
  let episodesPushed = 0;
  let skipped = 0;
  let externalGroupVacated = 0;
  for (const item of rows) {
    const episodes = kinds.includes(item.kind) ? toEpisodes(item) : [];
    // Idempotency key = the FULL body (chunk boundaries derive deterministically from it), so an
    // unchanged item is a no-op regardless of how many chunks it splits into.
    const contentSha = sha(item.body ?? "");
    const groupId = episodeGroupId(args.teamSlug, item.access);

    // Read the ledger BEFORE the "nothing to project" skip: an item that stops projecting still owns
    // episodes we put in the graph, and they have to come back out (see the branch below).
    const { data: existing } = await db
      .from("graph_episodes")
      .select("content_sha256, group_id, pending_delete_group_id, chunk_shas, chunk_config")
      .eq("team_id", args.teamId)
      .eq("source_table", SOURCE_TABLE)
      .eq("source_id", item.id)
      .maybeSingle();
    const existingRow = existing as {
      content_sha256: string;
      group_id: string;
      pending_delete_group_id: string | null;
      chunk_shas: string[] | null;
      chunk_config: string | null;
    } | null;
    // Per-chunk ledger for THIS pass: the hashes of exactly the episodes we would send. Derived from
    // `episodes` rather than re-chunking, so the ledger can never describe something else.
    const chunkShas = episodes.map((e) => sha(e.content));

    if (episodes.length === 0) {
      // Nothing to extract NOW — but if we projected this item before, its old episodes are still in
      // the graph. This is the redaction/blanking path (a body emptied upstream, with or without a tier
      // flip) and the kind-change path: both used to `continue` straight past the tier-change block
      // below, so the ledger kept pointing at the old group, `pending_delete_group_id` was never set,
      // and the pre-redaction episodes stayed searchable by the OLD tier forever with nothing to retry
      // — the exact leak B2 closes, arriving by a door B2 didn't cover. Record the holding group as
      // pending-delete (reconcile purges it durably) and park the row on the "" sentinel sha so the
      // projector re-pushes if the body ever comes back.
      //
      // Only when no cleanup is already outstanding: re-recording every pass would reset
      // `pending_delete_at` and the grace would never elapse. The single flag slot converges — the
      // outstanding one is cleaned and cleared, then the next pass records this one.
      if (existingRow && !existingRow.pending_delete_group_id) {
        await deleteItemEpisodes(client, existingRow.group_id, item.id).catch(() => {});
        const at = new Date().toISOString();
        await db.from("graph_episodes").upsert(
          {
            team_id: args.teamId,
            source_table: SOURCE_TABLE,
            source_id: item.id,
            group_id: existingRow.group_id, // nothing was pushed to the new group — don't claim it
            content_sha256: "",
            projected_at: at,
            pending_delete_group_id: existingRow.group_id,
            pending_delete_at: at,
          },
          { onConflict: "team_id,source_table,source_id" }
        );
      }
      skipped++;
      continue;
    }

    const tierChanged = existingRow !== null && existingRow.group_id !== groupId;
    // Pushing back INTO a group we still owe a purge on (a redaction that was undone before reconcile
    // finished): the pending purge deletes by item id, so leaving the flag set would delete the episodes
    // we're about to push and silently drop the item from the graph. Purge the stale ones first, then
    // this push is authoritative and the flag clears below.
    const purgeBeforeRepush = existingRow?.pending_delete_group_id === groupId;
    if (existingRow && existingRow.content_sha256 === contentSha && !tierChanged && !purgeBeforeRepush) {
      // BACKFILL (GRAPHCOST-1): a row written before the per-chunk ledger existed knows the body is
      // unchanged but not which chunks that body is made of. Record them here — from the same
      // `toEpisodes` output the last push used, for a body proven identical by `content_sha256` — so
      // the corpus converges as the projector walks it instead of re-extracting itself on deploy.
      // No episodes are sent, so `projected_at` is deliberately NOT bumped (see the push path).
      //
      // The premise — "an identical body means these are the chunks we pushed" — holds only while the
      // chunk config is the one that produced them, which an empty ledger cannot attest. So a rollout
      // that changes CHUNK_CHARS/MAX_EPISODE_CHUNKS must invalidate by clearing `content_sha256` to
      // `''`, NOT by clearing `chunk_shas`: the sentinel misses the unchanged-skip above and fails the
      // delta predicate, forcing a real re-push. Emptying `chunk_shas` alone would route the row
      // straight through here and bless the new config's hashes for chunks never pushed under it.
      if (chunkShas.length > 0 && (existingRow.chunk_shas?.length ?? 0) === 0) {
        await db.from("graph_episodes").upsert(
          {
            team_id: args.teamId,
            source_table: SOURCE_TABLE,
            source_id: item.id,
            group_id: existingRow.group_id,
            content_sha256: existingRow.content_sha256,
            chunk_shas: chunkShas,
            chunk_config: CHUNK_CONFIG,
          },
          { onConflict: "team_id,source_table,source_id" }
        );
      }
      skipped++;
      continue; // unchanged content, same tier → no-op (idempotent)
    }

    // Audit M6 (durability hardened — Pass-1 review B2): a tier reclassification (e.g. external→team)
    // must not leave the old episodes searchable in the old group. We RECORD the old group as
    // pending-delete regardless of the inline attempt below, because the inline delete is best-effort
    // and can silently fail (a Graphiti blip) or miss a chunk the async worker creates AFTER it runs —
    // and once the ledger flips `group_id` to the new group, nothing would ever retry, leaving the old
    // tier searchable forever. `reconcile` retries the cleanup until the old group is verified empty and
    // only then clears `pending_delete_group_id`. The inline delete stays as the fast path.
    if (tierChanged && existingRow) {
      if (isExternalGroupId(existingRow.group_id)) externalGroupVacated++;
      await deleteItemEpisodes(client, existingRow.group_id, item.id).catch(() => {});
    }
    // RETRACTABLE SOURCES: replace, don't append. `addEpisodes` does not overwrite by name — Graphiti
    // keeps the old episode and the facts extracted from it — so for a source whose body is a
    // re-render of content the source can retract (Slack: `retainSupersededBodies: false`), a deleted
    // message would go on answering questions through the graph after Postgres had forgotten it. That
    // is the same leak `forget-bodies` closes in `item_versions`, on the surface that is actually
    // served. Shrinking past a chunk boundary is worse still: the orphan tail episode isn't even
    // overwritten in name. Best-effort like the other inline deletes; the re-push below is
    // authoritative and reconcile re-derives anything left behind.
    // Skipped when `purgeBeforeRepush` already deletes from this exact group below — that branch
    // watches its own result to decide whether the pending flag may clear, and a redundant deep scan
    // here would only cost a second full listing of the group.
    let retractFailed = false;
    if (
      existingRow &&
      !purgeBeforeRepush &&
      !sourceRules((item.frontmatter ?? {}).source).retainSupersededBodies
    ) {
      // WATCHED, not fire-and-forget. Every other inline delete here is backed by a durable flag,
      // and this one needs it most: `addEpisodes` below lands regardless, so a swallowed failure
      // leaves the pre-deletion episode in the graph with a fresh sha on the ledger — the landed
      // check is satisfied by the new push, orphan repair needs the item to be GONE, and no flag was
      // recorded. Nothing would ever revisit it, so one blip (and `deleteItemEpisodes` opens with a
      // deep `listEpisodes`, which is exactly what times out under load) strands retracted text
      // answering questions forever. Recording the group (see `pending` below) routes it into
      // `purgeBeforeRepush` on the next pass, which retries and converges.
      //
      // `tierChanged` can in principle also be true here and wins the `pending` ternary below,
      // dropping this debt — considered, and empty in practice: for both to be live the item must
      // already have resided in the NEW group, and any outstanding debt for that group would have set
      // `purgeBeforeRepush`, which skips this branch entirely. What's left is the straggler-chunk
      // residue the module documents already.
      retractFailed = await deleteItemEpisodes(client, groupId, item.id).then(
        () => false,
        () => true
      );
    }
    // Independent of the tier check, NOT an else-arm: on a double flip (A→B→A while A's cleanup is
    // still outstanding) both are true, and the push target is exactly the group holding the stale
    // episodes the flag was recorded for. Skipping it there would leave them beside the fresh push.
    let purgeFailed = false;
    if (purgeBeforeRepush) {
      purgeFailed = await deleteItemEpisodes(client, groupId, item.id).then(
        () => false,
        () => true
      );
    }

    // A failed purge with UNCHANGED content must not re-push. The prior push is still in the group
    // (that is why the delete was attempted), so pushing again adds a duplicate — and because the
    // flag stays set, the next pass forces past the sha skip and does it again: one duplicate per
    // item per hourly pass while Graphiti's delete path is unhealthy, growing the group until the
    // deep `listEpisodes` times out and the delete can never succeed. That self-amplifying shape is
    // exactly what reconcile's saturated-group guard refuses to feed. Skipping the push leaves the
    // existing episodes and the outstanding flag, so the retry converges instead of compounding.
    const contentUnchanged = existingRow?.content_sha256 === contentSha;

    // DELTA (GRAPHCOST-1): push only the chunks whose content actually changed. Every term below is
    // load-bearing — each one is a state in which the ledger's per-chunk knowledge does not describe
    // what is in the group we are about to push to, and trusting it would silently withhold content
    // from the graph. Anything failing this predicate takes the pre-existing full-push path verbatim,
    // which is what keeps this change out of the cleanup/retraction branches that own the leak fixes.
    //
    //  1. RETAINING SOURCE ONLY. A retractable source (Slack) deletes the item's episodes before every
    //     re-push, so "already pushed" is not a property its group has. It is also the surface carrying
    //     the retraction guarantee, and the measured churn is entirely in retaining sources — the risk
    //     would buy nothing. (`retractFailed` needs no term of its own: that branch only runs when
    //     retention is false, so it can never co-occur with this one.)
    //  2. SAME GROUP. A tier change means the target group has none of this item's episodes.
    //  3. NO CLEANUP OUTSTANDING ON ANY GROUP — `IS NULL`, not merely "not the push target". A pending
    //     cleanup on another group is still a cleanup, and reconcile may be about to force a re-push.
    //  4. LIVE PROJECTION, NOT A SENTINEL. `reconcile` re-queues a row that never landed by setting
    //     `content_sha256 = ''` and NOTHING else (lib/graph/reconcile.ts) — chunk_shas, group_id and the
    //     pending flag all survive. Without this term the other four hold, the delta finds every hash
    //     already recorded, pushes nothing, and reconcile re-queues it again next pass: a closed loop in
    //     which the item's content never reaches the graph while `projected_at` refreshes hourly and the
    //     ledger reads healthy. (Found in spec review — the failure mode of the whole change.)
    //  5. SAME CHUNK CONFIG. `content_sha256` hashes the whole body and is invariant to chunking, so a
    //     raised cap leaves the early chunks hashing identically while the new tail chunks were never
    //     pushed. The config is what completes the ledger's identity.
    const deltaEligible =
      existingRow !== null &&
      sourceRules((item.frontmatter ?? {}).source).retainSupersededBodies &&
      !tierChanged &&
      existingRow.pending_delete_group_id === null &&
      existingRow.content_sha256 !== "" &&
      existingRow.chunk_config === CHUNK_CONFIG;
    // NB: no `chunk_shas.length > 0` term. It would be unfalsifiable — an empty ledger yields an empty
    // `alreadyPushed`, so the diff below already degrades to a full push on its own. A predicate term
    // no test can redden is one the guard below would be asserting on trust.
    const alreadyPushed = new Set(deltaEligible ? (existingRow?.chunk_shas ?? []) : []);
    const toPush = deltaEligible ? episodes.filter((_, i) => !alreadyPushed.has(chunkShas[i])) : episodes;

    if (!(purgeFailed && contentUnchanged) && toPush.length > 0) {
      await client.addEpisodes(groupId, toPush);
    }

    // A pass that POSTed nothing must not claim it pushed: `extraction-health.newestEpisodeAtMs` reads
    // `max(projected_at) where content_sha256 <> ''` as "when did we last actually send an episode",
    // discriminating the existing bump-without-POST paths only by their `''` sentinel. A delta pass
    // writes a REAL digest, so bumping the timestamp here would be a third such path that the sentinel
    // cannot tell apart — and with a hot document edited past the extraction cap hourly, the lag probe
    // would report a false extraction stall on a perfectly healthy extractor. `reconcile`'s
    // "too recent to judge" grace reads the same column and would defer judging a push never re-attempted.
    const pushedSomething = toPush.length > 0 && !(purgeFailed && contentUnchanged);
    const projectedAt = new Date().toISOString();
    // Pending-delete bookkeeping for THIS push. Written only when it changes; an ordinary content
    // re-push omits both columns, so the pg upsert (which only SETs keys present in the object) leaves
    // an outstanding cleanup intact — that retention is what makes the flag durable.
    //
    // The flag is cleared ONLY on a purge we watched succeed. If that delete threw (a Graphiti blip),
    // clearing it would silently abandon the cleanup — the pre-redaction episodes would sit in the
    // group forever with nothing to retry and `pendingCleanups` reading 0, which is the failure mode
    // this whole mechanism exists to prevent. Keeping it set is safe: reconcile purges the group and
    // the landed-check's sentinel re-queue re-pushes, so the row converges to fresh-content-only.
    const pending: Record<string, string | null> =
      tierChanged && existingRow
        ? { pending_delete_group_id: existingRow.group_id, pending_delete_at: projectedAt }
        : // A retract-delete we watched FAIL records this group as owing a cleanup, so the pre-deletion
          // episode isn't stranded. It routes into `purgeBeforeRepush` on the next pass, which retries
          // the delete and only then clears the flag — the same convergence the tier path uses.
          retractFailed
          ? { pending_delete_group_id: groupId, pending_delete_at: projectedAt }
          : purgeBeforeRepush && !purgeFailed
            ? { pending_delete_group_id: null, pending_delete_at: null } // purge confirmed + re-pushed
            : {};

    await db.from("graph_episodes").upsert(
      {
        team_id: args.teamId,
        source_table: SOURCE_TABLE,
        source_id: item.id,
        group_id: groupId,
        content_sha256: contentSha,
        chunk_shas: chunkShas,
        chunk_config: CHUNK_CONFIG,
        // The whole current chunk list is recorded, not just what this pass sent: the next diff must
        // be against the item's full chunking, and this is last-state, never a union. A chunk that
        // disappears and later returns is therefore re-pushed — a cost, not a hole.
        ...(pushedSomething ? { projected_at: projectedAt } : {}),
        ...pending,
      },
      { onConflict: "team_id,source_table,source_id" }
    );
    if (pushedSomething) projected++;
    else skipped++; // ledger refreshed, nothing extracted — not work the health probes should see
    // What was ACTUALLY sent, not what the item chunks into. `episodes` is the denominator of the
    // per-episode extraction cost metric, so counting the item's full chunk list on a delta pass that
    // sent one chunk (or none) would divide real LLM calls by phantom episodes and make extraction
    // look cheaper per episode than it is. This also stops counting the `purgeFailed && contentUnchanged`
    // refusal, which pushes nothing and was previously counted.
    episodesPushed += pushedSomething ? toPush.length : 0;
  }

  // Cursor for the runner: rows are ordered by synced_at ascending, so the last row is the high-water
  // mark to page past next batch (audit H2). Without this the runner only ever re-scanned the oldest
  // `limit` rows and never reached items beyond that window.
  const lastSyncedAt = rows.length ? rows[rows.length - 1].synced_at : undefined;
  return { scanned: rows.length, projected, episodes: episodesPushed, skipped, externalGroupVacated, lastSyncedAt };
}

/** Back-compat: project only Slack transcripts. Prefer `projectItemsToGraph` (all ingestions). */
export async function projectSlackToGraph(
  db: DbClient,
  args: { teamId: string; teamSlug: string; client?: GraphitiClient; since?: string; limit?: number }
): Promise<ProjectSummary> {
  return projectItemsToGraph(db, { ...args, kinds: ["transcript"] });
}
