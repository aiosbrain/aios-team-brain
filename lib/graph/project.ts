import "server-only";
import { createHash } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { GraphitiClient, type GraphEpisode } from "./graphiti-client";
import { episodeGroupId, isExternalGroupId, type AccessTier } from "./group";
import { episodeName, itemIdFromEpisodeName } from "./episode-name";
import { resolvePositiveInt } from "@/lib/util/env";
import { chunkCdc, type CdcParams } from "./cdc";
import { sourceRules } from "@/lib/ingest/source-rules";
import { resolveFanoutTargets } from "@/lib/projects/context/fanout-targets";
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

// Batching now lives in lib/db/batch (PCCC-5: read-only substrate modules need it without
// importing — or cycling with — the projector); re-exported so existing importers keep one path.
import { chunk, IN_CLAUSE_BATCH } from "@/lib/db/batch";
export { chunk, IN_CLAUSE_BATCH };

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
/**
 * The TARGET AVERAGE chunk size under `cdc1` (PIPEFF-3), and the fixed chunk size under the legacy
 * byte-offset algorithm that a mixed corpus still stores rows for.
 *
 * ⚠️ CHANGING THIS MOVES EVERY BOUNDARY — but it no longer re-extracts the corpus in one billed burst.
 * Since CDC (PIPEFF-3) rolls out LAZILY, a config change is recorded per row: an item whose body has
 * not changed and whose stored chunking is provably COMPLETE (see `storedChunkingComplete`) keeps its
 * existing chunking indefinitely and is never re-pushed. What a change to this knob does cost is
 * (a) the items whose bodies change afterwards, which re-chunk under the new value — normal traffic —
 * and (b) items that fail completeness under their stored config (clipped at their old cap), which
 * full-re-push once. The old "~$47, the whole corpus, immediately" warning was true of the eager
 * invalidation this constant used to trigger and is no longer what happens.
 * See docs/design/content-defined-chunking.md and docs/design/graph-extraction-cap.md.
 */
export const CHUNK_CHARS = resolvePositiveInt(process.env.GRAPH_CHUNK_CHARS, 2500);
/**
 * The `cdc1` MINIMUM chunk size — **a content-safety bound, not a tuning knob.**
 *
 * `MAX_EPISODE_CHUNKS` caps an item at N *chunks* and drops everything past it (the CHUNKCAP-1 class
 * this repo has already paid for once). Under byte-offset chunking N chunks always meant
 * `N × CHUNK_CHARS` characters. Under CDC it means "however much text N content-defined windows happen
 * to cover" — so without a floor, a pathological body producing many small chunks would hit the cap far
 * sooner and drop text that is currently ingested. `CHUNK_MIN_CHARS × MAX_EPISODE_CHUNKS` is therefore
 * the real guarantee, and the pair must be kept at or above the 100,000 characters the byte-offset era
 * guaranteed (1,250 × 80). Lowering this without raising the cap silently reduces how much of a large
 * document reaches the graph.
 */
export const CHUNK_MIN_CHARS = resolvePositiveInt(process.env.GRAPH_CHUNK_MIN_CHARS, 1250);
/**
 * The `cdc1` MAXIMUM chunk size — where a chunk is cut when no content-defined boundary is found.
 *
 * Sized from prod `llm_usage` rather than the textbook 2x ratio: over 30 days of `extract_edges` calls
 * (the widest-output kind at 2,500-char chunks) p99 output was 3,948 tokens — 24% of graphiti's 16,384
 * output ceiling — but **one call of 898 had already saturated that ceiling exactly**, silently
 * truncating its edges. 4,000 (rather than 5,000) puts p99 at ~38% of the ceiling. The pre-existing
 * saturation is filed as `EXTRUNC-1` (AIO-827), not absorbed here — silent truncation happens under any
 * chunking and the fix is detection-and-retry in extraction. But allowing 4,000-char chunks does raise
 * tail exposure by up to 1.6x on the largest chunks: watch `llm_usage` rows with `output_tokens = 16384`.
 */
export const CHUNK_MAX_CHARS = resolvePositiveInt(process.env.GRAPH_CHUNK_MAX_CHARS, 4000);
/** The `cdc1` size envelope, in UTF-16 code units. Derived from the effective env values. */
export const CDC_PARAMS: CdcParams = { target: CHUNK_CHARS, min: CHUNK_MIN_CHARS, max: CHUNK_MAX_CHARS };
/**
 * How many chunks an item may become — i.e. `CHUNK_MIN_CHARS * MAX_EPISODE_CHUNKS` is the hard *floor*
 * on how much of ANY item reaches the graph. Everything past the cap is dropped by `chunkContent`,
 * silently, forever.
 *
 * Raised 16 -> 40 on 2026-08-05 (AIO-808), then **40 -> 80 by PIPEFF-3**, and the second raise is a
 * REQUIREMENT of content-defined chunking rather than a tuning choice: CDC's floor is 1,250 rather than
 * a guaranteed 2,500 per chunk, so 40 chunks would guarantee only 50,000 characters against the
 * byte-offset era's 100,000. 1,250 x 80 = 100,000 restores exactly today's guarantee. Shipping CDC
 * without this raise would quietly reduce how much of a large document reaches the graph.
 *
 * History worth keeping: at 16 this had stopped being the "runaway-size backstop" its comment claimed —
 * 21 items were over it and **689,235 characters (8.6% of the corpus) had never entered the graph**,
 * concentrated in the densest documents we own (`ARCHITECTURE.md` 11.8% present, a Chetan/John meeting
 * transcript 54.5%). Surfacing the refused character count is specced
 * (docs/design/graph-extraction-cap.md §3) and still deliberately NOT built.
 *
 * ⚠️ Raising this is cheap in BOTH the old and the new world. Under `cdc1` the cap is not an input to
 * boundary computation at all — it only truncates the sequence — so `chunkConfigDeltaCompatible` treats
 * a CDC cap-grow as trustworthy and the delta pushes exactly the newly-admitted tail (179 episodes /
 * ~$1.77 for the 16->40 move). Note the 40->80 raise itself rides INSIDE the CDC config string, so this
 * cap-grow path is not the mechanism that runs during the CDC rollout — that is the lazy completeness
 * path. See docs/design/content-defined-chunking.md.
 */
export const MAX_EPISODE_CHUNKS = resolvePositiveInt(process.env.GRAPH_MAX_EPISODE_CHUNKS, 80);
/**
 * The chunking the per-chunk ledger's hashes were produced under, recorded alongside them
 * (`graph_episodes.chunk_config`). `content_sha256` hashes the WHOLE body and is invariant to
 * chunking, so it cannot detect a config change: raising `MAX_EPISODE_CHUNKS` leaves every early
 * chunk hashing identically while the newly-admitted tail chunks have never been pushed, and a
 * ledger without this would report them as already extracted.
 *
 * **Derived from the effective values by construction, never a literal** — so flipping a `GRAPH_CHUNK_*`
 * env is just a config change with the lazy semantics above, rather than a silent boundary change under
 * a stale label. Two forms exist and both are load-bearing:
 *
 *   - `"<chars>x<cap>"`  — legacy byte-offset chunking. No longer produced, but a mixed corpus stores it
 *                          on rows that have not changed since CDC shipped, indefinitely.
 *   - `"cdc1-<target>-<min>-<max>-<cap>"` — content-defined. `cdc1` pins the gear tables, the window,
 *                          the mask derivation and the UTF-16 unit; changing ANY of those is `cdc2`
 *                          (see lib/graph/cdc.ts).
 */
