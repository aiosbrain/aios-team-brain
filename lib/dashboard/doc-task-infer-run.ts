import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleTasks, visibleItems } from "@/lib/auth/visibility";
import { completeTextOrNull, withLlmPass, type LlmPass } from "@/lib/llm/complete";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { llmConfigured } from "./timeline-summary";
import { resolveItemCreditIds } from "@/lib/attribution/contributor-credit";
import { computeTaskLinks } from "./issue-ref";
import { assigneeMember, type RosterPerson } from "./people-match";
import { classifyWork } from "./work-classification";
import { normalizeSource } from "./timeline-group";
import {
  DOC_TASK_SYSTEM,
  applyInferredLinks,
  buildInferPrompt,
  candidatesFor,
  hasUnjudgeableDrop,
  inferenceInputsHash,
  isScoreableSource,
  parseInferResponse,
  scoreableDocs,
  type InferCandidate,
  type InferDoc,
  type InferredLink,
  type OwnerKind,
} from "./doc-task-infer";
import { recordIngestRun } from "@/lib/ingest/runs";

/**
 * The LLM doc→task assignment PASS — the background half of `./doc-task-infer` (which holds the pure
 * decision core and the trust boundary; read its header first).
 *
 * A design doc rarely cites `AIO-494` in its title or path, so the deterministic matcher leaves it in the
 * timeline's "Other" bucket even when it is plainly the work behind a ticket. This reads those unlinked
 * docs plus the team's candidate tasks — the worker's OWN ranked and MARKED first, then everyone else's —
 * and asks the model, one batched call per worker, which belongs to which — or, expectedly, neither.
 * Confident answers are persisted as `task_evidence` rows with `method='llm'`.
 *
 * SECOND WRITER of `task_evidence`, alongside `./timeline-evidence` (`method='issue_ref'`). The two are
 * disjoint by construction: each prunes only its OWN method, and this one never scores a doc that already
 * has a deterministic link. Guarded by `test/guards/single-writer-task-evidence.test.ts`.
 *
 * Cost discipline (mirrors the arcs evidence-coherence pass, `lib/graph/arcs.ts`):
 *   • BACKGROUND only — the ingest scheduler, never a request path.
 *   • Short-circuits before spending anything when the team has no LLM configured (`llmConfigured`).
 *   • ONE batched call PER WORKER in the batch (2-3 in practice), with capped docs, capped candidates and a
 *     capped body excerpt. Per worker, not per team, because the candidate list is ORDERED and MARKED for
 *     one person ("assigned to this document's author") — a single team-wide call would hand everyone
 *     else a prompt ranked, and labelled, for the wrong person.
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

/**
 * Why the pass produced nothing, in words an operator can act on (LLMCREDIT-1).
 *
 * This used to be the bare string "model returned null for every worker". On 2026-08-25 that is what
 * the Pulse banner said while the real answer was an HTTP 402 — the provider account was out of
 * credit — and it sends whoever reads it to look for a model bug. `completeTextOrNull` discards the
 * error per call, but the PASS already carries the first one, so the reason is available and was
 * simply not used.
 *
 * Pure, so the wording is a unit criterion rather than something only a live provider failure can
 * demonstrate.
 */
export function docTaskInferFailureReason(firstError: string | null): string {
  return firstError ? `every worker failed — ${firstError}` : "model returned null for every worker";
}
const TIMEOUT_MS = 45_000;
/**
 * Minimum gap between two paid runs for one team, whichever trigger fires. This leg is offered BOTH the
 * scheduler tick (every `INGEST_POLL_MINUTES`, default 30) and the timeline's background rebuild (i.e. a
 * page view), and neither cadence is the right one to pay a model at: inferences only need to be as fresh
 * as a person's reading of them, and the underlying docs change on the order of days, not minutes.
 * The clock is the last recorded run's `finished_at` — see `lastRun`.
 */
const COOLDOWN_MS = Math.max(1, Number(process.env.DOC_TASK_INFER_INTERVAL_HOURS) || 12) * 3_600_000;

