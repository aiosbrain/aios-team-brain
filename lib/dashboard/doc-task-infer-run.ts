import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleTasks, visibleItems } from "@/lib/auth/visibility";
import { completeTextOrNull } from "@/lib/llm/complete";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { llmConfigured } from "./timeline-summary";
import { resolveItemCreditIds } from "@/lib/attribution/contributor-credit";
import { computeTaskLinks } from "./issue-ref";
import { classifyWork } from "./work-classification";
import { itemWorkTime, normalizeSource } from "./timeline-group";
import {
  DOC_TASK_SYSTEM,
  applyInferredLinks,
  buildInferPrompt,
  candidatesFor,
  inferenceInputsHash,
  isScoreableSource,
  parseInferResponse,
  scoreableDocs,
  type InferCandidate,
  type InferDoc,
} from "./doc-task-infer";
import { recordIngestRun } from "@/lib/ingest/runs";

/**
 * The LLM doc→task assignment PASS — the background half of `./doc-task-infer` (which holds the pure
 * decision core and the trust boundary; read its header first).
 *
 * A design doc rarely cites `AIO-494` in its title or path, so the deterministic matcher leaves it in the
 * timeline's "Other" bucket even when it is plainly the work behind a ticket. This reads those unlinked
 * docs plus the team's candidate tasks and asks the model, in ONE batched call, which belongs to which —
 * or, expectedly, neither. Confident answers are persisted as `task_evidence` rows with `method='llm'`.
 *
 * SECOND WRITER of `task_evidence`, alongside `./timeline-evidence` (`method='issue_ref'`). The two are
 * disjoint by construction: each prunes only its OWN method, and this one never scores a doc that already
 * has a deterministic link. Guarded by `test/guards/single-writer-task-evidence.test.ts`.
 *
 * Cost discipline (mirrors the arcs evidence-coherence pass, `lib/graph/arcs.ts`):
 *   • BACKGROUND only — the ingest scheduler, never a request path.
 *   • Short-circuits before spending anything when the team has no LLM configured (`llmConfigured`).
 *   • ONE batched call per team, with capped docs, capped candidates and a capped body excerpt.
 *   • Skips entirely when the inputs are unchanged since the last run — the hash covers doc CONTENT, the
 *     candidate set and the system prompt, and is carried on the recorded `ingest_runs` row.
 *   • Never throws: a failure records an unhealthy run and leaves the previous edges in place.
 */

/** How far back to look for unlinked docs. Matches the timeline's default window. */
const WINDOW_DAYS = 7;
/** Docs scored per run. Bounds prompt size AND blast radius of one bad batch. */
const MAX_DOCS = 40;
/** Candidate tasks offered. `candidatesFor` caps per-doc too; this bounds the fetch. */
const TASK_LIMIT = 200;
/** Body chars READ per doc (the prompt truncates further) — keeps a big doc off the wire. */
const BODY_READ_CHARS = 2000;
/** Rows scanned for candidate docs. Bounds the wide (body-less) read. */
const ITEM_SCAN = 500;
const MAX_TOKENS = 900;
const TIMEOUT_MS = 45_000;
/**
 * Minimum gap between two paid runs for one team, whichever trigger fires. This leg is offered BOTH the
 * scheduler tick (every `INGEST_POLL_MINUTES`, default 30) and the timeline's background rebuild (i.e. a
 * page view), and neither cadence is the right one to pay a model at: inferences only need to be as fresh
 * as a person's reading of them, and the underlying docs change on the order of days, not minutes.
 * The clock is the last recorded run's `finished_at` — see `lastRun`.
 */
const COOLDOWN_MS = Math.max(1, Number(process.env.DOC_TASK_INFER_INTERVAL_HOURS) || 12) * 3_600_000;

/** `ingest_runs.source` for this leg — also the key used to find the previous run's inputs hash. */
export const DOC_TASK_INFER_SOURCE = "doc_task_infer";

export interface InferRunResult {
  /** Docs sent to the model (0 when skipped). */
  scored: number;
  /** Confident, in-set links persisted. */
  linked: number;
  /** Set when the pass deliberately did nothing. */
  skipped?: "cooldown" | "no-llm" | "unchanged" | "nothing-to-score" | "no-candidates" | "model-null";
}

