import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the LLM + key resolution so the attach path is unit-testable without real calls.
const resolveAnsweringKeys = vi.fn(async () => ({ openrouterKey: "k" }) as Record<string, unknown>);
const completeTextOrNull = vi.fn();
vi.mock("@/lib/query/answering", () => ({ resolveAnsweringKeys: (...a: unknown[]) => resolveAnsweringKeys(...(a as [])) }));
vi.mock("@/lib/llm/complete", () => ({ completeTextOrNull: (...a: unknown[]) => completeTextOrNull(...(a as [])) }));

import { summaryPromptFor, type PersonDay, type TimelineDay } from "@/lib/dashboard/timeline-group";
import { llmConfigured, attachPersonDaySummaries } from "@/lib/dashboard/timeline-summary";

const person = (over: Partial<PersonDay> = {}): PersonDay => ({
  memberId: "m1", name: "Chetan", handle: "chetan", total: 1,
  tasks: [], other: [{ source: "github", count: 1, items: [{ id: "c1", title: "did a thing", source: "github", kind: "commit", at: "2026-07-22T09:00:00Z" }] }],
  ...over,
});
const fakeDb = {} as never;

describe("summaryPromptFor (pure LLM input)", () => {
  it("returns '' when the person has no work (caller skips the LLM call)", () => {
    expect(summaryPromptFor(person({ tasks: [], other: [] }), "Today")).toBe("");
  });
  it("lists in-progress tasks with nested work + Other, capping per-source items", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, title: `commit ${i}`, source: "github", kind: "commit", at: "2026-07-22T09:00:00Z" }));
    const p = person({ tasks: [{ taskId: "t1", title: "Adapter", status: "in_progress", evidenceCount: 1, sources: [{ source: "github", count: 20, items }] }], other: [] });
    const prompt = summaryPromptFor(p, "Today", 3);
    expect(prompt).toContain("Chetan on Today:");
    expect(prompt).toContain("Adapter [in_progress]");
    expect(prompt).toContain("commit 2");
    expect(prompt).not.toContain("commit 3");
  });
});

describe("llmConfigured (summary gate)", () => {
  it("false with no key/override/endpoint; true with a key or override", () => {
    const orig = process.env.LLM_BASE_URL;
    process.env.LLM_BASE_URL = "";
    expect(llmConfigured({})).toBe(false);
    expect(llmConfigured({ openrouterKey: "sk-or-x" })).toBe(true);
    expect(llmConfigured({ activeProvider: "anthropic" })).toBe(true);
    if (orig) process.env.LLM_BASE_URL = orig;
  });
});

describe("attachPersonDaySummaries", () => {
  beforeEach(() => {
    resolveAnsweringKeys.mockResolvedValue({ openrouterKey: "k" });
    completeTextOrNull.mockReset();
  });

  const days = (): TimelineDay[] => [
    { date: "2026-07-22", label: "Today", people: [person({ memberId: "a", name: "Alice" }), person({ memberId: "b", name: "Bob" })] },
  ];

  it("attaches the summary to the right person; a failing call leaves that person unset (best-effort)", async () => {
    completeTextOrNull.mockImplementation(async ({ prompt }: { prompt: string }) => (prompt.includes("Alice") ? "Alice shipped X." : null));
    const input = days();
    const out = await attachPersonDaySummaries(fakeDb, "team", input);
    const [alice, bob] = out[0].people;
    expect(alice.summary).toBe("Alice shipped X.");
    expect(bob.summary).toBeUndefined();
    // Immutable — the input array/objects are not mutated.
    expect(out).not.toBe(input);
    expect(input[0].people[0].summary).toBeUndefined();
  });

  it("skips entirely (returns the same array) when no LLM is configured", async () => {
    const orig = process.env.LLM_BASE_URL;
    process.env.LLM_BASE_URL = "";
    resolveAnsweringKeys.mockResolvedValue({});
    const input = days();
    const out = await attachPersonDaySummaries(fakeDb, "team", input);
    expect(out).toBe(input);
    expect(completeTextOrNull).not.toHaveBeenCalled();
    if (orig) process.env.LLM_BASE_URL = orig;
  });
});