/**
 * How many recent rows `lastRun` reads to find the newest PAID one. Clearing rows are written only
 * when a failure stands, and writing one makes the verdict `ok`, so at most a couple can ever sit at
 * the head (two concurrent passes can both write). A small window is therefore ample, and bounded.
 */
const CLOCK_SCAN = 10;

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
export async function runDocTaskInference(
  db: DbClient,
  teamId: string,
  /** `maxDocs` overrides the batch cap — for tests that need to prove multi-batch behaviour without
   *  seeding `MAX_DOCS` documents. */
  opts: { maxDocs?: number } = {}
): Promise<InferRunResult> {
  // ONE `source='llm'` row per tick, whatever the worker count (LLMOBS-2). See the note at the model
  // call for why per-call recording was wrong here: `MAX_DOCS = 40` bounds docs, not workers.
  return withLlmPass({ db, teamId, task: "doc-task-infer" }, (pass) =>
    runDocTaskInferenceWithPass(db, teamId, opts, pass)
  );
}

async function runDocTaskInferenceWithPass(
  db: DbClient,
  teamId: string,
  opts: { maxDocs?: number },
  pass: LlmPass
): Promise<InferRunResult> {
  const startedAt = Date.now();
  const batchCap = opts.maxDocs ?? MAX_DOCS;
  try {
    // COOLDOWN first — one indexed query, and the cheapest possible way to decide not to spend. Both
    // triggers (scheduler tick, timeline rebuild) share this clock, so they can never double-charge:
    // whichever fires first sets `finished_at`, and that resets the timer for the other.
    const prior = await lastRun(db, teamId);
    if (prior && Date.now() - prior.finishedAt < COOLDOWN_MS) return { scored: 0, linked: 0, skipped: "cooldown" };

    /**
     * A pass that ran cleanly and found nothing to do is contrary evidence against a STANDING failure
     * — record it so the streak can break (BANNERSTUCK-1). Only when the newest verdict is a failure:
     * in the steady state this writes nothing, which is what keeps the paid-run cooldown untouched
     * (a clearing row that became `lastRun` would defer real scoring by up to a cooldown) and keeps
     * ~730 rows/team/year out of an append-only table.
     *
     * NOT called for `cooldown` (the pass never ran) or `no-llm` (unconfigured — a different state).
     */
    const clearIfHealed = async (reason: string): Promise<void> => {
      if (prior?.ok === false) await recordClearingRun(db, teamId, startedAt, reason);
    };

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
          // Window on the PERSISTED work-time (R1/R2), not `synced_at` and not a TS re-derivation — the
          // same column and the same `work_at_from_source` gate the timeline builder uses, so the pass can
          // never consider a doc the timeline would drop (or miss one it keeps). `synced_at` ages forward
          // on every re-push, which is exactly the re-dating bug that column exists to end.
          .eq("work_at_from_source", true)
          .gte("work_at", sinceIso)
          .order("work_at", { ascending: false })
          .limit(ITEM_SCAN),
        "team"
      ),
    ]);
    if (taskRes.error || itemRes.error) {
      throw new Error(taskRes.error?.message ?? itemRes.error?.message ?? "read failed");
    }

    const tasks = (taskRes.data ?? []) as { id: string; row_key: string | null; title: string; status: string | null; assignee: string | null }[];
    const items = (itemRes.data ?? []) as ItemRow[];
    if (!tasks.length) {
      // No bound to worry about: an EMPTY task list is complete however wide the limit was.
      await clearIfHealed("no-candidates");
      return { scored: 0, linked: 0, skipped: "no-candidates" };
    }

    /**
     * Did the item read fill its page? `docRows`/`allScoreable`/`pending` are all JS filters over this
     * ONE bounded page (`limit(ITEM_SCAN)`, ordered `work_at desc`), so when it saturates, "nothing to
     * score" means "nothing in the newest 500" — item 501 can be an unscored design doc. A saturated
     * pass has not observed the eligible set and must not clear (BANNERSTUCK-1 §2a). `visibleItems`
     * is a passthrough for `team`, so nothing post-drops rows and this count is honest.
     */
    const scanSaturated = items.length >= ITEM_SCAN;

    // AUTHORED DOCUMENTS only — `isScoreableSource` carries the reasoning for each exclusion, and
    // `classifyWork` drops SIGNAL (a decision, a meeting: data ABOUT work).
    const docRows = items.filter((r) => {
      const fm = r.frontmatter ?? {};
      const source = normalizeSource(str(fm.source));
      if (!isScoreableSource(source)) return false;
      return classifyWork(r.kind, str(fm.source)) === "work";
      // No work-time check here: the SQL window above already restricted to rows the timeline would keep.
    });
    if (!docRows.length) {
      if (!scanSaturated) await clearIfHealed("nothing-to-score");
      return { scored: 0, linked: 0, skipped: "nothing-to-score" };
    }

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

    /**
     * What each doc's RAW owner is, which `credit` alone cannot say once `primaryId` is null: a
     * connector (no human to reason about — a legitimate nothing-to-do) or an id that resolves to no
     * member row for this team (a data fault). Only the health-clearing decision needs the difference
     * (BANNERSTUCK-1); scoring drops both regardless.
     *
     * A plain read rather than widening the attribution oracle or `teamRoster`: the oracle's return
     * carries credited ids, not owner kinds, and `teamRoster` filters `status='active'`, which would
     * make a deactivated human look unresolvable.
     */
    const ownerKindById = await ownerKinds(db, teamId, docRows.map((r) => r.member_id));

    const docs: InferDoc[] = docRows.map((r) => ({
      id: r.id,
      memberId: credit.get(r.id)?.primaryId ?? null,
      ownerKind: ownerKindById.get(r.member_id ?? "") ?? "unresolvable",
      title: str(r.frontmatter?.title) ?? (r.path ? r.path.split("/").pop() ?? r.path : "(untitled)"),
      contentSha: r.content_sha256 ?? "",
      access: r.access === "external" ? "external" : "team",
      hasDeterministicLink: (deterministic.get(r.id) ?? []).length > 0,
      // `body` is attached later — only for the docs that survive the skip check (see below).
    }));

    const allScoreable = scoreableDocs(docs);
    if (!allScoreable.length) {
      // Every doc was dropped. Deterministic-linked, external and connector-owned are settled facts —
      // nothing to do. An owner resolving to NO member row is a data fault, and a pass that hit one
      // has judged nothing, so it must not clear (`hasUnjudgeableDrop`).
      if (!scanSaturated && !hasUnjudgeableDrop(docs)) await clearIfHealed("nothing-to-score");
      return { scored: 0, linked: 0, skipped: "nothing-to-score" };
    }

    // Resolve each task's assignee to a member so ranking uses the identity mapping, not the raw string
    // (prod carries `Chetan` / `chetan.nandakumar` / `John Ellison` / `john` for two people).
    // ONE resolver, shared with the timeline (`people-match.assigneeMember`). Two differently-fuzzy
    // copies is how the card and this pass came to disagree about who owns a task: an exact-match copy
    // resolved `"Chetan"` against display name "Chetan Nandakumar" to null, so his own task was ranked
    // as someone else's here while the card called it his.
    const roster = await teamRoster(db, teamId);
    const candidates: InferCandidate[] = tasks.map((t) => ({
      id: t.id,
      rowKey: t.row_key,
      title: t.title || "(untitled task)",
      assigneeMemberId: assigneeMember(t.assignee, roster),
    }));

    // SKIP-IF-ALREADY-SCORED, **per item**. Same doc content + same question → the previous answer still
    // holds, so re-asking re-spends for an identical result.
    //
    // Per item, and not one hash per team over the batch, because that cannot drain a backlog: the batch
    // is a fixed slice of `allScoreable`, and a doc the model DECLINES never leaves that set — so once a
    // whole batch comes back "no match" the hash is invariant and the pass skips forever. Slicing
    // newest-first merely hides it (new arrivals keep changing the slice while older docs stay unscored);
    // slicing oldest-first makes it total, since nothing older ever arrives. Recording what was scored is
    // what lets the batch advance. Since unlinked work is omitted from the card, an unscored doc is
    // INVISIBLE rather than merely unlinked, so "the pass quietly stopped" is not a survivable state.
    //
    // The key covers the doc's CONTENT and the inputs hash (prompt + candidate set), so an edited doc, an
    // edited prompt, or a NEW task all re-score — a "no match" is only remembered while the question is.
    // Keys on `content_sha256`, never the prose, which is what lets the body read stay behind this check.
    const inputsHash = inferenceInputsHash([], candidates, DOC_TASK_SYSTEM);
    const alreadyScored = await scoredKeys(db, teamId, allScoreable.map((d) => d.id));
    const pending = allScoreable.filter((d) => !alreadyScored.has(`${d.id}:${d.contentSha}:${inputsHash}`));
    if (!pending.length) {
      if (!scanSaturated) await clearIfHealed("unchanged");
      return { scored: 0, linked: 0, skipped: "unchanged" };
    }
    // OLDEST-FIRST is now just fairness: the scored ones drop out of `pending`, so the queue drains
    // whichever end it is taken from. Oldest-first stops a steady drip of new docs starving the tail.
    const scoreable = pending.slice(-batchCap).reverse();

    // Only NOW pull prose, and only for the ≤MAX_DOCS docs actually being scored.
    const withBodies = await attachBodies(db, teamId, scoreable);

    // ONE CALL PER WORKER, not one per batch. Every worker is offered the same tasks, but `candidatesFor`
    // RANKS their own first and `buildInferPrompt` MARKS those as the author's — both derived from one
    // person. A single call built from the FIRST doc's author would therefore label John's tickets as
    // Chetan's to the model, actively arguing for the cross-person link the ordering exists to discourage.
    // The call count is the number of distinct people in the batch (2–3 in practice), not the doc count.
    const byWorker = new Map<string, InferDoc[]>();
    for (const doc of withBodies) {
      if (!doc.memberId) continue; // `scoreableDocs` already drops these; belt-and-braces
      byWorker.set(doc.memberId, [...(byWorker.get(doc.memberId) ?? []), doc]);
    }

    const links: InferredLink[] = [];
    // SETTLED = the docs this run actually has an answer for. The prune and `markScored` derive from
    // THIS, never from the whole batch: with one call per worker, a single provider timeout on worker B
    // would otherwise delete B's existing links (the prune covers the batch) AND record B's docs as
    // scored (so they are never re-asked) — a transient blip silently eating a person's links forever.
    const settled: InferDoc[] = [];
    let workersFailed = 0;
    for (const docs of byWorker.values()) {
      const ranked = candidatesFor(docs[0], candidates);
      // UNREACHABLE today — `candidates` is non-empty (the run returns `no-candidates` above when the team
      // has no tasks) and `candidatesFor` no longer filters, so `ranked` always has something. Kept because
      // the alternative to settling an empty list is asking the model to match against zero tasks: a paid
      // call that can only answer "no match", every run, for docs that then never leave the batch. If the
      // candidate list is ever narrowed again, that regression is silent — this branch is what stops it.
      if (!ranked.length) {
        settled.push(...docs);
        continue;
      }
      const { prompt, docByRef, taskByRef } = buildInferPrompt(docs, ranked);

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
          // A PASS, not a per-call record — and the reasoning took two review rounds to get right.
          // The first draft called this a fan-out "one call per scored doc", copied from a stale
          // exemption reason; that is false, and the comment above says so in capitals (ONE CALL PER
          // WORKER, "2-3 in practice"). So the second draft made it per-call. Review then showed the
          // CONCLUSION was still wrong for a different reason: `MAX_DOCS = 40` bounds DOCS, not
          // workers, so 40 pending docs from 40 distinct members is 40 calls — 40 rows per run, which
          // is precisely the flood a pass exists to prevent. "2-3 in practice" is an observation, not
          // a bound, and a ledger cannot be protected by a typical case.
          //
          // `doc-task-infer` (hyphenated) is a `meta.task` inside `source='llm'`, and is NOT the
          // `source='doc_task_infer'` row this function already writes for its own leg. Different
          // ledgers, different questions: "did this leg run" vs "is the model producing output".
          record: pass,
        }
      );
      if (!raw) {
        workersFailed++;
        continue; // NOT settled — these docs keep their links and come round again next run
      }
      settled.push(...docs);
      const choices = parseInferResponse(raw, docByRef, taskByRef);
      links.push(
        ...applyInferredLinks(choices, new Set(ranked.map((c) => c.id)), new Set(docs.map((d) => d.id)))
      );
    }
    // Nothing answered at all → a failed run, so the cooldown retries it. Gated on `settled`, not on
    // `links`: a worker that legitimately answered "no match" HAS settled, and discarding that would
    // re-pay for the same answer every cycle.
    if (!settled.length) {
      // ok=FALSE: nothing was answered, so the health card must not read this as a healthy pass. The
      // cooldown applies either way (`lastRun` doesn't filter on ok), so this only affects honesty.
      // `scored: 0` for the same reason — the batch size is not what was scored.
      await record(db, teamId, startedAt, false, { inputs_hash: inputsHash, scored: 0, linked: 0 }, [
        docTaskInferFailureReason(pass.firstError),
      ]);
      return { scored: 0, linked: 0, skipped: "model-null" };
    }

    // Replace THIS BATCH's edges — scoped by `method='llm'` AND by the item ids just scored.
    //
    // Both halves of that scope are load-bearing. `method` keeps the two writers off each other (the
    // deterministic one prunes `issue_ref` the same way). The ITEM filter is what makes the pass
    // additive across batches: when the batch was a fixed newest-N slice, a team-wide delete was a true
    // replace, but batches now ROTATE through the backlog, so a team-wide delete would wipe every
    // earlier batch's links on each run — and those docs are recorded as scored, so they are never
    // re-asked and never come back. Coverage would cap at one batch forever, and since unlinked work is
    // omitted from the card, the wiped docs would go invisible rather than merely unlinked.
    // ONE definition of "what this run answered" — `settled`. The prune and `markScored` must agree:
    // pruning a doc we then fail to record would drop its link and re-ask next run; recording a doc we
    // did not prune would leave a stale edge behind an un-reaskable key.
    const batchIds = settled.map((d) => d.id);
    const del = await db
      .from("task_evidence")
      .delete()
      .eq("team_id", teamId)
      .eq("method", "llm")
      .in("item_id", batchIds);
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

    // Mark the batch scored AFTER the pass succeeded — including the docs the model declined, because
    // "no match" is a real answer and re-asking for it every cycle is the spend this table prevents. A
    // FAILED pass records nothing here, so it retries.
    await markScored(db, teamId, settled, inputsHash);
    await record(db, teamId, startedAt, true, {
      inputs_hash: inputsHash,
      scored: settled.length,
      linked: links.length,
      // A partial failure must be visible: `ok` with a silent shortfall is how "the pass is degraded"
      // becomes indistinguishable from "there was nothing to link".
      ...(workersFailed ? { workers_failed: workersFailed } : {}),
    });
    return { scored: settled.length, linked: links.length };
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
 *
 * MUST be id-preserving: its output defines the batch that is offered to the model, pruned, and recorded
 * as scored. Dropping a doc here would record it as answered without ever asking about it.
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
 *  • The skip-if-unchanged is now PER ITEM (`doc_task_inference`), so only `finishedAt` is read here.
 *    The recorded `meta.inputs_hash` stays as run PROVENANCE — it answers "what question did this run
 *    ask?" when reading the ledger — but nothing branches on it any more.
 */