export const CHUNK_CONFIG = `cdc1-${CHUNK_CHARS}-${CHUNK_MIN_CHARS}-${CHUNK_MAX_CHARS}-${MAX_EPISODE_CHUNKS}`;

/** A parsed `chunk_config`. The two variants are different ALGORITHMS, never interchangeable. */
export type ParsedChunkConfig =
  | { kind: "legacy"; chars: number; cap: number }
  | { kind: "cdc1"; target: number; min: number; max: number; cap: number };

/**
 * Parse a stored `chunk_config` string. `null` for anything unparseable — including `""`, which is the
 * column default and a real stored value. An unparseable config must never read as something we can
 * reproduce; every consumer below treats `null` as "I cannot vouch for these hashes".
 */
export function parseChunkConfig(value: string | null | undefined): ParsedChunkConfig | null {
  const raw = (value ?? "").trim();
  const legacy = /^(\d+)x(\d+)$/.exec(raw);
  if (legacy) {
    const chars = Number(legacy[1]);
    const cap = Number(legacy[2]);
    return chars > 0 && cap > 0 ? { kind: "legacy", chars, cap } : null;
  }
  const cdc = /^cdc1-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(raw);
  if (cdc) {
    const [target, min, max, cap] = cdc.slice(1, 5).map(Number);
    return target > 0 && min > 0 && max > 0 && cap > 0 ? { kind: "cdc1", target, min, max, cap } : null;
  }
  return null;
}

/**
 * Can the chunk hashes stored under `stored` still be TRUSTED to identify chunks of the same body
 * under `current`? (AIO-808, extended for `cdc1` by PIPEFF-3)
 *
 * ONE asymmetry, in both algorithms: **the cap is not an input to boundary computation, it only
 * truncates the emitted sequence.** Under legacy that is obvious (`slice(i, i + chars)` stepping by
 * `chars`). Under `cdc1` it is a requirement the chunker upholds deliberately — for a fixed body under
 * fixed parameters the whole boundary sequence is a deterministic function of the body alone, and
 * nothing special-cases the final permitted chunk (pinned by test, because absorbing the remainder
 * there would break prefix stability at exactly chunk `cap−1`). So in both worlds, raising the cap
 * leaves every earlier chunk byte-identical and merely appends; changing any SIZE parameter moves
 * every boundary.
 *
 *   same config                  -> true    (the normal path)
 *   sizes same, cap GREW         -> true    stored hashes still match, so the delta pushes exactly the
 *                                           newly-admitted tail
 *   sizes same, cap SHRANK       -> false   the stored hashes past the new cap identify chunks the
 *                                           ledger would stop tracking. NOTE this is only "I cannot
 *                                           vouch for the ledger"; it is NOT a decision to re-push. A
 *                                           body-unchanged item that verifies COMPLETE under its stored
 *                                           config is LEFT ALONE by the skip below (PIPEFF-3) — the
 *                                           orphan tails a shrink creates are not fixed by re-extracting
 *                                           the head either (nothing purges them), so paying for it
 *                                           buys nothing.
 *   sizes DIFFER                 -> false   every boundary moved
 *   DIFFERENT ALGORITHMS         -> false   legacy vs cdc1 share no boundary in general
 *   malformed / "" / null        -> false   `""` is a real stored value
 *
 * ⚠️ THIS ANSWERS ONLY "can I trust the stored hashes". It does NOT answer "does this item still owe
 * chunks" — under a raised cap a body-identical item is compatible AND owes its tail, so the
 * unchanged-content skip must AND this with a count comparison. Using this alone at the skip is the
 * bug this feature shipped twice in review: the items it targets would all keep skipping.
 */
export function chunkConfigDeltaCompatible(stored: string | null | undefined, current: string): boolean {
  const a = parseChunkConfig(stored);
  const b = parseChunkConfig(current);
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "legacy" && b.kind === "legacy") return a.chars === b.chars && b.cap >= a.cap;
  if (a.kind === "cdc1" && b.kind === "cdc1") {
    return a.target === b.target && a.min === b.min && a.max === b.max && b.cap >= a.cap;
  }
  return false;
}

/**
 * How many episodes to scan when resolving an item's chunk names → uuids for a delete (tier-cleanup)
 * or an emptiness check. `listEpisodes` defaults to the most-recent 1000; in a group past that, a
 * reclassified item's episodes fall outside the window, so the delete finds nothing and SILENTLY
 * no-ops — leaving the old-tier facts searchable (Pass-1 review B2). We scan deep so the delete is
 * real for any realistic group; a group larger than this keeps its `pending_delete_group_id` set
 * (reconcile never confirms it empty) rather than reporting a false success.
 */
export const GROUP_SCAN_DEPTH = resolvePositiveInt(process.env.GRAPH_GROUP_SCAN_DEPTH, 100_000);

/** Armed fan-out pushes allowed per pass per team (PCCC-5, design §2.4 step 3) — a NEW projector
 * cap, deliberately distinct from reconcile's GRAPH_REQUEUE_MAX_PER_PASS (that one bounds
 * re-queues of already-owed pushes; this bounds NET-NEW extraction into initiative partitions).
 * Excess is counted in `fanoutThrottled`, never silently dropped — the next pass resumes. */
export const FANOUT_PUSH_MAX_PER_PASS = resolvePositiveInt(process.env.GRAPH_FANOUT_PUSH_MAX_PER_PASS, 25);

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
 * LEGACY byte-offset chunking: ≤ `maxChunks` chunks of ≤ `chunkChars` each, stepping by `chunkChars`.
 *
 * ⚠️ **THIS MUST REMAIN BYTE-EXACT FOREVER.** It is no longer how new content is chunked, but the CDC
 * rollout is deliberately LAZY: an item whose body has not changed keeps the chunking it was pushed
 * under, so `"<chars>x<cap>"` rows stay in `graph_episodes` indefinitely. Re-chunking one of those under
 * the stored config — which is how `storedChunkingComplete` decides to leave it alone — reproduces its
 * stored hashes only if this function is bit-for-bit what produced them. "Close enough" here means the
 * whole legacy corpus fails completeness and full-re-pushes, which is the ~$76 event the lazy rollout
 * exists to avoid.
 *
 * Whitespace-only bodies yield `[]` (nothing to extract), matching `chunkCdc`.
 */
