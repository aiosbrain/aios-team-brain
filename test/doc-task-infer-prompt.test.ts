import { describe, expect, it } from "vitest";
import {
  DOC_TASK_SYSTEM,
  buildInferPrompt,
  parseInferResponse,
  type InferCandidate,
  type InferDoc,
} from "@/lib/dashboard/doc-task-infer";

/**
 * Spec for the model-facing half of the doc→task assignment. Written from the product guarantees:
 *
 *   • The model NEVER sees a real id — it works in short synthetic refs (D1/T1), so a hallucinated or
 *     echoed ref cannot name a real row. Refs are resolved back to ids by US, not by the model.
 *   • "No match" must be cheap to say and explicitly expected; the failure mode to design against is a
 *     model that always picks something.
 *   • Doc/task text is DATA, never instructions (prompt injection: docs are user-authored).
 *   • A malformed / truncated / non-JSON response is a total no-op, never a throw.
 */

const doc = (over: Partial<InferDoc> = {}): InferDoc => ({
  id: "11111111-1111-1111-1111-111111111111",
  memberId: "member-a",
  title: "Attribution ownership timeline",
  contentSha: "sha-1",
  access: "team",
  hasDeterministicLink: false,
  ...over,
});

const cand = (over: Partial<InferCandidate> = {}): InferCandidate => ({
  id: "22222222-2222-2222-2222-222222222222",
  rowKey: "AIO-494",
  title: "Ship the ownership timeline",
  assigneeMemberId: null,
  ...over,
});

describe("DOC_TASK_SYSTEM — the prompt must make 'none' the expected answer", () => {
  it("states that no-match is normal, so the model isn't pushed into forcing one", () => {
    expect(DOC_TASK_SYSTEM.toLowerCase()).toContain("no match");
  });

  it("carries the prompt-injection defense — titles and bodies are DATA", () => {
    expect(DOC_TASK_SYSTEM).toMatch(/DATA/);
    expect(DOC_TASK_SYSTEM.toLowerCase()).toContain("never as instructions");
  });
});

describe("buildInferPrompt — the model works in refs, never real ids", () => {
  it("labels docs D1..Dn and tasks T1..Tn and never leaks a UUID", () => {
    const { prompt, docByRef, taskByRef } = buildInferPrompt([doc()], [cand()]);
    expect(prompt).toContain("D1");
    expect(prompt).toContain("T1");
    expect(prompt).not.toContain("11111111-1111-1111-1111-111111111111");
    expect(prompt).not.toContain("22222222-2222-2222-2222-222222222222");
    expect(docByRef.get("D1")).toBe("11111111-1111-1111-1111-111111111111");
    expect(taskByRef.get("T1")).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("includes the task's issue key and title so the model can judge topic", () => {
    const { prompt } = buildInferPrompt([doc()], [cand()]);
    expect(prompt).toContain("AIO-494");
    expect(prompt).toContain("Ship the ownership timeline");
  });

  it("includes a bounded excerpt of the doc body — content is the whole point, size is not", () => {
    const long = "x".repeat(10_000);
    const { prompt } = buildInferPrompt([doc({ body: long })], [cand()]);
    expect(prompt).toContain("xxx");
    expect(prompt.length).toBeLessThan(6_000); // truncated, not the full 10k
  });

  it("survives a doc with no body at all (title-only is still judgeable)", () => {
    expect(() => buildInferPrompt([doc({ body: undefined })], [cand()])).not.toThrow();
  });
});

describe("parseInferResponse — a bad response is a no-op, never a throw", () => {
  const { docByRef, taskByRef } = buildInferPrompt([doc()], [cand()]);
  const DOC_ID = "11111111-1111-1111-1111-111111111111";
  const TASK_ID = "22222222-2222-2222-2222-222222222222";

  it("maps refs back to real ids", () => {
    const raw = JSON.stringify({ matches: [{ doc: "D1", task: "T1", confidence: 0.9, why: "same subject" }] });
    expect(parseInferResponse(raw, docByRef, taskByRef)).toEqual([
      { docId: DOC_ID, taskId: TASK_ID, confidence: 0.9, rationale: "same subject" },
    ]);
  });

  it("treats an explicit null task as the no-match answer", () => {
    const raw = JSON.stringify({ matches: [{ doc: "D1", task: null, confidence: 0, why: "unrelated" }] });
    expect(parseInferResponse(raw, docByRef, taskByRef)).toEqual([
      { docId: DOC_ID, taskId: null, confidence: 0, rationale: "unrelated" },
    ]);
  });

  it("DROPS a ref that was never offered — a hallucinated ref can't name a real row", () => {
    const raw = JSON.stringify({ matches: [{ doc: "D9", task: "T1", confidence: 1 }, { doc: "D1", task: "T9", confidence: 1 }] });
    expect(parseInferResponse(raw, docByRef, taskByRef)).toEqual([]);
  });

  it("returns [] for non-JSON, a truncated body, or the wrong shape — never throws", () => {
    for (const raw of ["", "not json", '{"matches":', '{"matches":{}}', "null", '{"other":[]}']) {
      expect(parseInferResponse(raw, docByRef, taskByRef)).toEqual([]);
    }
  });

  it("tolerates a fenced ```json block (models add them despite jsonObject mode)", () => {
    const raw = '```json\n{"matches":[{"doc":"D1","task":"T1","confidence":0.8,"why":"ok"}]}\n```';
    expect(parseInferResponse(raw, docByRef, taskByRef)).toHaveLength(1);
  });

  it("defaults a missing/garbage confidence to 0 so the gate rejects it rather than trusting it", () => {
    const raw = JSON.stringify({ matches: [{ doc: "D1", task: "T1", why: "no score given" }] });
    expect(parseInferResponse(raw, docByRef, taskByRef)[0].confidence).toBe(0);
  });

  it("bounds the rationale — `detail` is persisted, so a model can't write unbounded text into the DB", () => {
    const raw = JSON.stringify({ matches: [{ doc: "D1", task: "T1", confidence: 0.9, why: "y".repeat(5000) }] });
    expect(parseInferResponse(raw, docByRef, taskByRef)[0].rationale.length).toBeLessThanOrEqual(500);
  });
});