async function lastRun(
  db: DbClient,
  teamId: string
): Promise<{ finishedAt: number; inputsHash: string | null; ok: boolean } | null> {
  try {
    const { data } = await db
      .from("ingest_runs")
      .select("id, meta, ok, finished_at")
      .eq("team_id", teamId)
      .eq("source", DOC_TASK_INFER_SOURCE)
      .order("finished_at", { ascending: false })
      // `id` desc as the SAME tie-break `STREAK_SQL` uses (`lib/ingest/pipeline-health.ts`). Without it
      // two rows sharing a millisecond — a fast fail then a retry in one tick — can resolve here in the
      // opposite order to the banner, so `ok` below would disagree with the verdict the user is seeing.
      .order("id", { ascending: false })
      .limit(CLOCK_SCAN);
    const rows = (data ?? []) as {
      meta?: { inputs_hash?: unknown; health_clear?: unknown } | null;
      ok?: boolean;
      finished_at?: string | Date;
    }[];
    // THE PAID-RUN CLOCK IGNORES CLEARING ROWS. A `health_clear` row is written at the moment the leg
    // HEALS and carries a near-current timestamp, so counting it would start a fresh 12h cooldown at
    // exactly the point the leg recovers: a doc arriving a minute later would wait until evening for
    // linking that costs one tick today. The cooldown exists to bound PAID runs, and a clearing pass
    // paid for nothing.
    const newest = rows[0] ?? null;
    const row = rows.find((r) => r?.meta?.health_clear !== true) ?? null;
    if (!newest) return null;
    const raw = row?.finished_at;
    const finishedAt = raw ? (typeof raw === "string" ? Date.parse(raw) : new Date(raw).getTime()) : 0;
    const h = row?.ok ? row.meta?.inputs_hash : null;
    return {
      // From the newest PAID run — see above.
      finishedAt: Number.isFinite(finishedAt) ? finishedAt : 0,
      inputsHash: typeof h === "string" && h ? h : null,
      // …but the VERDICT is the newest row of ANY kind, because that is what the banner reads. Taking
      // it from the paid row would make the pass re-clear a leg it has already cleared, every tick.
      ok: newest.ok === true,
    };
  } catch {
    return null; // unreadable history → run (spending once beats silently never running again)
  }
}