export function chunkContentLegacy(
  body: string,
  chunkChars = CHUNK_CHARS,
  maxChunks = MAX_EPISODE_CHUNKS
): string[] {
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

/**
 * Chunk a body under a SPECIFIC stored config string — the dispatch that makes "re-chunk under the
 * config these hashes were produced with" expressible.
 *
 * Returns `null` for an unparseable config (including `""`, the column default). A caller that cannot
 * reproduce a row's chunking must treat it as unattestable rather than guessing with the current one:
 * guessing is precisely how a ledger comes to describe chunks that were never pushed.
 */
export function chunkContentUnderConfig(body: string, config: string | null | undefined): string[] | null {
  const parsed = parseChunkConfig(config);
  if (!parsed) return null;
  return parsed.kind === "legacy"
    ? chunkContentLegacy(body, parsed.chars, parsed.cap)
    : chunkCdc(body, { target: parsed.target, min: parsed.min, max: parsed.max }, parsed.cap);
}

/**
 * Split an item's body into episode-sized chunks under the CURRENT chunk config — the projector's own
 * chunking, and what `toEpisodes` uses.
 *
 * Content-defined since PIPEFF-3: boundaries are a function of the characters around them rather than
 * the distance from the start of the body, so an insertion perturbs the chunk it lands in and usually
 * nothing else (measured: a 33-char insertion near the top of a 50,000-char document re-extracted 21 of
 * 20 chunks under byte offsets and 1 under `cdc1`). Content past `MAX_EPISODE_CHUNKS` chunks is dropped
 * — a runaway-size backstop, bounded from below by `CHUNK_MIN_CHARS × MAX_EPISODE_CHUNKS`.
 * Whitespace-only bodies yield `[]` (nothing to extract). Pure + unit-tested; deterministic, so the
 * content hash (taken over the full body) stays stable across runs.
 */
export function chunkContent(body: string): string[] {
  return chunkCdc(body ?? "", CDC_PARAMS, MAX_EPISODE_CHUNKS);
}

/**
 * PIPEFF-3, the third case: are the stored hashes' chunks **provably the whole body**, even though the
 * chunking they were produced under is no longer the current one?
 *
 * This is what makes the CDC rollout lazy instead of a ~$76 re-extraction of text we already have. An
 * item whose body has not changed and whose stored chunking covers all of it is left alone forever; only
 * items that actually change get re-chunked under the new algorithm.
 *
 * **"Complete" must be defined precisely, because the loose definition is the hole.** It must NOT mean
 * `content_sha256` matches — that is the exact bug this codebase has shipped twice in review, since the
 * body sha is invariant to chunking. All four conditions:
 *
 *   1. re-chunk the body under the **stored** config (not the current one);
 *   2. **element-wise** hash equality with the stored `chunk_shas` — not count equality, which a
 *      coincidence of arity satisfies;
 *   3. the re-chunk **consumed the whole body**: fewer chunks than the stored cap, or chunk lengths
 *      summing to `body.length`. This is the free exact answer (term 1 already did the chunking) and is
 *      strictly better than the arithmetic proxy `storedMin × storedCap ≥ body.length`, which would
 *      condemn a 150K body fully covered in 60 of 80 chunks to a pointless re-extraction at every future
 *      config change. An item CLIPPED at its old cap is "complete under the stored config" in the loose
 *      sense while still owing content, and must NOT be left alone — or CDC would permanently re-strand
 *      exactly the population CHUNKCAP-1 existed to un-strand;
 *   4. an empty or unparseable `chunk_config` is **never** complete.
 */
export function storedChunkingComplete(args: {
  body: string;
  storedConfig: string | null | undefined;
  storedShas: readonly string[] | null | undefined;
  hash: (content: string) => string;
}): boolean {
  const parsed = parseChunkConfig(args.storedConfig); // (4)
  if (!parsed) return false;
  const stored = args.storedShas ?? [];
  if (stored.length === 0) return false; // an empty ledger attests nothing
  const rechunked = chunkContentUnderConfig(args.body, args.storedConfig); // (1)
  if (!rechunked || rechunked.length !== stored.length) return false;
  for (let i = 0; i < rechunked.length; i++) {
    if (args.hash(rechunked[i]) !== stored[i]) return false; // (2) element-wise, in order
  }
  const consumed = rechunked.reduce((n, c) => n + c.length, 0);
  return rechunked.length < parsed.cap || consumed === args.body.length; // (3)
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
   * `projected` because `chunkContent` splits a large item into up to `MAX_EPISODE_CHUNKS` chunks, so
   * the two differ by the corpus's chunk mix. The cost metric divides LLM calls by THIS — dividing by
   * items instead lets a shift toward chunkier documents look like a model regression.
   * (The parenthetical here used to name a literal "16"; it went stale the moment the cap moved to 40,
   * and again at 80. The constant is the only honest source.)
   */
  episodes: number;
  /**
   * `episodes` split by the group each was pushed into (PCCC-3, design §3). The cost gate's
   * denominator substrate: `graph_episodes` ROW counts cannot serve — a row is one ITEM, not one
   * episode (lib/metrics/graph-efficiency documents that exact wrong answer) and its `projected_at`
   * is mutable. This is per-pass and append-only once recorded to `ingest_runs.meta`.
   */
  episodesByGroup: Record<string, number>;
  /** Armed fan-out pushes MADE this call (items × groups) — the runner subtracts this from the
   * shared per-team budget it threads across batches (a per-call budget alone resets every page,
   * up to MAX_BATCHES× weaker than the claim — PCCC-5 review High 1). */
  fanoutPushed: number;
  /** Armed fan-out pushes withheld by the budget (PCCC-5). Non-zero for several runs in a row
   * means arming outpaces the budget — surfaced, never silent. */
  fanoutThrottled: number;
  /** Items whose restriction move is IN FLIGHT (home still Everyone-visible, copy not yet landed) —
   * the §rule-2 exposure population, observable per pass (PCCC-6 review High 3). */
  restrictionMovesPending: number;
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

/**
 * Flip a set of groups' DEFERRED rows to pushable — the arming side effect (PCCC-6). Lives here,
 * not in lib/graph/arming, because graph_episodes has ONE writer (single-writer guarded) and the
 * arming module owns only its own table. Idempotent; the projector's next pass pushes under its
 * fan-out budget.
 */
export async function armDeferredRowsForGroups(
  db: DbClient,
  teamId: string,
  groupIds: readonly string[]
): Promise<void> {
  for (const batch of chunk([...groupIds], IN_CLAUSE_BATCH)) {
    const { error } = await db
      .from("graph_episodes")
      .update({ deferred: false })
      .eq("team_id", teamId)
      .eq("deferred", true)
      .in("group_id", batch);
    if (error) throw new Error(`arming flip failed: ${error.message}`);
  }
}

/**
 * Restore the ledger pointer for a fan-out push whose post-push UPDATE matched zero rows (Codex
 * review High 2): reconcile's never-landed delete can eat an armed `''` row between the pass's
 * ledger read and its write — Graphiti then holds the accepted push with NO row anywhere. Write a
 * tombstone claiming the group with its own pending-delete, so reconcile durably purges whatever
 * lands; a racer re-creating the row concurrently wins the wide index and we flag THAT row's ''
 * state instead. Loud on every failure — a silent miss here is exactly the unledgered-content
 * class the reservation ordering exists to prevent.
 */
export async function recoverUnledgeredFanoutPush(
  db: DbClient,
  args: { teamId: string; itemId: string; groupId: string; partial: () => ProjectSummary }
): Promise<void> {
  const at = new Date().toISOString();
  const { error: insertErr } = await db.from("graph_episodes").insert({
    team_id: args.teamId,
    source_table: SOURCE_TABLE,
    source_id: args.itemId,
    group_id: args.groupId,
    content_sha256: "",
    chunk_shas: [],
    chunk_config: CHUNK_CONFIG,
    deferred: false,
    pending_delete_group_id: args.groupId,
    pending_delete_at: at,
  });
  if (insertErr && !insertErr.message.includes("graph_episodes_item_group_key")) {
    throw new ProjectionAbortError(
      `project: unledgered fan-out recovery failed for item ${args.itemId} in ${args.groupId}: ${insertErr.message}`,
      args.partial()
    );
  }
  if (insertErr) {
    // A racer holds the row. Flag it only if it is an unlanded sentinel — a completed row means the
    // racer's own final write already owns the state.
    const { error: flagErr } = await db
      .from("graph_episodes")
      .update({ pending_delete_group_id: args.groupId, pending_delete_at: at })
      .eq("team_id", args.teamId)
      .eq("source_table", SOURCE_TABLE)
      .eq("source_id", args.itemId)
      .eq("group_id", args.groupId)
      .eq("content_sha256", "")
      .is("pending_delete_group_id", null);
    if (flagErr) {
      throw new ProjectionAbortError(
        `project: unledgered fan-out flag failed for item ${args.itemId} in ${args.groupId}: ${flagErr.message}`,
        args.partial()
      );
    }
  }
}

/**
 * A pass that aborts LOUDLY mid-batch still incurred real extraction cost for everything it pushed
 * before the abort — losing those counts undercounts the Phase C cost gate's denominator
 * (code-review Codex Medium 3). The partial summary rides on the error so the runner records it.
 */
export class ProjectionAbortError extends Error {
  constructor(
    message: string,
    readonly partial: ProjectSummary
  ) {
    super(message);
    this.name = "ProjectionAbortError";
  }
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
    deferred: boolean;
  };
  // Chunked: the pg adapter expands `.in()` to one bind per element, and Postgres refuses a statement
  // past 65535 of them. A whole-channel purge can easily exceed a single readable batch.
  const allRows: LedgerRow[] = [];
  for (const batch of chunk(itemIds, IN_CLAUSE_BATCH)) {
    const { data, error: readError } = await db
      .from("graph_episodes")
      .select("id, source_id, group_id, pending_delete_group_id, deferred")
      .eq("team_id", teamId)
      .eq("source_table", SOURCE_TABLE)
      .in("source_id", batch);
    if (readError) throw new Error(`episode ledger read: ${readError.message}`);
    allRows.push(...((data ?? []) as LedgerRow[]));
  }
  // A DEFERRED row never pushed anything — there is nothing in any graph to purge, and a tombstone
  // would be a permanent zombie: reconcile exempts deferred rows from every judgement (incl. orphan
  // repair), the item is gone so the projector never scans it again, and `pendingCleanups` wouldn't
  // even count it (PCCC-5 review Medium 3). Hard-delete instead — the honest end state.
  const deferredRows = allRows.filter((r) => r.deferred);
  for (const r of deferredRows) {
    const { error } = await db.from("graph_episodes").delete().eq("id", r.id).eq("deferred", true);
    if (error) throw new Error(`deferred episode ledger delete ${r.id}: ${error.message}`);
  }
  const rows = allRows.filter((r) => !r.deferred);
  if (rows.length === 0) return deferredRows.length;

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
      if (error) throw new Error(`episode ledger delete : `);
    }
    return rows.length + deferredRows.length;
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
  return rows.length + deferredRows.length;
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
    /** Armed fan-out pushes allowed THIS pass (PCCC-5, design §2.4 step 3) — a NEW cap, distinct
     *  from reconcile's re-queue budget. Overridable for tests; env-tunable in prod. */
    fanoutPushBudget?: number;
  }
): Promise<ProjectSummary> {
  const client = args.client ?? new GraphitiClient();
  const limit = args.limit ?? 50;
  const kinds: readonly string[] = args.kinds ?? PROJECTABLE_KINDS;
  let fanoutBudget = args.fanoutPushBudget ?? FANOUT_PUSH_MAX_PER_PASS;

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

  // ── PCCC-5 pass-level context ─────────────────────────────────────────────────────────────────
  // The STORED pointers are the write authority (the rename doctrine's resolution): the home group
  // comes from the §11 built-ins' pointers, initiative fan-out targets from initiative pointers.
  // One read per pass; `episodeGroupId` stays as the quiet fallback for an unbootstrapped team
  // (no built-in rows yet — the scheduler-tick bootstrap converges it within a tick).
  const { data: pointerData, error: pointerErr } = await db
    .from("projects")
    .select("id, slug, kind, graph_group_id")
    .eq("team_id", args.teamId)
    .not("graph_group_id", "is", null);
  if (pointerErr) throw new Error(`project: pointer read failed: ${pointerErr.message}`);
  const pointers = (pointerData ?? []) as { id: string; slug: string; kind: string; graph_group_id: string }[];
  const generalHome = pointers.find((p) => p.kind === "system" && p.slug === "general")?.graph_group_id ?? null;
  const externalHome =
    pointers.find((p) => p.kind === "system" && p.slug === "external-shared")?.graph_group_id ?? null;
  const initiativeGroupByProject = new Map(
    pointers.filter((p) => p.kind === "initiative").map((p) => [p.id, p.graph_group_id])
  );
  const initiativeGroups = new Set(initiativeGroupByProject.values());

  // Batch-resolve each item's ACTIVE initiative include memberships — via the read-only substrate
  // module (the access-single-writer guard's coarse net rightly refuses those table literals in a
  // file full of write verbs).
  const generalProject = pointers.find((p) => p.kind === "system" && p.slug === "general") ?? null;
  const { targets: fanoutTargetsByItem, inGeneral } = await resolveFanoutTargets(db, {
    teamId: args.teamId,
    itemIds: rows.map((r) => r.id),
    initiativeGroupByProject,
    generalProjectId: generalProject?.id ?? null,
  });

  let projected = 0;
  let episodesPushed = 0;
  const episodesByGroup: Record<string, number> = {};
  let skipped = 0;
  let externalGroupVacated = 0;
  let fanoutThrottled = 0;
  let fanoutPushed = 0;
  let restrictionMovesPending = 0;
  // What this pass has ALREADY done, snapshotted at abort time — every loud throw below carries it
  // (ProjectionAbortError) so the runner can record the real partial episode counts.
  const partialSummary = (): ProjectSummary => ({
    scanned: rows.length,
    projected,
    episodes: episodesPushed,
    episodesByGroup: { ...episodesByGroup },
    skipped,
    externalGroupVacated,
    fanoutPushed,
    fanoutThrottled,
    restrictionMovesPending,
  });
  for (const item of rows) {
    const episodes = kinds.includes(item.kind) ? toEpisodes(item) : [];
    // Idempotency key = the FULL body (chunk boundaries derive deterministically from it), so an
    // unchanged item is a no-op regardless of how many chunks it splits into.
    const contentSha = sha(item.body ?? "");
    // HOME group from the STORED pointer (PCCC-5 — dissolves the rename divergence: the pointer is
    // frozen where the graph actually lives, while a recomputed slug key would follow the rename
    // into an empty group). Fallback to the legacy computation only when the built-in isn't
    // pointed yet — pre-PCCC-5 behavior for a NEVER-pointed, never-renamed team (the common case).
    // Named residual (review Medium 5): a PARTIALLY bootstrapped team that also renamed can hold a
    // home row in the old slug's group that neither home candidate nor the initiative set names —
    // that row falls out of homeWorld and the item re-projects into the new-slug group (duplicate
    // extraction; the old row waits for PCCC-6's ownerless-row sweep). Ruled acceptable: it needs
    // a failed pointer write AND a rename, and the scheduler-tick bootstrap closes the window.
    const groupId =
      (item.access === "external" ? externalHome : generalHome) ?? episodeGroupId(args.teamSlug, item.access);
    // BOTH home candidates, for partitioning the item's ledger rows: a tier flip moves between
    // these two; everything else in the ledger is fan-out (or an orphan PCCC-6 will own).
    const otherHome =
      (item.access === "external" ? generalHome : externalHome) ??
      episodeGroupId(args.teamSlug, item.access === "external" ? "team" : "external");

    // Read the ledger BEFORE the "nothing to project" skip: an item that stops projecting still owns
    // episodes we put in the graph, and they have to come back out (see the branch below).
    //
    // ALL of the item's rows, not `.maybeSingle()` (PCCC-3): the identity is per-(item, group) now,
    // and this adapter's maybeSingle returns rows[0] SILENTLY on multiple rows — under fan-out that
    // reads an arbitrary group's ledger, and a sha-match against the wrong group skips extraction
    // into a group that never got the content (a silently-empty project graph).
    const { data: existingData, error: ledgerReadErr } = await db
      .from("graph_episodes")
      .select("content_sha256, group_id, pending_delete_group_id, chunk_shas, chunk_config, deferred")
      .eq("team_id", args.teamId)
      .eq("source_table", SOURCE_TABLE)
      .eq("source_id", item.id);
    if (ledgerReadErr) {
      throw new ProjectionAbortError(`project: ledger read failed for item ${item.id}: ${ledgerReadErr.message}`, partialSummary());
    }
    type LedgerRow = {
      content_sha256: string;
      group_id: string;
      pending_delete_group_id: string | null;
      chunk_shas: string[] | null;
      chunk_config: string | null;
      deferred: boolean;
    };
    const rowsForItem = (existingData ?? []) as LedgerRow[];
    // PARTITION (PCCC-5): the home machinery below (tier moves, purges, delta) must see ONLY the
    // home world — the current home group and the OTHER home candidate (a tier flip moves between
    // exactly those two). Fan-out rows (deferred, or in a known initiative group) are a separate
    // life cycle; an unrecognized non-home row (its initiative was deleted) is deliberately left
    // for PCCC-6's removed-side machinery rather than fed to the tier-move logic, which would
    // relocate it and clobber a partition that was never a tier group. Belt-and-braces terms, named
    // per the unfalsifiable-terms rule (review Low 7): `!r.deferred` here and the home exclusions in
    // fanoutRows are redundant under today's writers (deferred rows only ever target initiative
    // groups) — they defend against a FUTURE writer bug, not a reachable state, and no test can
    // redden them.
    const homeWorld = rowsForItem.filter(
      (r) => !r.deferred && (r.group_id === groupId || r.group_id === otherHome)
    );
    const currentRow = homeWorld.find((r) => r.group_id === groupId) ?? null;
    const staleRows = homeWorld.filter((r) => r.group_id !== groupId);
    const existingRow = currentRow ?? staleRows[0] ?? null;
    const fanoutRows = rowsForItem.filter(
      (r) => r.group_id !== groupId && r.group_id !== otherHome && (r.deferred || initiativeGroups.has(r.group_id))
    );
    // Per-chunk ledger for THIS pass: the hashes of exactly the episodes we would send. Derived from
    // `episodes` rather than re-chunking, so the ledger can never describe something else.
    const chunkShas = episodes.map((e) => sha(e.content));

    // ── PCCC-5 fan-out (ADD-only — design §2.2), as a closure because it must run on BOTH exits ──
    // A new initiative membership DEFERS (bookkeeping row, zero LLM — cold initiatives never
    // extract); arming (PCCC-6) flips `deferred` and the push happens here under the budget. The
    // removed side handled in this slice is ONLY the never-pushed deferred row (deleting it touches
    // no graph content); purging armed/pushed content on untag is PCCC-6's leak-critical machinery.
    // A CLOSURE invoked both on the unchanged-content skip and on the normal path: the home skip
    // fires exactly when an armed row is waiting or an untag needs cleanup (the second pass over an
    // unchanged item), so hanging fan-out off only the changed path would freeze it forever —
    // caught red by this slice's own arm/untag tests before shipping.
    const runFanout = async (): Promise<void> => {
      const targets = fanoutTargetsByItem.get(item.id) ?? new Set<string>();
      const fanoutByGroup = new Map(fanoutRows.map((r) => [r.group_id, r]));
      for (const target of targets) {
        if (fanoutByGroup.has(target) || episodes.length === 0) continue;
        const { error: deferErr } = await db.from("graph_episodes").insert({
          team_id: args.teamId,
          source_table: SOURCE_TABLE,
          source_id: item.id,
          group_id: target,
          content_sha256: "",
          chunk_shas: [],
          chunk_config: CHUNK_CONFIG,
          deferred: true,
        });
        // A wide-index conflict is benign (a racer/prior pass already holds the pair) — never stomp.
        if (deferErr && !deferErr.message.includes("graph_episodes_item_group_key")) {
          throw new ProjectionAbortError(
            `project: deferred fan-out write failed for item ${item.id}: ${deferErr.message}`,
            partialSummary()
          );
        }
      }
      for (const r of fanoutRows) {
        if (r.deferred && !targets.has(r.group_id)) {
          // Untag of a never-pushed row: pure bookkeeping. The in-loop `r.deferred` gate is the
          // PINNED layer (mutation-verified); the SQL `deferred = true` predicate below is
          // belt-and-braces against the one window the gate can't see — a row ARMED between this
          // pass's ledger read and this delete would otherwise be dropped while a push for it may
          // already be in flight. Unpinnable without interleaving hooks; named here and in the PR
          // rather than silently trusted.
          const { error: dropErr } = await db
            .from("graph_episodes")
            .delete()
            .eq("team_id", args.teamId)
            .eq("source_table", SOURCE_TABLE)
            .eq("source_id", item.id)
            .eq("group_id", r.group_id)
            .eq("deferred", true);
          if (dropErr) {
            throw new ProjectionAbortError(
              `project: deferred fan-out cleanup failed for item ${item.id}: ${dropErr.message}`,
              partialSummary()
            );
          }
          continue;
        }
        if (!r.deferred && !targets.has(r.group_id)) {
          // PCCC-6 removed-side ACTIVATION: an untagged row that PUSHED holds restricted-away
          // content in P's graph — tombstone ('' sha + self pending flag; reconcile purges
          // durably, and the partition suppresses until it confirms). Never touches rows still
          // in the target set.
          if (r.pending_delete_group_id) continue; // already owed — converging
          if (r.content_sha256 === "") {
            // Purge CONFIRMED (reconcile cleared the flag but keeps rows) — finish the lifecycle by
            // DELETING the row: membership is gone so nothing re-creates it, and leaving it parked
            // would (a) re-tombstone every pass — one routine untag suppressing the partition
            // forever + hourly deep Graphiti scans (review High 1) — and (b) sit as a perpetual
            // unlanded obligation that blocks the latch from ever setting (review High 2).
            const { error: doneErr } = await db
              .from("graph_episodes")
              .delete()
              .eq("team_id", args.teamId)
              .eq("source_table", SOURCE_TABLE)
              .eq("source_id", item.id)
              .eq("group_id", r.group_id)
              .eq("content_sha256", "")
              .is("pending_delete_group_id", null);
            if (doneErr) {
              throw new ProjectionAbortError(
                `project: untag completion delete failed for item ${item.id}: ${doneErr.message}`,
                partialSummary()
              );
            }
            continue;
          }
          await deleteItemEpisodes(client, r.group_id, item.id).catch(() => {});
          const at = new Date().toISOString();
          const { error: untagErr } = await db
            .from("graph_episodes")
            .update({ content_sha256: "", pending_delete_group_id: r.group_id, pending_delete_at: at })
            .eq("team_id", args.teamId)
            .eq("source_table", SOURCE_TABLE)
            .eq("source_id", item.id)
            .eq("group_id", r.group_id);
          if (untagErr) {
            throw new ProjectionAbortError(
              `project: untag tombstone failed for item ${item.id} in ${r.group_id}: ${untagErr.message}`,
              partialSummary()
            );
          }
          continue;
        }
        if (r.deferred) continue; // cold — parked until armed
        if (r.content_sha256 === contentSha || episodes.length === 0) continue; // converged / redacted
        // A row still owing a purge must NOT be pushed into: reconcile's pending-cleanup deletes
        // by item id in that group and would eat the fresh push. Let the purge finish (it clears
        // the flag); the next pass pushes clean — the same convergence the home path buys with
        // purgeBeforeRepush.
        if (r.pending_delete_group_id) continue;
        if (fanoutBudget <= 0) {
          fanoutThrottled++; // no silent caps: the remainder is REPORTED, not dropped (next pass resumes)
          continue;
        }
        fanoutBudget--;
        // WHOLE-ITEM push, no per-chunk delta (review Medium 4, accepted deferral): the home path's
        // GRAPHCOST-1 delta is not inherited here yet — an edited long document in k armed groups
        // pays k × its full chunk count per edit, bounded today by the measured rate and P̄. The
        // chunk_shas written below are recorded FOR the future delta to inherit, not read by this
        // path — stated so the state isn't mistaken for delta support.
        try {
          await client.addEpisodes(r.group_id, episodes);
        } catch (err) {
          throw new ProjectionAbortError(
            `project: fan-out push failed for item ${item.id} into ${r.group_id}: ${err instanceof Error ? err.message : String(err)}`,
            partialSummary()
          );
        }
        // Counters ride the PUSH, not the ledger write (Codex review Medium 3): the extraction is
        // incurred the moment addEpisodes accepts — an abort on the write below must still carry
        // these in its partial summary or the append-only cost substrate under-counts real spend.
        episodesPushed += episodes.length;
        episodesByGroup[r.group_id] = (episodesByGroup[r.group_id] ?? 0) + episodes.length;
        fanoutPushed++;
        const { data: fanWritten, error: fanWriteErr } = await db
          .from("graph_episodes")
          .update({
            content_sha256: contentSha,
            chunk_shas: chunkShas,
            chunk_config: CHUNK_CONFIG,
            projected_at: new Date().toISOString(),
          })
          .eq("team_id", args.teamId)
          .eq("source_table", SOURCE_TABLE)
          .eq("source_id", item.id)
          .eq("group_id", r.group_id)
          .select("group_id");
        if (fanWriteErr) {
          // The row keeps its '' sha (armed, unlanded) — the next pass re-pushes; duplicate cost,
          // convergent, same class as the home path's crash window.
          throw new ProjectionAbortError(
            `project: fan-out ledger write failed for item ${item.id}: ${fanWriteErr.message}`,
            partialSummary()
          );
        }
        // ROWCOUNT, not just error (Codex review High 2): reconcile's never-landed delete can eat
        // an armed '' row between this pass's read and this write — the update then matches ZERO
        // rows while Graphiti holds the accepted push with no ledger anywhere. Restore the pointer.
        if (((fanWritten as unknown[] | null) ?? []).length === 0) {
          await recoverUnledgeredFanoutPush(db, {
            teamId: args.teamId,
            itemId: item.id,
            groupId: r.group_id,
            partial: partialSummary,
          });
        }
      }
    };

    // RESTRICTION-MOVES-NOT-COPIES, landed-gated (PCCC-6; spec rule 2, design §2.2). An item whose
    // General membership CLOSED must leave its home partition — but only once a landed initiative
    // copy exists (move = copy-then-delete: purging first would lose the content everywhere,
    // including for permissive teams whose initiatives never arm). The branch OWNS the item's whole
    // pass: the normal home flow below must not run, because purgeBeforeRepush would read the
    // tombstone as an undone redaction and RE-PUSH the restricted content into General every hour.
    const restrictedOutOfHome = item.access === "team" && !inGeneral.has(item.id) && episodes.length > 0;
    if (restrictedOutOfHome) {
      const landedCopy = fanoutRows.some(
        (r) => !r.deferred && r.content_sha256 === contentSha && (fanoutTargetsByItem.get(item.id) ?? new Set()).has(r.group_id)
      );
      if (currentRow && currentRow.content_sha256 !== "" && !currentRow.pending_delete_group_id && landedCopy) {
        // Move completes: tombstone home with a self pending flag; reconcile purges durably and
        // General suppresses (self-purge) until it confirms — narrowing fails closed.
        await deleteItemEpisodes(client, groupId, item.id).catch(() => {});
        const at = new Date().toISOString();
        const { error: moveOutErr } = await db
          .from("graph_episodes")
          .update({ content_sha256: "", pending_delete_group_id: groupId, pending_delete_at: at })
          .eq("team_id", args.teamId)
          .eq("source_table", SOURCE_TABLE)
          .eq("source_id", item.id)
          .eq("group_id", groupId);
        if (moveOutErr) {
          throw new ProjectionAbortError(
            `project: restriction move-out failed for item ${item.id}: ${moveOutErr.message}`,
            partialSummary()
          );
        }
        await runFanout();
        skipped++;
        continue;
      }
      if (currentRow && (currentRow.pending_delete_group_id === groupId || currentRow.content_sha256 === "")) {
        // Tombstoned or already parked at the '' sentinel (the flag clears when the purge
        // confirms) — hold: never re-push a restricted item's home. Without the sentinel term the
        // cleared row would fall through to the normal flow, whose '' handling force-pushes past
        // the sha skip and re-populates General hourly — the move undone by its own machinery.
        await runFanout();
        skipped++;
        continue;
      }
      // A restricted item's content may not sit in EITHER tier group: a stale other-tier home row
      // (a tier flip landed while restricted) is tombstoned with a self purge flag — exposed by
      // this slice's own tier-flip test, where the old row would otherwise stay readable at the
      // OLD tier forever.
      for (const stale of staleRows) {
        if (stale.content_sha256 === "" || stale.pending_delete_group_id) continue;
        await deleteItemEpisodes(client, stale.group_id, item.id).catch(() => {});
        const staleAt = new Date().toISOString();
        const { error: staleErr } = await db
          .from("graph_episodes")
          .update({ content_sha256: "", pending_delete_group_id: stale.group_id, pending_delete_at: staleAt })
          .eq("team_id", args.teamId)
          .eq("source_table", SOURCE_TABLE)
          .eq("source_id", item.id)
          .eq("group_id", stale.group_id);
        if (staleErr) {
          throw new ProjectionAbortError(
            `project: restricted stale-home tombstone failed for item ${item.id}: ${staleErr.message}`,
            partialSummary()
          );
        }
      }
      if (!currentRow) {
        // Restricted from ingest onward (spec rule 1's `exclusive` flow): the home partition never
        // receives this content at all. Fan-out (deferral, arming, pushes) proceeds normally.
        await runFanout();
        skipped++;
        continue;
      }
      // Home row live, no landed copy yet: ARM the item's deferred target copies RIGHT NOW —
      // restriction is itself an arming trigger (review High 3: the only other trigger is a
      // P-visible reader's query, which may never come, leaving restricted facts servable to
      // enforced non-members through General for an unbounded window — spec rule 2 forbids
      // exactly that). The copies push under the fan-out budget on this and following passes;
      // once landed, the branch above completes the move. Counted in `restrictionMovesPending`
      // so the pending-move population is observable, never silent.
      for (const target of fanoutTargetsByItem.get(item.id) ?? new Set<string>()) {
        const targetRow = fanoutRows.find((fr) => fr.group_id === target);
        if (targetRow?.deferred) {
          const { error: armErr } = await db
            .from("graph_episodes")
            .update({ deferred: false })
            .eq("team_id", args.teamId)
            .eq("source_table", SOURCE_TABLE)
            .eq("source_id", item.id)
            .eq("group_id", target)
            .eq("deferred", true);
          if (armErr) {
            throw new ProjectionAbortError(
              `project: restriction arm failed for item ${item.id} into ${target}: ${armErr.message}`,
              partialSummary()
            );
          }
        }
      }
      restrictionMovesPending++;
      // …then fall through to the NORMAL flow — the content stays Everyone-visible until the move
      // can complete without loss (copy-then-delete).
    }

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
        // Same group as the existing row, so the 4-column target matches it (no second-row insert
        // for the narrow unique to reject). LOUD on error (PCCC-3): a silently-failed write here
        // strands pre-redaction episodes searchable forever with pendingCleanups reading 0.
        const { error: redactErr } = await db.from("graph_episodes").upsert(
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
          { onConflict: "team_id,source_table,source_id,group_id" }
        );
        if (redactErr) {
          throw new ProjectionAbortError(`project: redaction ledger write failed for item ${item.id}: ${redactErr.message}`, partialSummary());
        }
      }
      // ARMED fan-out rows hold the SAME pre-redaction content in initiative graphs (PCCC-5 review
      // High 2 — the door B2 closes for home was open for fan-out, and PCCC-6's removed-side only
      // covers UNTAG, not redaction-with-membership-intact). Tombstone each: '' sha + its own group
      // as pending-delete; reconcile processes them (deferred=false) with the same durable retry.
      // DEFERRED rows need nothing — they never pushed, and they park until content returns. But an
      // armed row's sha proves NOTHING (Codex review High 1): '' can mean armed-not-yet-pushed OR
      // pushed-and-crashed-before-recording — indistinguishable, and the second holds real content.
      // Tombstone every non-deferred fan-out row without an outstanding flag; for the truly-unpushed
      // the purge verifies empty and clears, which is cheap, while skipping would strand the other.
      for (const r of fanoutRows) {
        if (r.deferred || r.pending_delete_group_id) continue;
        await deleteItemEpisodes(client, r.group_id, item.id).catch(() => {});
        const at = new Date().toISOString();
        const { error: fanRedactErr } = await db
          .from("graph_episodes")
          .update({
            content_sha256: "",
            projected_at: at,
            pending_delete_group_id: r.group_id,
            pending_delete_at: at,
          })
          .eq("team_id", args.teamId)
          .eq("source_table", SOURCE_TABLE)
          .eq("source_id", item.id)
          .eq("group_id", r.group_id);
        if (fanRedactErr) {
          throw new ProjectionAbortError(
            `project: fan-out redaction write failed for item ${item.id}: ${fanRedactErr.message}`,
            partialSummary()
          );
        }
      }
      // Fan-out BOOKKEEPING still runs on this exit too (Codex review Low 4): a redacted item may
      // simultaneously be untagged, and its never-pushed deferred rows would otherwise linger
      // invisible to every janitor until content returned. runFanout's add/push sides are inert
      // here (episodes.length === 0 guards both); only the deferred-untag delete does work.
      await runFanout();
      skipped++;
      continue;
    }

    const tierChanged = existingRow !== null && existingRow.group_id !== groupId;
    // Set when the group-move UPDATE below matched zero rows (the old-key row vanished between the
    // ledger read and the move — reconcile's re-queue DELETE can do that): the move then reserved
    // nothing, and the reservation upsert must run instead.
    let groupMoveMatchedNothing = false;
    // Pushing back INTO a group we still owe a purge on (a redaction that was undone before reconcile
    // finished): the pending purge deletes by item id, so leaving the flag set would delete the episodes
    // we're about to push and silently drop the item from the graph. Purge the stale ones first, then
    // this push is authoritative and the flag clears below.
    const purgeBeforeRepush = existingRow?.pending_delete_group_id === groupId;
    // CONFIG-AWARE SKIP (AIO-808). `content_sha256` hashes the whole body and is invariant to the
    // chunk config, so on its own this skip strands every unchanged item on the config it was last
    // pushed under — permanently, until its body happens to change. That is how 689,235 characters
    // sat outside the graph while the ledger read healthy.
    //
    // TWO TERMS, because this site asks a DIFFERENT question from the delta predicate below. That one
    // asks "can I trust the stored hashes" (a raised cap: yes). This one asks "could this item still
    // OWE chunks" — and under a raised cap a body-identical item is compatible AND owes its tail. Using
    // compatibility alone here keeps exactly the items this feature targets skipping, which is the bug
    // review caught twice. `episodes.length` is used rather than a re-derived ceil(len/chars): a second
    // derivation can drift from `chunkContent` (they disagree on a whitespace-only body) and the ledger
    // must never describe something else. Both values are already in scope — no added work.
    const owesChunks = episodes.length > (existingRow?.chunk_shas?.length ?? 0);
    const chunkingUnchanged = chunkConfigDeltaCompatible(existingRow?.chunk_config, CHUNK_CONFIG);
    // CASE 1 — the boundaries are TRUSTWORTHY: same (or cap-grown) config, and nothing left to owe.
    const boundariesTrustworthy = chunkingUnchanged && !owesChunks;
    // CASE 3 (PIPEFF-3) — the boundaries are STALE, but the item is PROVABLY COMPLETE under the config
    // that produced its hashes, so re-chunking it would re-extract text we already have under different
    // boundaries and learn nothing. It is what makes the CDC rollout lazy rather than a ~$76 burst:
    // legacy-chunked rows whose bodies have not changed keep their chunking indefinitely. It also
    // settles cap-SHRINK explicitly — a shrunk-cap item that verifies complete under its stored, larger
    // cap is left alone, because the orphan tails a shrink creates are not fixed by re-extracting the
    // head either.
    //
    // ⚠️ IT IS A WIDENING OF THIS COMPOSITE SKIP, NOT A NEW SITE, and it is written INSIDE the existing
    // conjunction rather than beside it precisely so there is exactly ONE copy of each inherited term.
    // A first draft repeated `!tierChanged` / `!purgeBeforeRepush` / the sha comparison inside a
    // separate `provablyComplete` const; mutation testing showed those copies could all be deleted with
    // every test still green — unfalsifiable terms asserting on trust, which is the shape this repo has
    // a standing rule against. The `||` is therefore the only new thing here, and everything guarding
    // it is shared with case 1: a re-queued (`''` sentinel) or redacted row cannot sha-match, a
    // reclassified row fails `!tierChanged`, and a row owing a purge on this group fails
    // `!purgeBeforeRepush` — in all three the completeness question is never even asked.
    //
    // Short-circuiting is load-bearing, not incidental: `storedChunkingComplete` RE-CHUNKS the body, so
    // it must sit last, after the four cheap terms and behind `boundariesTrustworthy ||`.
    if (
      existingRow &&
      existingRow.content_sha256 === contentSha &&
      !tierChanged &&
      !purgeBeforeRepush &&
      (boundariesTrustworthy ||
        storedChunkingComplete({
          body: item.body ?? "",
          storedConfig: existingRow.chunk_config,
          storedShas: existingRow.chunk_shas,
          hash: sha,
        }))
    ) {
      // NO BACKFILL HERE ANY MORE (AIO-808). GRAPHCOST-1 had a branch that, for a row with an empty
      // chunk ledger and a matching body sha, recorded the CURRENT config's hashes without pushing —
      // converging pre-ledger installs for free. Its own comment admitted the premise "an identical
      // body means these are the chunks we pushed" holds "only while the chunk config is the one that
      // produced them, which an empty ledger cannot attest", and prescribed invalidation on any config
      // change. Raising MAX_EPISODE_CHUNKS IS that change, so the branch's era ended with it.
      //
      // It is deleted rather than left unreachable because for the one population it still served it
      // produced this feature's own bug: a pre-ledger row OVER the old cap would have been blessed
      // with 40 current-config hashes including tails that exist in the graph in no form at all —
      // permanent silent loss, invisible to reconcile (whose landed-check is satisfied by chunk #0).
      // Such a row now falls through to a full push, which is both correct and the first time its
      // tails are extracted. Convergence for pre-ledger rows is therefore the full-push path, once.
      // Pinned by the inverted AC4 in test/datamechanics/graph-chunk-delta.datamechanics.test.ts.
      await runFanout();
      skipped++;
      continue; // unchanged content, same tier → no-op (idempotent); fan-out still ran above
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
      // GROUP-MOVE IS AN EXPLICIT UPDATE, NOT AN UPSERT (PCCC-3, Deploy A): under the 4-column
      // conflict target a group change is an INSERT of a second row for the item, which the
      // still-standing narrow unique rejects. While it stands (until Deploy B), relocate the row by
      // its OLD key. This doubles as the RESERVATION for the new group — `''` sentinel until the
      // push below lands, so a crash mid-move leaves a row reconcile re-queues rather than a ledger
      // claiming content the new group never received. Durable pending flag written here, not just
      // in the final upsert: the flag must survive a crash between this point and that write.
      const moveAt = new Date().toISOString();
      const { data: movedRows, error: moveErr } = await db
        .from("graph_episodes")
        .update({
          group_id: groupId,
          content_sha256: "",
          pending_delete_group_id: existingRow.group_id,
          pending_delete_at: moveAt,
        })
        .eq("team_id", args.teamId)
        .eq("source_table", SOURCE_TABLE)
        .eq("source_id", item.id)
        .eq("group_id", existingRow.group_id)
        .select("group_id");
      if (moveErr) {
        throw new ProjectionAbortError(`project: group-move ledger update failed for item ${item.id}: ${moveErr.message}`, partialSummary());
      }
      // ROWCOUNT, not just error (Fable review Low 2): reconcile's re-queue DELETE removes exactly a
      // no-pending-flag row whose episodes went missing, and it can land between our ledger read and
      // this UPDATE. Zero rows moved means NOTHING is reserved — falling through to the reservation
      // upsert below is what keeps the reserve-before-push guarantee on this path too.
      groupMoveMatchedNothing = ((movedRows as unknown[] | null) ?? []).length === 0;
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
      chunkConfigDeltaCompatible(existingRow.chunk_config, CHUNK_CONFIG);
    // NB: no `chunk_shas.length > 0` term. It would be unfalsifiable — an empty ledger yields an empty
    // `alreadyPushed`, so the diff below already degrades to a full push on its own. A predicate term
    // no test can redden is one the guard below would be asserting on trust.
    const alreadyPushed = new Set(deltaEligible ? (existingRow?.chunk_shas ?? []) : []);
    const toPush = deltaEligible ? episodes.filter((_, i) => !alreadyPushed.has(chunkShas[i])) : episodes;

    // RESERVE THE LEDGER ROW BEFORE THE IRREVERSIBLE PUSH (PCCC-3, plan-review Codex High 4).
    // `addEpisodes` cannot be taken back; the old order (push, then first ledger write) meant a
    // cross-instance race — the single-flight is process-local, and a deploy overlap runs two
    // instances — could push episodes into a group and then fail its first ledger write, leaving
    // them orphaned with no purge pointer. Reserving first inverts that: a CROSS-GROUP loser fails
    // HERE, on the still-standing narrow unique, before anything lands in a graph.
    //
    // Plain INSERT, not upsert (code-review Codex Medium 2): an upsert's DO-UPDATE would stomp a
    // completed racer's real sha/chunk ledger back to ''/[] — a conflict on the WIDE index is
    // BENIGN (someone already holds the (item, group) reservation, possibly our own crashed prior
    // pass) and is deliberately left alone. Any other reservation error throws. The `''` sentinel
    // means "reserved, not landed" — a crash before the final write below leaves a row reconcile
    // re-queues. On the vanished-old-row fallback the old group's purge pointer rides ON the
    // reservation (code-review Codex High 1): the final upsert also writes it, but a crash between
    // this push and that write must not strand a late-landing old-tier episode unpurgeable.
    // (A tier flip is normally reserved by the group-move UPDATE above — unless it matched nothing;
    // an existing current-group row IS the reservation.)
    if (existingRow === null || groupMoveMatchedNothing) {
      const { error: reserveErr } = await db.from("graph_episodes").insert({
        team_id: args.teamId,
        source_table: SOURCE_TABLE,
        source_id: item.id,
        group_id: groupId,
        content_sha256: "",
        chunk_shas: [],
        chunk_config: CHUNK_CONFIG,
        ...(tierChanged && existingRow
          ? { pending_delete_group_id: existingRow.group_id, pending_delete_at: new Date().toISOString() }
          : {}),
      });
      if (reserveErr && !reserveErr.message.includes("graph_episodes_item_group_key")) {
        throw new ProjectionAbortError(`project: ledger reservation failed for item ${item.id}: ${reserveErr.message}`, partialSummary());
      }
    }

    if (!(purgeFailed && contentUnchanged) && toPush.length > 0) {
      try {
        await client.addEpisodes(groupId, toPush);
      } catch (err) {
        // The abort still carries what earlier items pushed — that extraction was incurred.
        throw new ProjectionAbortError(
          `project: push failed for item ${item.id}: ${err instanceof Error ? err.message : String(err)}`,
          partialSummary()
        );
      }
    }

    // A pass that POSTed nothing must not claim it pushed: `extraction-health`'s ledger read (`newestPushAtMs`) reads
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

    const { error: ledgerWriteErr } = await db.from("graph_episodes").upsert(
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
      { onConflict: "team_id,source_table,source_id,group_id" }
    );
    // LOUD (PCCC-3). This error was silently discarded, which is what made the deploy-window
    // breakage class invisible: episodes pushed to Graphiti, ledger never written, re-pushed every
    // pass — duplicate episodes with the ledger reading healthy. The reservation above bounds the
    // damage of throwing here: the row exists as a `''` sentinel, so reconcile re-queues it.
    if (ledgerWriteErr) {
      throw new ProjectionAbortError(`project: ledger write failed for item ${item.id}: ${ledgerWriteErr.message}`, partialSummary());
    }
    if (pushedSomething) projected++;
    else skipped++; // ledger refreshed, nothing extracted into HOME — an armed-only service pass still
    // counts here (its real spend shows in episodes/episodesByGroup/fanoutPushed, not `projected`).
    // What was ACTUALLY sent, not what the item chunks into. `episodes` is the denominator of the
    // per-episode extraction cost metric, so counting the item's full chunk list on a delta pass that
    // sent one chunk (or none) would divide real LLM calls by phantom episodes and make extraction
    // look cheaper per episode than it is. This also stops counting the `purgeFailed && contentUnchanged`
    // refusal, which pushes nothing and was previously counted.
    episodesPushed += pushedSomething ? toPush.length : 0;
    if (pushedSomething) {
      episodesByGroup[groupId] = (episodesByGroup[groupId] ?? 0) + toPush.length;
    }

    await runFanout();
  }

  // Cursor for the runner: rows are ordered by synced_at ascending, so the last row is the high-water
  // mark to page past next batch (audit H2). Without this the runner only ever re-scanned the oldest
  // `limit` rows and never reached items beyond that window.
  const lastSyncedAt = rows.length ? rows[rows.length - 1].synced_at : undefined;
  return { scanned: rows.length, projected, episodes: episodesPushed, episodesByGroup, skipped, externalGroupVacated, fanoutPushed, fanoutThrottled, restrictionMovesPending, lastSyncedAt };
}

/** Back-compat: project only Slack transcripts. Prefer `projectItemsToGraph` (all ingestions). */
export async function projectSlackToGraph(
  db: DbClient,
  args: { teamId: string; teamSlug: string; client?: GraphitiClient; since?: string; limit?: number }
): Promise<ProjectSummary> {
  return projectItemsToGraph(db, { ...args, kinds: ["transcript"] });
}