type ItemRow = {
  id: string;
  member_id: string | null;
  member_id_locked?: boolean | null;
  kind: string | null;
  path: string | null;
  body: string | null;
  content_sha256: string | null;
  access: string | null;
  frontmatter: Record<string, unknown> | null;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Run the pass for ONE team. Best-effort: returns a result rather than throwing, so a scheduler tick
 * can never fail on it.
 */
export async function runDocTaskInference(db: DbClient, teamId: string): Promise<InferRunResult> {
  const startedAt = Date.now();
  try {
    // COOLDOWN first — one indexed query, and the cheapest possible way to decide not to spend. Both
    // triggers (scheduler tick, timeline rebuild) share this clock, so they can never double-charge:
    // whichever fires first sets `finished_at`, and that resets the timer for the other.
    const prior = await lastRun(db, teamId);
    if (prior && Date.now() - prior.finishedAt < COOLDOWN_MS) return { scored: 0, linked: 0, skipped: "cooldown" };

    // Spend nothing when the team has no model configured (every data-mechanics team, most self-hosts).
    const keys = await resolveAnsweringKeys(db, teamId).catch(() => null);
    if (!keys || !llmConfigured(keys)) return { scored: 0, linked: 0, skipped: "no-llm" };

    // TIER: both reads go through the §5 choke-points. `visibleTasks("team")` is a passthrough, so the
    // real protection is the READ path re-gating (see `work-timeline`); scoring team-tier only here keeps
    // an external-authored doc from ever reaching the model, which is the write-side half of the rule.
    const sinceIso = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    const [taskRes, itemRes] = await Promise.all([
      visibleTasks(
        db
          .from("tasks")
          .select("id, row_key, title, status, assignee")
          .eq("team_id", teamId)
          .not("row_key", "is", null)
          .order("updated_at", { ascending: false })
          .limit(TASK_LIMIT),
        "team"
      ),
      visibleItems(
        db
          .from("items")
          // NO `body` here: this read is wide (up to ITEM_SCAN) and a design doc runs 10-100KB, so
          // pulling prose for rows the hash check is about to discard would move tens of MB per team per
          // tick for a pass that then does nothing. Bodies are fetched by id AFTER the skip check, for the
          // ≤MAX_DOCS docs actually being scored. (`timeline-evidence` avoids the same trap.)
          .select("id, member_id, member_id_locked, kind, path, content_sha256, access, frontmatter")
          .eq("team_id", teamId)
          .not("member_id", "is", null)
          .gte("synced_at", sinceIso)
          .order("synced_at", { ascending: false })
          .limit(ITEM_SCAN),
        "team"
      ),
    ]);
    if (taskRes.error || itemRes.error) {
      throw new Error(taskRes.error?.message ?? itemRes.error?.message ?? "read failed");
    }

    const tasks = (taskRes.data ?? []) as { id: string; row_key: string | null; title: string; status: string | null; assignee: string | null }[];
    const items = (itemRes.data ?? []) as ItemRow[];
    if (!tasks.length) return { scored: 0, linked: 0, skipped: "no-candidates" };

    // AUTHORED DOCUMENTS only — `isScoreableSource` carries the reasoning for each exclusion, and
    // `classifyWork` drops SIGNAL (a decision, a meeting: data ABOUT work).
    const docRows = items.filter((r) => {
      const fm = r.frontmatter ?? {};
      const source = normalizeSource(str(fm.source));
      if (!isScoreableSource(source)) return false;
      if (classifyWork(r.kind, str(fm.source)) !== "work") return false;
      return !!itemWorkTime(fm); // no work-time → the timeline drops it anyway; don't pay to score it
    });
    if (!docRows.length) return { scored: 0, linked: 0, skipped: "nothing-to-score" };

    // DETERMINISTIC WINS: anything the issue-key matcher already links is never offered to the model.
    const deterministic = computeTaskLinks(
      tasks.map((t) => ({ id: t.id, row_key: t.row_key })),
      docRows.map((r) => ({ id: r.id, text: `${str(r.frontmatter?.title) ?? ""}\n${r.path ?? ""}` }))
    );

    // Credit each doc to its actual worker via the ONE shared oracle — the SINGLE source for "who did
    // this work" (`test/guards/attribution-single-source`). STRICT, with NO raw-`member_id` fallback: a
    // fallback would attribute differently from the timeline and the admin page, which is precisely the
    // drift the oracle exists to prevent. This pass is background and best-effort, so if the oracle can't
    // answer, the right move is to spend nothing this tick rather than rank against a second opinion.
    const credit = await resolveItemCreditIds(
      db,
      teamId,
      docRows.map((r) => r.id),
      { strict: true, items: docRows.map((r) => ({ id: r.id, member_id: r.member_id, member_id_locked: r.member_id_locked ?? null })) }
    );

    const docs: InferDoc[] = docRows.map((r) => ({
      id: r.id,
      memberId: credit.get(r.id)?.primaryId ?? null,
      title: str(r.frontmatter?.title) ?? (r.path ? r.path.split("/").pop() ?? r.path : "(untitled)"),
      contentSha: r.content_sha256 ?? "",
      access: r.access === "external" ? "external" : "team",
      hasDeterministicLink: (deterministic.get(r.id) ?? []).length > 0,
      // `body` is attached later — only for the docs that survive the skip check (see below).
    }));

    const scoreable = scoreableDocs(docs).slice(0, MAX_DOCS);
    if (!scoreable.length) return { scored: 0, linked: 0, skipped: "nothing-to-score" };

    // Resolve each task's assignee to a member so ranking uses the identity mapping, not the raw string
    // (prod carries `Chetan` / `chetan.nandakumar` / `John Ellison` / `john` for two people).
    const assigneeToMember = await resolveAssigneeMembers(db, teamId, tasks.map((t) => t.assignee));
    const candidates: InferCandidate[] = tasks.map((t) => ({
      id: t.id,
      rowKey: t.row_key,
      title: t.title || "(untitled task)",
      assigneeMemberId: assigneeToMember.get((t.assignee ?? "").trim().toLowerCase()) ?? null,
    }));

    // SKIP-IF-UNCHANGED: same docs (by content), same candidates, same prompt → the previous answers
    // still hold, so re-running would re-spend for an identical result.
    // The hash keys on `content_sha256`, NOT on the prose — so this decision needs no bodies, which is
    // what lets the body read stay behind it.
    const inputsHash = inferenceInputsHash(scoreable, candidates, DOC_TASK_SYSTEM);
    if (prior?.inputsHash === inputsHash) return { scored: 0, linked: 0, skipped: "unchanged" };

    // Only NOW pull prose, and only for the ≤MAX_DOCS docs actually being scored.
    const withBodies = await attachBodies(db, teamId, scoreable);

    // Rank candidates per the FIRST doc's author, then send one batch. Per-doc candidate sets would mean
    // one call per doc; the ranking only tilts ordering, and the model still sees every visible task.
    const ranked = candidatesFor(withBodies[0], candidates);
    const { prompt, docByRef, taskByRef } = buildInferPrompt(withBodies, ranked);

    const raw = await completeTextOrNull(
      { system: DOC_TASK_SYSTEM, prompt },
      {
        keys,
        maxTokens: MAX_TOKENS,
        timeoutMs: TIMEOUT_MS,
        jsonObject: true,
        // Reuse the timeline's ledger slice rather than widening the closed `LlmUsageSource` union —
        // same call the arcs coherence pass makes by reusing "arcs".
        meter: { db, teamId, source: "timeline-summary" },
      }
    );
    if (!raw) {
      await record(db, teamId, startedAt, true, { inputs_hash: inputsHash, scored: scoreable.length, linked: 0, note: "model returned null" });
      return { scored: scoreable.length, linked: 0, skipped: "model-null" };
    }

    const choices = parseInferResponse(raw, docByRef, taskByRef);
    const links = applyInferredLinks(
      choices,
      new Set(ranked.map((c) => c.id)),
      new Set(withBodies.map((d) => d.id))
    );

    // Replace THIS pass's edges only — `method='llm'`. The deterministic writer's `issue_ref` rows are
    // untouched (and vice-versa: its prune is scoped the same way), so the two writers never clobber.
    const del = await db.from("task_evidence").delete().eq("team_id", teamId).eq("method", "llm");
    if (del.error) throw new Error(`prune failed: ${del.error.message}`);
    if (links.length) {
      const rows = links.map((l) => ({
        team_id: teamId,
        task_id: l.taskId,
        item_id: l.itemId,
        method: l.method,
        confidence: l.confidence,
        detail: l.detail,
      }));
      // NOTE the PK is `(team_id, task_id, item_id)` — `method` is NOT in it, so this upsert would
      // overwrite an `issue_ref` row's method on a collision. Unreachable today (a scored doc is by
      // construction one with NO deterministic link, so the pair can't already be an issue_ref edge), but
      // that safety is emergent from the filters above rather than structural — stated here so a future
      // change to what gets scored doesn't silently start downgrading deterministic edges to guesses.
      const ins = await db.from("task_evidence").upsert(rows, { onConflict: "team_id,task_id,item_id" });
      if (ins.error) throw new Error(`insert failed: ${ins.error.message}`);
    }

    await record(db, teamId, startedAt, true, { inputs_hash: inputsHash, scored: scoreable.length, linked: links.length });
    return { scored: scoreable.length, linked: links.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[doc-task-infer] pass failed:", message);
    await record(db, teamId, startedAt, false, {}, [message]);
    return { scored: 0, linked: 0 };
  }
}

/**
 * Fetch prose for exactly the docs being scored, head-truncated. Separate from the wide scan so an
 * "unchanged" tick reads no bodies at all. A body that fails to load leaves the doc title-only — still
 * judgeable, just weaker evidence — rather than dropping it.
 */
async function attachBodies(db: DbClient, teamId: string, docs: InferDoc[]): Promise<InferDoc[]> {
  try {
    const { data } = await db
      .from("items")
      .select("id, body")
      .eq("team_id", teamId)
      .in("id", docs.map((d) => d.id));
    const bodyById = new Map(
      ((data ?? []) as { id: string; body: string | null }[]).map((r) => [r.id, (r.body ?? "").slice(0, BODY_READ_CHARS)])
    );
    return docs.map((d) => ({ ...d, body: bodyById.get(d.id) ?? "" }));
  } catch {
    return docs; // title-only is a valid, weaker input — never a reason to abort the pass
  }
}

/**
 * This team's most recent run of THIS leg — the shared clock for both triggers. `ingest_runs` already
 * persists it, so there is no separate "last refreshed" state to keep in sync.
 *
 *  • `finishedAt` drives the COOLDOWN, and counts a FAILED run too: a team whose provider is erroring
 *    must not re-attempt every tick.
 *  • `inputsHash` drives the skip-if-unchanged, and counts only a SUCCESSFUL run: a failure's hash would
 *    suppress the retry that fixes it.
 */
async function lastRun(db: DbClient, teamId: string): Promise<{ finishedAt: number; inputsHash: string | null } | null> {
  try {
    const { data } = await db
      .from("ingest_runs")
      .select("meta, ok, finished_at")
      .eq("team_id", teamId)
      .eq("source", DOC_TASK_INFER_SOURCE)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = data as { meta?: { inputs_hash?: unknown } | null; ok?: boolean; finished_at?: string | Date } | null;
    if (!row) return null;
    const raw = row.finished_at;
    const finishedAt = raw ? (typeof raw === "string" ? Date.parse(raw) : new Date(raw).getTime()) : 0;
    const h = row.ok ? row.meta?.inputs_hash : null;
    return {
      finishedAt: Number.isFinite(finishedAt) ? finishedAt : 0,
      inputsHash: typeof h === "string" && h ? h : null,
    };
  } catch {
    return null; // unreadable history → run (spending once beats silently never running again)
  }
}

async function record(
  db: DbClient,
  teamId: string,
  startedAt: number,
  ok: boolean,
  meta: Record<string, unknown>,
  errors: string[] = []
): Promise<void> {
  await recordIngestRun(db, {
    teamId,
    source: DOC_TASK_INFER_SOURCE,
    trigger: "scheduler",
    ok,
    updated: typeof meta.linked === "number" ? (meta.linked as number) : 0,
    errors,
    meta,
    startedAt,
  });
}

/** assignee string (lowercased) → member id, via the roster. Best-effort; unmatched names stay null. */
async function resolveAssigneeMembers(
  db: DbClient,
  teamId: string,
  assignees: readonly (string | null)[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = new Set(assignees.map((a) => (a ?? "").trim().toLowerCase()).filter(Boolean));
  if (!wanted.size) return out;
  try {
    const { data } = await db
      .from("members")
      .select("id, display_name, actor_handle, email")
      .eq("team_id", teamId)
      .eq("status", "active");
    for (const m of (data ?? []) as { id: string; display_name: string | null; actor_handle: string | null; email: string | null }[]) {
      for (const key of [m.display_name, m.actor_handle, m.email]) {
        const k = (key ?? "").trim().toLowerCase();
        if (k && wanted.has(k) && !out.has(k)) out.set(k, m.id);
      }
    }
  } catch {
    // best-effort — ranking degrades to "no owned tasks first", never a failure
  }
  return out;
}