/** `item:contentSha:inputsHash` for everything this team has already been asked about. */
async function scoredKeys(db: DbClient, teamId: string, itemIds: string[]): Promise<Set<string>> {
  if (!itemIds.length) return new Set();
  const { data, error } = await db
    .from("doc_task_inference")
    .select("item_id, content_sha256, inputs_sha256")
    .eq("team_id", teamId)
    // Bounded to the docs actually in play — the table grows with corpus age, and only rows for the
    // current scoreable set can affect this decision.
    .in("item_id", itemIds);
  // A read failure means we cannot tell what was scored. Returning an EMPTY set re-asks (costs tokens);
  // returning a full one would skip everything (costs correctness, silently). Spend is the recoverable
  // side of that trade, and the cooldown bounds it.
  if (error) return new Set();
  return new Set(
    ((data ?? []) as { item_id: string; content_sha256: string; inputs_sha256: string }[]).map(
      (r) => `${r.item_id}:${r.content_sha256}:${r.inputs_sha256}`
    )
  );
}

/** Record a scored batch. Best-effort: failing to remember costs a re-ask, never a wrong answer. */
async function markScored(
  db: DbClient,
  teamId: string,
  docs: readonly { id: string; contentSha: string }[],
  inputsHash: string
): Promise<void> {
  if (!docs.length) return;
  const at = new Date().toISOString();
  const { error } = await db.from("doc_task_inference").upsert(
    docs.map((d) => ({
      team_id: teamId,
      item_id: d.id,
      content_sha256: d.contentSha,
      inputs_sha256: inputsHash,
      scored_at: at,
    })),
    { onConflict: "team_id,item_id" }
  );
  if (error) console.warn("[doc-task] could not record scored batch:", error.message);
}

