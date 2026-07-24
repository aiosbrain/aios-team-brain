import { createHash } from "node:crypto";

/**
 * LLM doc→task assignment — the PURE decision core (docs/design/doc-task-assignment.md).
 *
 * A document rarely cites `AIO-494` in its title or path, so the deterministic matcher
 * (`lib/dashboard/issue-ref.computeTaskLinks`) leaves it unlinked and it falls to the "Other" bucket.
 * This module decides WHICH docs are eligible to be scored, WHICH tasks may be offered as candidates, and
 * WHICH of the model's answers are allowed to become links. The model call itself and all DB access live
 * outside — everything here is pure and DB-free so the trust boundary is unit-testable.
 *
 * SOURCE-AGNOSTIC by design: it takes an already-attributed doc with a work-time, whatever produced it —
 * the aios CLI daily loop today, Notion/Google Drive once those connectors are on — so a second source
 * needs no second implementation.
 *
 * The four guarantees, in one place:
 *   1. An inference NEVER outranks a deterministic link (own issue key, or a commit's PR-inherited task).
 *   2. "No match" is first-class and expected; a below-threshold match is treated as no match.
 *   3. TIER (no RLS — app code is the only enforcement): the model is only ever handed candidates the
 *      viewer can already see, and any id it returns outside that set links nothing, SILENTLY.
 *   4. `access='external'` items are never scored — untrusted client frontmatter must not drive a link.
 */

/** Below this the model's answer is recorded as thinking but never used as a link. */
export const MIN_CONFIDENCE = 0.7;

/** Candidate ceiling per call — bounds prompt size (and cost) on a big backlog. */
const MAX_CANDIDATES = 50;

export interface InferDoc {
  id: string;
  /** The doc's credited worker (from the shared attribution oracle), NOT the raw pusher. */
  memberId: string | null;
  title: string;
  /** `items.content_sha256` — an edited doc must re-score, so the hash keys on content, not id. */
  contentSha: string;
  access: "team" | "external";
  /** True when `computeTaskLinks` (or a commit's PR inheritance) already produced a link. */
  hasDeterministicLink: boolean;
}

export interface InferCandidate {
  id: string;
  rowKey: string | null;
  title: string;
  /** Resolved through the identity mapping — never a raw assignee string (prod has 3 spellings/person). */
  assigneeMemberId: string | null;
}

/** One decision from the model, already parsed/validated at the transport edge. */
export interface ModelChoice {
  docId: string;
  /** null = the explicit no-match answer. */
  taskId: string | null;
  confidence: number;
  rationale: string;
}

/** A row destined for `task_evidence` (which already allows `method='llm'` + confidence + detail). */
export interface InferredLink {
  itemId: string;
  taskId: string;
  method: "llm";
  confidence: number;
  detail: string;
}

/**
 * Which docs may be sent to the model. Guarantees 1 and 4 live here: an already-linked doc is never
 * scored (so an inference can't compete with a deterministic link), nor is an external-tier item, nor one
 * with no attributed worker (there would be no person to reason about).
 */
export function scoreableDocs(docs: readonly InferDoc[]): InferDoc[] {
  return docs.filter((d) => !d.hasDeterministicLink && d.access !== "external" && !!d.memberId);
}

/**
 * The candidate list for one doc, ranked. The doc author's OWN assigned tasks come first, but the rest of
 * the visible active set is still offered: a doc about a teammate's ticket is a real case, and hard-scoping
 * to the author's assignments would silently drop it. `visible` MUST already have come through the
 * `visibleTasks` choke-point — this function does not (and cannot) enforce tier by itself.
 */
export function candidatesFor(doc: InferDoc, visible: readonly InferCandidate[]): InferCandidate[] {
  const mine = visible.filter((c) => c.assigneeMemberId && c.assigneeMemberId === doc.memberId);
  const others = visible.filter((c) => !(c.assigneeMemberId && c.assigneeMemberId === doc.memberId));
  return [...mine, ...others].slice(0, MAX_CANDIDATES);
}

/**
 * The model's answers → the links we are willing to persist. Guarantees 2 and 3: an explicit no-match, a
 * below-threshold score, a malformed confidence, or an id outside the visible set all yield NO link, with
 * no error — silence is the correct behavior for a link that simply doesn't exist.
 */
export function applyInferredLinks(
  choices: readonly ModelChoice[],
  visibleTaskIds: ReadonlySet<string>
): InferredLink[] {
  const links: InferredLink[] = [];
  for (const c of choices) {
    if (!c.taskId) continue; // the expected outcome, not a failure
    if (!Number.isFinite(c.confidence) || c.confidence < MIN_CONFIDENCE || c.confidence > 1) continue;
    if (!visibleTaskIds.has(c.taskId)) continue; // TIER: never resolve an id we didn't offer
    links.push({
      itemId: c.docId,
      taskId: c.taskId,
      method: "llm",
      confidence: c.confidence,
      detail: c.rationale,
    });
  }
  return links;
}

/**
 * Skip-if-unchanged key, mirroring the `arc_cache` facts-hash rule (`lib/graph/arcs.ts:588-711`): it covers
 * everything that determines the output — each doc's CONTENT (so an edit re-scores), the candidate set, and
 * **the system prompt itself**, so a deploy that edits the prompt re-runs instead of serving stale
 * judgments. Order-independent: the same set fetched in a different order is the same work.
 */
export function inferenceInputsHash(
  docs: readonly InferDoc[],
  candidates: readonly InferCandidate[],
  systemPrompt: string
): string {
  const docPart = docs.map((d) => `${d.id}:${d.contentSha}`).sort().join("\n");
  const candPart = candidates.map((c) => `${c.id}:${c.rowKey ?? ""}:${c.title}`).sort().join("\n");
  return createHash("sha256")
    .update(systemPrompt)
    .update("\n--docs--\n")
    .update(docPart)
    .update("\n--candidates--\n")
    .update(candPart)
    .digest("hex");
}
