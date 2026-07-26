import { describe, expect, it } from "vitest";
import {
  MIN_CONFIDENCE,
  candidatesFor,
  inferenceInputsHash,
  scoreableDocs,
  applyInferredLinks,
  type InferCandidate,
  type InferDoc,
  type ModelChoice,
} from "@/lib/dashboard/doc-task-infer";

/**
 * Spec for the LLM doc→task assignment (docs/design/doc-task-assignment.md). Written from what the
 * product must guarantee, not from the implementation:
 *
 *   • An inference NEVER outranks a deterministic link (own issue key, or a commit's PR-inherited task).
 *   • "No match" is a first-class, expected answer — and a low-confidence match is the same as no match.
 *   • The model may only ever choose from candidates the VIEWER can already see (no RLS backstop), and an
 *     id it returns that isn't in that set links nothing, silently.
 *   • `access='external'` items are never scored — untrusted client frontmatter must not drive a link.
 *   • Re-running must not re-spend: the hash covers doc CONTENT, the candidate set, and the prompt.
 */

const doc = (over: Partial<InferDoc> = {}): InferDoc => ({
  id: "item-1",
  memberId: "member-a",
  title: "Attribution ownership timeline",
  contentSha: "sha-doc-1",
  access: "team",
  hasDeterministicLink: false,
  ...over,
});

const cand = (id: string, over: Partial<InferCandidate> = {}): InferCandidate => ({
  id,
  rowKey: id.toUpperCase(),
  title: `task ${id}`,
  assigneeMemberId: null,
  ...over,
});

describe("scoreableDocs — what the model is allowed to see", () => {
  it("skips a doc that already has a deterministic link (deterministic always wins)", () => {
    const docs = [doc({ id: "linked", hasDeterministicLink: true }), doc({ id: "unlinked" })];
    expect(scoreableDocs(docs).map((d) => d.id)).toEqual(["unlinked"]);
  });

  it("NEVER scores an external-tier item (untrusted client frontmatter)", () => {
    const docs = [doc({ id: "ext", access: "external" }), doc({ id: "team-doc" })];
    expect(scoreableDocs(docs).map((d) => d.id)).toEqual(["team-doc"]);
  });

  it("skips an unattributed doc — there is no person to reason about", () => {
    expect(scoreableDocs([doc({ id: "orphan", memberId: null })])).toEqual([]);
  });
});

describe("candidatesFor — the person's tasks first, but never hard-restricted", () => {
  const visible = [
    cand("t1", { assigneeMemberId: "member-b" }),
    cand("t2", { assigneeMemberId: "member-a" }),
    cand("t3", { assigneeMemberId: null }),
  ];

  it("ranks the doc author's own assigned tasks first", () => {
    expect(candidatesFor(doc(), visible).map((c) => c.id)[0]).toBe("t2");
  });

  it("still OFFERS a teammate's task — a doc about someone else's ticket is a real case", () => {
    // The alternative (hard-scoping to the author's assignments) would silently drop it, and prod
    // assignee strings are too messy to bet correctness on.
    expect(candidatesFor(doc(), visible).map((c) => c.id).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("is bounded — a huge backlog can't blow the prompt", () => {
    const many = Array.from({ length: 500 }, (_, i) => cand(`t${i}`));
    expect(candidatesFor(doc(), many).length).toBeLessThanOrEqual(50);
  });
});

describe("applyInferredLinks — the trust boundary", () => {
  const visibleIds = new Set(["t1", "t2"]);
  const offeredDocs = new Set(["item-1"]);
  const choice = (over: Partial<ModelChoice> = {}): ModelChoice => ({
    docId: "item-1",
    taskId: "t1",
    confidence: 0.9,
    rationale: "describes the ownership timeline work",
    ...over,
  });

  it("links a confident choice that is inside the visible set", () => {
    const out = applyInferredLinks([choice()], visibleIds, offeredDocs);
    expect(out).toEqual([
      { itemId: "item-1", taskId: "t1", method: "llm", confidence: 0.9, detail: "describes the ownership timeline work" },
    ]);
  });

  it("an explicit NO MATCH produces no link (the expected outcome, not a failure)", () => {
    expect(applyInferredLinks([choice({ taskId: null })], visibleIds, offeredDocs)).toEqual([]);
  });

  it("a BELOW-THRESHOLD match produces no link", () => {
    expect(applyInferredLinks([choice({ confidence: MIN_CONFIDENCE - 0.01 })], visibleIds, offeredDocs)).toEqual([]);
  });

  it("TIER: a task id outside the visible set links nothing, silently", () => {
    // The model can only be handed visible candidates, but a hallucinated/stale id must never resolve.
    expect(applyInferredLinks([choice({ taskId: "t-secret" })], visibleIds, offeredDocs)).toEqual([]);
  });

  it("a docId we never OFFERED links nothing — both sides of the pair are validated", () => {
    // Guarantees 1 and 4 (deterministic-wins, external-excluded) are enforced by what we put IN the
    // batch; validating only the task id would let an echoed/hallucinated docId smuggle a link back out.
    expect(applyInferredLinks([choice({ docId: "item-never-offered" })], visibleIds, offeredDocs)).toEqual([]);
  });

  it("collapses duplicate choices for the same (doc, task) pair — the table's PK", () => {
    const out = applyInferredLinks([choice(), choice({ confidence: 0.95 })], visibleIds, offeredDocs);
    expect(out).toHaveLength(1);
  });

  it("drops a malformed confidence rather than trusting it", () => {
    expect(applyInferredLinks([choice({ confidence: Number.NaN })], visibleIds, offeredDocs)).toEqual([]);
    expect(applyInferredLinks([choice({ confidence: 42 })], visibleIds, offeredDocs)).toEqual([]);
  });
});

describe("inferenceInputsHash — re-running must not re-spend", () => {
  const docs = [doc()];
  const cands = [cand("t1")];
  const prompt = "SYSTEM v1";

  it("is stable for identical inputs", () => {
    expect(inferenceInputsHash(docs, cands, prompt)).toBe(inferenceInputsHash(docs, cands, prompt));
  });

  it("changes when the doc CONTENT changes (an edited doc must re-score)", () => {
    const edited = [doc({ contentSha: "sha-doc-2" })];
    expect(inferenceInputsHash(edited, cands, prompt)).not.toBe(inferenceInputsHash(docs, cands, prompt));
  });

  it("changes when the candidate set changes", () => {
    expect(inferenceInputsHash(docs, [...cands, cand("t2")], prompt)).not.toBe(inferenceInputsHash(docs, cands, prompt));
  });

  it("changes when the PROMPT changes — a deploy that edits it re-runs, never serves stale judgments", () => {
    expect(inferenceInputsHash(docs, cands, "SYSTEM v2")).not.toBe(inferenceInputsHash(docs, cands, prompt));
  });

  it("cannot be spoofed by a title containing the field separator", () => {
    const a = [cand("t1", { title: "plain" })];
    const b = [cand("t1", { title: "plain\nsmuggled" })];
    expect(inferenceInputsHash(docs, a, prompt)).not.toBe(inferenceInputsHash(docs, b, prompt));
  });

  it("is order-independent (the same set fetched in a different order is the same work)", () => {
    const a = [doc({ id: "d1" }), doc({ id: "d2" })];
    const b = [doc({ id: "d2" }), doc({ id: "d1" })];
    expect(inferenceInputsHash(a, cands, prompt)).toBe(inferenceInputsHash(b, cands, prompt));
  });
});