/**
 * Record that this pass ran cleanly and found no work — the row that lets a CONFIRMED failure streak
 * clear (BANNERSTUCK-1).
 *
 * ⚠️ `finishedAt` is the pass's OWN `startedAt`, and that is the whole correctness argument. Two
 * callers reach this leg (`lib/ingest/scheduler.ts` and `lib/dashboard/timeline-cache.ts`) and they
 * are not mutually single-flighted, so a clearing pass can overlap a failing one. `STREAK_SQL` orders
 * `finished_at desc, id desc`, so backdating makes any row whose `finished_at` is after this pass
 * began sort strictly newer — a concurrent failure cannot be hidden by commit order or snapshot visibility. A guard
 * (`insert … where not exists`) does NOT achieve this: under READ COMMITTED the subquery cannot see
 * an uncommitted failure, so both rows land and the clearing row still wins.
 *
 * Residuals, stated rather than claimed away: a failure finishing in the SAME millisecond loses the
 * `id desc` tie, and two processes with skewed clocks compare timestamp values rather than a shared
 * order. Both are bounded — the scheduler runs inside the web process, so the live deployment has one
 * clock — and self-correcting, because `failing` needs a streak of two.
 *
 * ⚠️ The row is SYNTHETIC health evidence, not a timed pass: `duration_ms` is 0 by construction and
 * `finished_at` is the pass's start, not its end.
 *
 * Exported so the ordering property can be tested deterministically. An idle pass has no awaitable
 * seam between its reads and this write, so a `Promise.all` race test would pass even with the
 * mechanism removed.
 */
export async function recordClearingRun(
  db: DbClient,
  teamId: string,
  passStartedAt: number,
  reason: string
): Promise<void> {
  await recordIngestRun(db, {
    teamId,
    source: DOC_TASK_INFER_SOURCE,
    trigger: "scheduler",
    ok: true,
    errors: [],
    meta: { health_clear: true, skipped: reason },
    startedAt: passStartedAt,
    finishedAt: passStartedAt,
  });
}

/**
 * Classify each raw `items.member_id` as a human, a connector, or unresolvable-on-this-team.
 *
 * Deliberately NOT filtered on `status`: a deactivated human is still a human, and treating them as
 * unresolvable would make a normal roster change look like a data fault and block health clearing.
 * On a read error every id is reported `unresolvable`, which fails CLOSED — the pass then declines to
 * clear rather than clearing on an unread roster.
 */
async function ownerKinds(
  db: DbClient,
  teamId: string,
  memberIds: readonly (string | null)[]
): Promise<Map<string, OwnerKind>> {
  const out = new Map<string, OwnerKind>();
  const ids = [...new Set(memberIds.filter((m): m is string => !!m))];
  if (!ids.length) return out;
  try {
    const { data, error } = await db
      .from("members")
      .select("id, is_connector")
      .eq("team_id", teamId)
      .in("id", ids);
    if (error) return out; // every id stays absent → `unresolvable` → no clearing. Fail closed.
    for (const m of (data ?? []) as { id: string; is_connector: boolean | null }[]) {
      out.set(m.id, m.is_connector ? "connector" : "human");
    }
  } catch {
    return new Map(); // same fail-closed reasoning
  }
  return out;
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

/**
 * The team's active roster, for `assigneeMember`.
 *
 * THROWS on a read failure — deliberately not best-effort. Ownership now decides candidate RANKING (own
 * tasks first, and the prompt marks them as the author's), so an empty roster silently downgrades every
 * task to "someone else's" and the product rule stops applying with no signal. A thrown error records a
 * failed run instead, and the cooldown retries it.
 */
async function teamRoster(db: DbClient, teamId: string): Promise<RosterPerson[]> {
  const { data, error } = await db
    .from("members")
    .select("id, display_name, actor_handle")
    .eq("team_id", teamId)
    .eq("status", "active");
  if (error) throw new Error(`roster read failed: ${error.message}`);
  return ((data ?? []) as { id: string; display_name: string | null; actor_handle: string | null }[]).map((m) => ({
    memberId: m.id,
    displayName: m.display_name ?? "",
    handle: m.actor_handle ?? "",
  }));
}
