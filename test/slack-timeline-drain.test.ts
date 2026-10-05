import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { mergeTimelineSlackContinuation } from "@/lib/dashboard/timeline-continuation-merge";
import type { PersonDay, SourceGroup, TaskGroup, TimelineDay } from "@/lib/dashboard/timeline-group";

/**
 * AIO-1170 AC-09 — the inactive complete-drain adapter (`lib/dashboard/slack-timeline-drain.ts`).
 *
 * The drain turns authenticated Slack aggregate pages into the legacy `{ window_days: 7, days }`
 * answer, and its whole value is what it REFUSES: a page that claims to be final and carries a
 * cursor, a cursor that repeats or runs backwards, a binding that moved mid-traversal, a budget that
 * ran out. In every one of those cases the only acceptable outcomes are one fresh whole attempt or an
 * error — never the days accumulated so far.
 *
 * Pages here are fakes with injected, test-owned cursor tokens: the drain is handed its cursor
 * validator, so nothing in this file depends on the encryption the contract tests pin. The module is
 * loaded per test through a non-literal specifier so each case fails on its own while it is absent.
 */

const REPO = join(import.meta.dirname, "..");
const DRAIN_FILE = "lib/dashboard/slack-timeline-drain.ts";
const CONTRACT_FILE = "lib/dashboard/slack-timeline-page-contract.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the module under test does not exist yet
type Loose = Record<string, any>;
type Json = Record<string, unknown>;

type FailureCode = "invalid_request" | "restart_required" | "unavailable" | "budget_exhausted";

// The fake page service fails with the contract's OWN error type, so the drain is never asked to
// trust a look-alike: only a real SlackTimelineError carries a failure class.
let ContractError: (new (code: FailureCode, reason: string) => Error) | null = null;

async function drainModule(): Promise<Loose> {
  const contract = (await import(/* @vite-ignore */ join(REPO, CONTRACT_FILE))) as Loose;
  ContractError = contract.SlackTimelineError;
  return (await import(/* @vite-ignore */ join(REPO, DRAIN_FILE))) as Loose;
}

function failWith(code: FailureCode): Error {
  if (!ContractError) throw new Error("test setup: load the modules before injecting a failure");
  return new ContractError(code, "injected by the fake page service");
}

async function failureOf(run: () => unknown): Promise<Json> {
  try {
    await run();
  } catch (error) {
    const e = error as Json;
    return { ...e, name: String(e?.name), code: String(e?.code), message: String(e?.message) };
  }
  throw new Error("expected the drain to fail, but it returned a result");
}

const TEAM = "11111111-1111-4111-8111-111111111111";
const MEMBER_A = "a0000000-0000-4000-8000-00000000000a";
const MEMBER_B = "b0000000-0000-4000-8000-00000000000b";
const GITHUB_ITEM = "0f000000-0000-4000-8000-00000000000f";
const DAY_MS = 86_400_000;
const TTL_MS = 900_000;
const AS_OF_1 = Date.parse("2024-06-21T12:00:00.000Z");
const AS_OF_2 = AS_OF_1 + 30_000;
const hex = (seed: string): string => createHash("sha256").update(seed).digest("hex");
const ms = (value: number): string => new Date(value).toISOString();
const item = (n: number): string => `0a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Agg {
  itemId: string;
  memberId: string;
  at: string;
  tasks?: string[];
  title?: string;
}

const tupleOf = (a: Agg): Json => ({ day: a.at.slice(0, 10), at: a.at, itemId: a.itemId, memberId: a.memberId });
const idOf = (a: Agg): string => JSON.stringify([a.itemId, a.memberId, a.at.slice(0, 10)]);

function compareAggs(a: Agg, b: Agg): number {
  const text = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return text(b.at.slice(0, 10), a.at.slice(0, 10)) || text(b.at, a.at) || text(a.itemId, b.itemId) || text(a.memberId, b.memberId);
}

function binding(asOfMs: number, pageSize: number, over: Json = {}): Json {
  return {
    schemaVersion: 1, teamId: TEAM, principalKey: `member:${MEMBER_A}`, viewKey: hex("view"),
    admissionBindingDigest: hex("admission"), sourceAdmissionBindingDigest: hex("source"),
    authorizedSlackItemFingerprint: hex("items"), windowDays: 7,
    since: ms(asOfMs - 7 * DAY_MS), asOf: ms(asOfMs), issuedAt: ms(asOfMs), expiresAt: ms(asOfMs + TTL_MS),
    pageSize, dataGeneration: "1", identityGeneration: "1", presentationGeneration: "1",
    creditInputDigest: hex("credit"), presentationInputDigest: hex("presentation"), ...over,
  };
}

/** Deterministic test composer: one row per aggregate per task association, or under "other". */
function compose(aggregates: readonly Agg[], names: Record<string, string> = {}): TimelineDay[] {
  const days = new Map<string, Map<string, { tasks: Map<string, Json[]>; other: Json[] }>>();
  for (const a of aggregates) {
    const date = a.at.slice(0, 10);
    const people = days.get(date) ?? new Map();
    days.set(date, people);
    const p = people.get(a.memberId) ?? { tasks: new Map<string, Json[]>(), other: [] as Json[] };
    people.set(a.memberId, p);
    const row = { id: idOf(a), title: a.title ?? `Thread ${a.itemId.slice(-4)}`, source: "slack", kind: "thread", at: a.at };
    if (a.tasks?.length) for (const t of a.tasks) p.tasks.set(t, [...(p.tasks.get(t) ?? []), row]);
    else p.other.push(row);
  }
  return [...days].map(([date, people]) => ({
    date, label: `label ${date}`,
    people: [...people].map(([memberId, p]): PersonDay => ({
      memberId, name: names[memberId] ?? `Person ${memberId.slice(0, 2)}`, handle: `h-${memberId.slice(0, 2)}`, avatarUrl: null,
      total: 0, unlinked: 0, signals: [],
      tasks: [...p.tasks].map(([taskId, rows]): TaskGroup => ({
        taskId, title: `Task ${taskId}`, status: "in_progress", source: "linear", evidenceCount: rows.length,
        sources: [{ source: "slack", count: rows.length, items: rows as never[] }],
      })),
      other: p.other.length ? [{ source: "slack", count: p.other.length, items: p.other as never[] }] : [],
    })),
  }));
}

function nonSlackDays(title = "PR one"): TimelineDay[] {
  const github: SourceGroup = {
    source: "github", count: 1,
    items: [{ id: GITHUB_ITEM, title, source: "github", kind: "pr", at: "2024-06-20T09:00:00Z" }],
  };
  return [{
    date: "2024-06-20", label: "label 2024-06-20",
    people: [{
      memberId: MEMBER_A, name: "Person a0", handle: "h-a0", avatarUrl: null, total: 1, unlinked: 1,
      tasks: [], other: [github], signals: [], summary: "Opened a pull request.",
    }],
  }];
}

interface AttemptSpec {
  aggregates: Agg[];
  asOfMs?: number;
  nonSlack?: TimelineDay[];
  nonSlackSourceItemIds?: string[];
  names?: Record<string, string>;
  bindingOver?: Json;
}

interface Hooks {
  /** Replace or corrupt a page just before it is returned. `page` is 0 for the first page. */
  tamper?: (page: Json, at: { attempt: number; page: number; tokens: Map<string, Json> }) => Json | Promise<Json>;
  /** Throw (or act) just before a page call resolves. */
  before?: (at: { attempt: number; page: number; call: "start" | "next" }) => void | Promise<void>;
  final?: (input: Json, at: { attempt: number }) => void | Promise<void>;
}

/** A fake page service: `attempts[n]` is the complete corpus the n-th whole attempt sees. */
function world(attempts: AttemptSpec[], pageSize: number, hooks: Hooks = {}) {
  const tokens = new Map<string, Json>();
  const calls = { start: [] as Json[], next: [] as string[], final: [] as Json[], decode: 0 };
  let attempt = -1;

  function pageAt(n: number, offset: number): Json {
    const spec = attempts[n];
    const sorted = [...spec.aggregates].sort(compareAggs);
    const b = binding(spec.asOfMs ?? AS_OF_1, pageSize, spec.bindingOver);
    const slice = sorted.slice(offset, offset + pageSize);
    const more = offset + pageSize < sorted.length;
    let nextSlackCursor: string | null = null;
    if (more) {
      nextSlackCursor = `cursor:${n}:${offset + pageSize}`;
      tokens.set(nextSlackCursor, { ...b, lastAggregateTuple: tupleOf(slice[slice.length - 1]) });
    }
    const slackDays = compose(slice, spec.names);
    return {
      days: offset === 0 ? mergeTimelineSlackContinuation(spec.nonSlack ?? [], slackDays) : slackDays,
      window_days: 7, asOf: b.asOf, binding: b,
      aggregates: slice.map((a) => ({ id: idOf(a), tuple: tupleOf(a) })),
      nextSlackCursor, slackComplete: !more,
      ...(offset === 0 ? { initialNonSlackSourceItemIds: spec.nonSlackSourceItemIds ?? [] } : {}),
    };
  }

  return {
    calls,
    tokens,
    deps: {
      pageSize,
      startPage: async (input: Json) => {
        calls.start.push(input);
        attempt++;
        if (!attempts[attempt]) throw new Error("fake page service: an unexpected extra attempt");
        await hooks.before?.({ attempt, page: 0, call: "start" });
        const page = pageAt(attempt, 0);
        return hooks.tamper ? hooks.tamper(page, { attempt, page: 0, tokens }) : page;
      },
      nextPage: async (cursor: string) => {
        calls.next.push(cursor);
        const match = /^cursor:(\d+):(\d+)$/.exec(cursor);
        if (!match) throw failWith("invalid_request");
        const n = Number(match[1]);
        const offset = Number(match[2]);
        const index = offset / pageSize;
        await hooks.before?.({ attempt: n, page: index, call: "next" });
        const page = pageAt(n, offset);
        return hooks.tamper ? hooks.tamper(page, { attempt: n, page: index, tokens }) : page;
      },
      validateFinal: async (input: Json) => {
        calls.final.push(input);
        await hooks.final?.(input, { attempt });
      },
      decodeCursor: (token: unknown) => {
        calls.decode++;
        const payload = typeof token === "string" ? tokens.get(token) : undefined;
        if (!payload) throw failWith("invalid_request");
        return payload;
      },
    },
  };
}

/** What a complete, normalized drain of one attempt must equal. */
function expected(spec: AttemptSpec): TimelineDay[] {
  const all = compose([...spec.aggregates].sort(compareAggs), spec.names);
  return mergeTimelineSlackContinuation(mergeTimelineSlackContinuation(spec.nonSlack ?? [], all), []);
}

const A1: Agg = { itemId: item(1), memberId: MEMBER_A, at: "2024-06-20T16:13:20.000500Z", tasks: ["T1", "T2"] };
const A2: Agg = { itemId: item(2), memberId: MEMBER_A, at: "2024-06-20T16:13:20.000400Z" };
const A3: Agg = { itemId: item(1), memberId: MEMBER_B, at: "2024-06-20T16:13:20.000300Z" };
const A4: Agg = { itemId: item(3), memberId: MEMBER_A, at: "2024-06-19T10:00:00.000000Z", tasks: ["T1"] };
const A5: Agg = { itemId: item(1), memberId: MEMBER_A, at: "2024-06-18T10:00:00.000000Z" };
const FIVE = [A1, A2, A3, A4, A5];
const EXTRA_1: Agg = { itemId: item(7), memberId: MEMBER_A, at: "2024-06-17T10:00:00.000000Z" };
const EXTRA_2: Agg = { itemId: item(8), memberId: MEMBER_A, at: "2024-06-16T10:00:00.000000Z" };
const stable = (over: Partial<AttemptSpec> = {}): AttemptSpec =>
  ({ aggregates: FIVE, nonSlack: nonSlackDays(), nonSlackSourceItemIds: [GITHUB_ITEM], ...over });

describe("Slack timeline drain — complete exhaustion", () => {
  it("publishes its whole-drain budgets and page-size policy", async () => {
    const d = await drainModule();
    expect(d.SLACK_TIMELINE_DRAIN_BUDGETS).toMatchObject({
      maxPageRequests: 1000, maxOutputBytes: 64 * 1024 * 1024, maxElapsedMs: 120_000,
    });
  });

  it("returns exactly the legacy DTO after verified terminal exhaustion across several pages", async () => {
    const d = await drainModule();
    const w = world([stable()], 2);
    const result = await d.drainSlackTimeline(w.deps);
    expect(Object.keys(result).sort()).toEqual(["days", "window_days"]);
    expect(result.window_days).toBe(7);
    expect(result.days).toEqual(expected(stable()));
    expect(JSON.stringify(result)).not.toMatch(/cursor|binding|slackComplete|asOf|aggregates|initialNonSlack/);
    expect(w.calls.start).toEqual([{ windowDays: 7, pageSize: 2 }]);
    expect(w.calls.next).toEqual(["cursor:0:2", "cursor:0:4"]);
  });

  it("gives identical normalized output and contribution counts for one page and for many (D4)", async () => {
    const d = await drainModule();
    const results = [];
    for (const size of [1, 2, 3, 5, 128]) results.push(await d.drainSlackTimeline(world([stable()], size).deps));
    for (const result of results) expect(result).toEqual(results[0]);
    const personA = results[0].days[0].people.find((p: PersonDay) => p.memberId === MEMBER_A);
    // 2024-06-20, member A: one GitHub row + two UNIQUE Slack IDs (A1 under two tasks, A2 unlinked).
    expect(personA.total).toBe(3);
    expect(personA.tasks.map((t: TaskGroup) => [t.taskId, t.evidenceCount])).toEqual([["T1", 1], ["T2", 1]]);
  });

  it("normalizes a one-page drain whose assembled first page carries association-summed totals", async () => {
    const d = await drainModule();
    const w = world([stable()], 128, {
      tamper: (page) => {
        // What an active `groupTimeline` would have produced: A1 counted once per task association.
        const days = structuredClone(page.days) as TimelineDay[];
        for (const day of days) for (const person of day.people) person.total += 40;
        return { ...page, days };
      },
    });
    const result = await d.drainSlackTimeline(w.deps);
    expect(result.days).toEqual(expected(stable()));
    expect(w.calls.next).toEqual([]);
  });

  it("returns a valid empty terminal result, still normalized and still finally validated", async () => {
    const d = await drainModule();
    const empty = world([{ aggregates: [] }], 2);
    expect(await d.drainSlackTimeline(empty.deps)).toEqual({ window_days: 7, days: [] });
    expect(empty.calls.final).toHaveLength(1);
    const onlyOther = world([{ aggregates: [], nonSlack: nonSlackDays(), nonSlackSourceItemIds: [GITHUB_ITEM] }], 2);
    expect(await d.drainSlackTimeline(onlyOther.deps)).toEqual({
      window_days: 7, days: mergeTimelineSlackContinuation(nonSlackDays(), []),
    });
  });

  it("defaults the page size to 128 and keeps it fixed across every page and both attempts", async () => {
    const d = await drainModule();
    const fallback = world([{ aggregates: [] }], 128);
    await d.drainSlackTimeline({ ...fallback.deps, pageSize: undefined });
    expect(fallback.calls.start).toEqual([{ windowDays: 7, pageSize: 128 }]);

    let overtaken = false;
    const w = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, {
      before: ({ attempt, page }) => {
        if (attempt === 0 && page === 1 && !overtaken) {
          overtaken = true;
          throw failWith("restart_required");
        }
      },
    });
    await d.drainSlackTimeline(w.deps);
    expect(w.calls.start).toEqual([{ windowDays: 7, pageSize: 2 }, { windowDays: 7, pageSize: 2 }]);
  });

  it.each([0, -1, 513, 1.5, Number.NaN, "2", null])("refuses page size %s before requesting anything", async (pageSize) => {
    const d = await drainModule();
    const w = world([stable()], 2);
    expect(await failureOf(() => d.drainSlackTimeline({ ...w.deps, pageSize }))).toMatchObject({
      name: "SlackTimelineError", code: "invalid_request",
    });
    expect(w.calls.start).toEqual([]);
  });

  it.each(["startPage", "nextPage", "validateFinal", "decodeCursor"])(
    "is unavailable without its %s dependency, and requests nothing",
    async (missing) => {
      const d = await drainModule();
      const w = world([stable()], 2);
      expect(await failureOf(() => d.drainSlackTimeline({ ...w.deps, [missing]: undefined }))).toMatchObject({
        name: "SlackTimelineError", code: "unavailable",
      });
      expect(w.calls.start).toEqual([]);
    }
  );

  it("always obtains its own first page and never treats a supplied cached page as complete", async () => {
    const d = await drainModule();
    const cached = world([{ aggregates: [A1], nonSlack: nonSlackDays("Stale cached PR") }], 128);
    const stale = await cached.deps.startPage({ windowDays: 7, pageSize: 128 });
    const w = world([stable()], 2);
    const result = await d.drainSlackTimeline({ ...w.deps, firstPage: stale, initialPage: stale, cachedPage: stale });
    expect(w.calls.start).toHaveLength(1);
    expect(result.days).toEqual(expected(stable()));
    expect(JSON.stringify(result)).not.toContain("Stale cached PR");
  });
});

describe("Slack timeline drain — final validation", () => {
  it("validates once, after terminal exhaustion, with the pinned binding and the first page's backing IDs", async () => {
    const d = await drainModule();
    const order: string[] = [];
    const w = world([stable()], 2, {
      before: ({ page }) => { order.push(`page ${page}`); },
      final: () => { order.push("final"); },
    });
    await d.drainSlackTimeline(w.deps);
    expect(order).toEqual(["page 0", "page 1", "page 2", "final"]);
    expect(w.calls.final).toEqual([{ binding: binding(AS_OF_1, 2), initialNonSlackSourceItemIds: [GITHUB_ITEM] }]);
  });

  it("validates a ONE-page drain as well", async () => {
    const d = await drainModule();
    const w = world([stable()], 128);
    await d.drainSlackTimeline(w.deps);
    expect(w.calls.next).toEqual([]);
    expect(w.calls.final).toEqual([{ binding: binding(AS_OF_1, 128), initialNonSlackSourceItemIds: [GITHUB_ITEM] }]);
  });

  it("restarts the whole attempt when final validation finds revoked non-Slack evidence, and omits it", async () => {
    const d = await drainModule();
    const fresh: AttemptSpec = { aggregates: FIVE, nonSlack: [], nonSlackSourceItemIds: [], asOfMs: AS_OF_2 };
    const w = world([stable(), fresh], 2, {
      final: (_input, { attempt }) => {
        if (attempt === 0) throw failWith("restart_required");
      },
    });
    const result = await d.drainSlackTimeline(w.deps);
    expect(result.days).toEqual(expected(fresh));
    expect(JSON.stringify(result)).not.toContain("PR one");
    expect(JSON.stringify(result)).not.toContain(GITHUB_ITEM);
    expect(w.calls.start).toHaveLength(2);
    expect(w.calls.final).toEqual([
      { binding: binding(AS_OF_1, 2), initialNonSlackSourceItemIds: [GITHUB_ITEM] },
      { binding: binding(AS_OF_2, 2), initialNonSlackSourceItemIds: [] },
    ]);
  });

  it.each(["unavailable", "budget_exhausted", "invalid_request"] as const)(
    "throws %s from final validation without a retry and without a result",
    async (code) => {
      const d = await drainModule();
      const w = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, {
        final: () => { throw failWith(code); },
      });
      const failure = await failureOf(() => d.drainSlackTimeline(w.deps));
      expect(failure).toMatchObject({ name: "SlackTimelineError", code });
      expect(failure).not.toHaveProperty("days");
      expect(w.calls.start).toHaveLength(1);
    }
  );

  it("treats a final validator that throws something else as unavailable, not as a conflict to retry", async () => {
    const d = await drainModule();
    const w = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, {
      final: () => { throw new Error("connection reset"); },
    });
    expect(await failureOf(() => d.drainSlackTimeline(w.deps))).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    expect(w.calls.start).toHaveLength(1);
  });

  it("requires the first page to declare its non-Slack backing IDs", async () => {
    const d = await drainModule();
    for (const value of [undefined, null, "ids", [42], [GITHUB_ITEM, GITHUB_ITEM]]) {
      const w = world([stable()], 2, {
        tamper: (page, { page: index }) => (index === 0 ? { ...page, initialNonSlackSourceItemIds: value } : page),
      });
      expect(await failureOf(() => d.drainSlackTimeline(w.deps))).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
      expect(w.calls.final).toEqual([]);
    }
  });
});

describe("Slack timeline drain — one bounded restart (D2)", () => {
  const second: AttemptSpec = {
    aggregates: [A2, A3, { itemId: item(9), memberId: MEMBER_B, at: "2024-06-21T08:00:00.000000Z" }],
    nonSlack: nonSlackDays("PR two"), nonSlackSourceItemIds: [GITHUB_ITEM], asOfMs: AS_OF_2,
  };

  it("discards an overtaken attempt entirely and returns only the fresh attempt's data", async () => {
    const d = await drainModule();
    const w = world([stable(), second], 2, {
      before: ({ attempt, page }) => {
        if (attempt === 0 && page === 2) throw failWith("restart_required");
      },
    });
    const result = await d.drainSlackTimeline(w.deps);
    expect(result).toEqual({ window_days: 7, days: expected(second) });
    const text = JSON.stringify(result);
    // Nothing from the first attempt: not its Slack groups, not its frozen non-Slack snapshot.
    for (const gone of [idOf(A1), idOf(A4), idOf(A5), "PR one"]) expect(text).not.toContain(gone);
    expect(text).toContain("PR two");
    expect(w.calls.start).toHaveLength(2);
    // The second attempt's cursors are its own; no first-attempt cursor is replayed into it.
    expect(w.calls.next).toEqual(["cursor:0:2", "cursor:0:4", "cursor:1:2"]);
    expect(w.calls.final).toHaveLength(1);
  });

  it("counts an overtaken FIRST page as the one restart, with no nested first-page retry", async () => {
    const d = await drainModule();
    let starts = 0;
    const w = world([stable(), second], 2, {
      before: ({ call }) => {
        if (call === "start" && starts++ === 0) throw failWith("restart_required");
      },
    });
    expect((await d.drainSlackTimeline(w.deps)).days).toEqual(expected(second));
    expect(w.calls.start).toHaveLength(2);
  });

  it("fails on a second overtake, across any combination of restart sources, and never tries a third time", async () => {
    const d = await drainModule();
    const overtakes: Hooks[] = [
      { before: ({ page }) => { if (page === 1) throw failWith("restart_required"); } },
      { before: ({ call }) => { if (call === "start") throw failWith("restart_required"); } },
      { final: () => { throw failWith("restart_required"); } },
      {
        before: ({ attempt, page }) => { if (attempt === 0 && page === 1) throw failWith("restart_required"); },
        final: () => { throw failWith("restart_required"); },
      },
    ];
    for (const hooks of overtakes) {
      const w = world([stable(), second, second], 2, hooks);
      const failure = await failureOf(() => d.drainSlackTimeline(w.deps));
      expect(failure).toMatchObject({ name: "SlackTimelineError", code: "restart_required" });
      expect(failure).not.toHaveProperty("days");
      expect(w.calls.start).toHaveLength(2);
    }
  });

  it("restarts when a continuation's binding differs from the pinned one, and fails if it differs again", async () => {
    const d = await drainModule();
    const moved = (attempts: number[]): Hooks => ({
      tamper: (page, { attempt, page: index }) =>
        attempts.includes(attempt) && index === 1
          ? { ...page, binding: { ...(page.binding as Json), dataGeneration: "2" } }
          : page,
    });
    const once = world([stable(), second], 2, moved([0]));
    expect((await d.drainSlackTimeline(once.deps)).days).toEqual(expected(second));
    const twice = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, moved([0, 1]));
    expect(await failureOf(() => d.drainSlackTimeline(twice.deps))).toMatchObject({ name: "SlackTimelineError", code: "restart_required" });
    expect(twice.calls.final).toEqual([]);
  });

  it.each([
    ["identity generation", { identityGeneration: "9" }],
    ["presentation generation", { presentationGeneration: "9" }],
    ["credit input digest", { creditInputDigest: hex("credit 2") }],
    ["presentation input digest", { presentationInputDigest: hex("presentation 2") }],
    ["admission binding", { admissionBindingDigest: hex("admission 2") }],
    ["source admission binding", { sourceAdmissionBindingDigest: hex("source 2") }],
    ["authorized Slack item fingerprint", { authorizedSlackItemFingerprint: hex("items 2") }],
    ["view", { viewKey: hex("view 2") }],
    ["principal", { principalKey: `member:${MEMBER_B}` }],
    ["asOf", { asOf: ms(AS_OF_1 + 1), issuedAt: ms(AS_OF_1 + 1), since: ms(AS_OF_1 + 1 - 7 * DAY_MS), expiresAt: ms(AS_OF_1 + 1 + TTL_MS) }],
  ])("never merges a TERMINAL page whose %s differs from the pinned binding", async (_label, over) => {
    const d = await drainModule();
    const w = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, {
      // The page stays self-consistent (its asOf follows its binding); only the PINNED binding differs.
      tamper: (page) => (page.slackComplete
        ? { ...page, asOf: (over as Json).asOf ?? page.asOf, binding: { ...(page.binding as Json), ...over } }
        : page),
    });
    const failure = await failureOf(() => d.drainSlackTimeline(w.deps));
    expect(failure).toMatchObject({ name: "SlackTimelineError", code: "restart_required" });
    expect(failure).not.toHaveProperty("days");
    expect(w.calls.final).toEqual([]);
  });

  it("never follows a cursor bound to another snapshot than the page that issued it", async () => {
    const d = await drainModule();
    const w = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, {
      tamper: (page, { attempt, page: index, tokens }) => {
        if (index !== 0) return page;
        const token = `cursor:${attempt}:2`;
        tokens.set(token, { ...(tokens.get(token) as Json), creditInputDigest: hex("another snapshot") });
        return page;
      },
    });
    const failure = await failureOf(() => d.drainSlackTimeline(w.deps));
    expect(failure).toMatchObject({ name: "SlackTimelineError", code: "restart_required" });
    expect(failure).not.toHaveProperty("days");
    expect(w.calls.next).toEqual([]);
    expect(w.calls.final).toEqual([]);
  });

  it("classifies a valid-shape cross-page presentation conflict as a restart, not a raw merger error", async () => {
    const d = await drainModule();
    const renamed = (attempts: number[]): Hooks => ({
      tamper: (page, { attempt, page: index }) => {
        if (!attempts.includes(attempt) || index !== 1) return page;
        const days = structuredClone(page.days) as TimelineDay[];
        for (const day of days) for (const person of day.people) person.name = "Renamed mid-drain";
        return { ...page, days };
      },
    });
    const once = world([stable(), second], 2, renamed([0]));
    expect((await d.drainSlackTimeline(once.deps)).days).toEqual(expected(second));
    const twice = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, renamed([0, 1]));
    const failure = await failureOf(() => d.drainSlackTimeline(twice.deps));
    expect(failure).toMatchObject({ name: "SlackTimelineError", code: "restart_required" });
    expect(String(failure.message)).not.toMatch(/^Conflicting /);
  });

  it.each(["invalid_request", "unavailable", "budget_exhausted"] as const)(
    "does not retry a %s page failure and returns nothing accumulated",
    async (code) => {
      const d = await drainModule();
      for (const failingPage of [0, 1, 2]) {
        const w = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, {
          before: ({ page }) => { if (page === failingPage) throw failWith(code); },
        });
        const failure = await failureOf(() => d.drainSlackTimeline(w.deps));
        expect(failure).toMatchObject({ name: "SlackTimelineError", code });
        expect(failure).not.toHaveProperty("days");
        expect(w.calls.start).toHaveLength(1);
        expect(w.calls.final).toEqual([]);
      }
    }
  );

  it("treats a loader that throws an ordinary error as unavailable, never as a merge conflict to retry", async () => {
    const d = await drainModule();
    const w = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, {
      before: ({ page }) => { if (page === 1) throw new Error("Conflicting timeline person: looks like a merge message"); },
    });
    expect(await failureOf(() => d.drainSlackTimeline(w.deps))).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    expect(w.calls.start).toHaveLength(1);
  });
});

describe("Slack timeline drain — terminal and progress protocol (D3)", () => {
  const lastTuple = (page: Json): Json => ((page.aggregates as Json[]).at(-1) as Json).tuple as Json;

  const VIOLATIONS: [string, Hooks["tamper"]][] = [
    ["complete with a non-null cursor", (page, { page: index, tokens }) => {
      if (index !== 2) return page;
      tokens.set("cursor:extra", { ...(page.binding as Json), lastAggregateTuple: lastTuple(page) });
      return { ...page, nextSlackCursor: "cursor:extra" };
    }],
    ["incomplete with a null cursor", (page, { page: index }) => (index === 0 ? { ...page, nextSlackCursor: null } : page)],
    ["an empty nonterminal page", (page, { page: index }) => (index === 1 ? { ...page, aggregates: [], days: [] } : page)],
    ["a nonterminal page shorter than pageSize", (page, { page: index }) => {
      if (index !== 1) return page;
      const aggregates = (page.aggregates as Json[]).slice(0, 1);
      return { ...page, aggregates, days: compose([A3]) };
    }],
    ["a page longer than pageSize", (page, { page: index }) =>
      (index === 2 ? {
        ...page, aggregates: [A5, EXTRA_1, EXTRA_2].map((a) => ({ id: idOf(a), tuple: tupleOf(a) })), days: compose([A5, EXTRA_1, EXTRA_2]),
      } : page)],
    ["a repeated cursor", (page, { page: index, tokens }) => {
      if (index !== 1) return page;
      // Page 2 hands back the very cursor that requested it.
      tokens.set("cursor:0:2", { ...(tokens.get("cursor:0:2") as Json) });
      return { ...page, nextSlackCursor: "cursor:0:2" };
    }],
    ["a cursor whose tuple is not the last emitted aggregate", (page, { page: index, tokens }) => {
      if (index !== 0) return page;
      tokens.set("cursor:0:2", { ...(tokens.get("cursor:0:2") as Json), lastAggregateTuple: tupleOf(A1) });
      return page;
    }],
    ["a cursor that skips past the last emitted aggregate", (page, { page: index, tokens }) => {
      if (index !== 0) return page;
      tokens.set("cursor:0:2", { ...(tokens.get("cursor:0:2") as Json), lastAggregateTuple: tupleOf(A3) });
      return page;
    }],
    ["a cursor the validator cannot authenticate", (page, { page: index }) => (index === 0 ? { ...page, nextSlackCursor: "forged" } : page)],
    ["a regressing page", (page, { page: index }) => {
      if (index !== 1) return page;
      // The second page re-emits the first page's groups.
      return { ...page, aggregates: [A1, A2].map((a) => ({ id: idOf(a), tuple: tupleOf(a) })), days: compose([A1, A2]) };
    }],
    ["a duplicated network delivery presented as progress", (page, { page: index, tokens }) => {
      if (index !== 2) return page;
      // The third request is answered with the second page again.
      tokens.set("cursor:0:4", { ...(tokens.get("cursor:0:4") as Json) });
      return {
        ...page, aggregates: [A3, A4].map((a) => ({ id: idOf(a), tuple: tupleOf(a) })), days: compose([A3, A4]),
        nextSlackCursor: "cursor:0:4", slackComplete: false,
      };
    }],
    ["aggregates out of tuple order", (page, { page: index }) =>
      (index === 1 ? { ...page, aggregates: [...(page.aggregates as Json[])].reverse() } : page)],
    ["a duplicate aggregate within a page", (page, { page: index }) => {
      if (index !== 1) return page;
      const [one] = page.aggregates as Json[];
      return { ...page, aggregates: [one, one] };
    }],
    ["an aggregate id that is not its tuple", (page, { page: index }) => {
      if (index !== 1) return page;
      const [one, two] = page.aggregates as Json[];
      return { ...page, aggregates: [{ ...one, id: "wrong" }, two] };
    }],
    ["foreign-source evidence in a continuation", (page, { page: index }) => {
      if (index !== 1) return page;
      const days = structuredClone(page.days) as TimelineDay[];
      days[0].people[0].other.push({ source: "github", count: 1, items: [{ id: "g9", title: "PR", source: "github", kind: "pr", at: "2024-06-20T09:00:00Z" }] });
      return { ...page, days };
    }],
    ["a synopsis in a continuation", (page, { page: index }) => {
      if (index !== 1) return page;
      const days = structuredClone(page.days) as TimelineDay[];
      days[0].people[0].summary = "repeated synopsis";
      return { ...page, days };
    }],
    ["continuation days that omit an aggregate", (page, { page: index }) => (index === 1 ? { ...page, days: compose([A3]) } : page)],
    ["continuation days with an undeclared aggregate", (page, { page: index }) => (index === 1 ? { ...page, days: compose([A3, A4, A5]) } : page)],
    ["a window other than seven days", (page, { page: index }) => (index === 0 ? { ...page, window_days: 14 } : page)],
    ["a first page bound to another page size", (page, { page: index }) =>
      (index === 0 ? { ...page, binding: { ...(page.binding as Json), pageSize: 3 } } : page)],
    ["a first page bound to another window", (page, { page: index }) =>
      (index === 0 ? { ...page, window_days: 14, binding: binding(AS_OF_1, 2, { windowDays: 14, since: ms(AS_OF_1 - 14 * DAY_MS) }) } : page)],
    ["an asOf that disagrees with its binding", (page, { page: index }) => (index === 1 ? { ...page, asOf: ms(AS_OF_1 + 1) } : page)],
    ["a page without a binding", (page, { page: index }) => (index === 1 ? { ...page, binding: undefined } : page)],
    ["a page that is not an object", (page, { page: index }) => (index === 1 ? (null as unknown as Json) : page)],
    ["days that are not an array", (page, { page: index }) => (index === 1 ? { ...page, days: "days" } : page)],
    ["a malformed day", (page, { page: index }) => (index === 1 ? { ...page, days: [{ date: "2024-02-30", label: "x", people: [] }] } : page)],
    ["a slackComplete that is not a boolean", (page, { page: index }) => (index === 2 ? { ...page, slackComplete: "true" } : page)],
  ];

  it.each(VIOLATIONS)("throws with no partial result for %s", async (_label, tamper) => {
    const d = await drainModule();
    const w = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, { tamper });
    const failure = await failureOf(() => d.drainSlackTimeline(w.deps));
    expect(failure).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    expect(failure).not.toHaveProperty("days");
    // A protocol violation is not an overtake: it is never retried and never finally validated.
    expect(w.calls.start).toHaveLength(1);
    expect(w.calls.final).toEqual([]);
  });

  it("refuses an A → B → A cursor cycle instead of looping", async () => {
    const d = await drainModule();
    const six = Array.from({ length: 6 }, (_, n): Agg => ({
      itemId: item(n + 1), memberId: MEMBER_A, at: `2024-06-20T16:13:20.00000${9 - n}Z`,
    }));
    const w = world([{ aggregates: six }], 2, {
      tamper: (page, { page: index, tokens }) => {
        if (index !== 2) return page;
        // The third page points back at the first cursor and re-emits the second page's groups.
        const again = [six[2], six[3]];
        tokens.set("cursor:0:2", { ...(page.binding as Json), lastAggregateTuple: tupleOf(six[1]) });
        return {
          ...page, aggregates: again.map((a) => ({ id: idOf(a), tuple: tupleOf(a) })), days: compose(again),
          nextSlackCursor: "cursor:0:2", slackComplete: false,
        };
      },
    });
    expect(await failureOf(() => d.drainSlackTimeline(w.deps))).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    expect(w.calls.next.length).toBeLessThanOrEqual(3);
  });

  it("drains equal-instant ties and one thread spanning many groups exactly once at sizes 1, 2 and 128", async () => {
    const d = await drainModule();
    const members = Array.from({ length: 9 }, (_, n) => `c000000${n}-0000-4000-8000-00000000000c`);
    // One thread: nine members on one day at ONE instant, plus the same thread on three more days,
    // interleaved with two other threads.
    const big: Agg[] = [
      ...members.map((memberId): Agg => ({ itemId: item(1), memberId, at: "2024-06-20T16:13:20.123456Z" })),
      ...["2024-06-19", "2024-06-18", "2024-06-17"].map((date): Agg => ({ itemId: item(1), memberId: members[0], at: `${date}T10:00:00.000000Z` })),
      { itemId: item(2), memberId: members[0], at: "2024-06-20T16:13:20.123456Z" },
      { itemId: item(3), memberId: members[1], at: "2024-06-19T10:00:00.000000Z" },
    ];
    for (const size of [1, 2, 128]) {
      const w = world([{ aggregates: big }], size);
      const result = await d.drainSlackTimeline(w.deps);
      expect(result.days).toEqual(expected({ aggregates: big }));
      const ids: string[] = [];
      for (const day of result.days as TimelineDay[]) for (const p of day.people) for (const g of p.other) for (const row of g.items) ids.push(row.id);
      expect([...ids].sort()).toEqual(big.map(idOf).sort());
      expect(new Set(ids).size).toBe(big.length);
      expect(w.calls.next).toHaveLength(Math.ceil(big.length / size) - 1);
      // More than six same-day groups for one day survive the merge.
      expect((result.days as TimelineDay[])[0].people.length).toBeGreaterThan(6);
    }
  });
});

describe("Slack timeline drain — shared budgets (D1)", () => {
  it("allows exactly the page-request limit and refuses one more, with no partial result", async () => {
    const d = await drainModule();
    // Five aggregates at page size 2 need exactly three page requests.
    const exact = world([stable()], 2);
    expect((await d.drainSlackTimeline({ ...exact.deps, budgets: { maxPageRequests: 3 } })).days).toEqual(expected(stable()));
    const over = world([stable()], 2);
    const failure = await failureOf(() => d.drainSlackTimeline({ ...over.deps, budgets: { maxPageRequests: 2 } }));
    expect(failure).toMatchObject({ name: "SlackTimelineError", code: "budget_exhausted" });
    expect(failure).not.toHaveProperty("days");
    expect(over.calls.start.length + over.calls.next.length).toBeLessThanOrEqual(2);
    expect(over.calls.final).toEqual([]);
  });

  it("does not reset the page-request budget on restart", async () => {
    const d = await drainModule();
    const overtakeAtThird: Hooks = {
      before: ({ attempt, page }) => { if (attempt === 0 && page === 2) throw failWith("restart_required"); },
    };
    // Attempt one spends three requests, attempt two needs three more: six in total.
    const exact = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, overtakeAtThird);
    expect((await d.drainSlackTimeline({ ...exact.deps, budgets: { maxPageRequests: 6 } })).days).toEqual(expected(stable()));
    const short = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, overtakeAtThird);
    expect(await failureOf(() => d.drainSlackTimeline({ ...short.deps, budgets: { maxPageRequests: 5 } }))).toMatchObject({
      name: "SlackTimelineError", code: "budget_exhausted",
    });
    expect(short.calls.start.length + short.calls.next.length).toBeLessThanOrEqual(5);
  });

  it("measures elapsed time on the injected monotonic clock: the exact limit passes, one more fails", async () => {
    const d = await drainModule();
    for (const [step, ok] of [[40_000, true], [40_001, false]] as const) {
      let clock = 1_000_000;
      const w = world([stable()], 2, { before: () => { clock += step; } });
      const run = () => d.drainSlackTimeline({ ...w.deps, monotonicNow: () => clock });
      if (ok) expect((await run()).days).toEqual(expected(stable()));
      else {
        const failure = await failureOf(run);
        expect(failure).toMatchObject({ name: "SlackTimelineError", code: "budget_exhausted" });
        expect(failure).not.toHaveProperty("days");
      }
    }
  });

  it("holds final validation to the remaining shared deadline", async () => {
    const d = await drainModule();
    let clock = 0;
    const w = world([stable()], 128, { final: () => { clock += 120_001; } });
    expect(await failureOf(() => d.drainSlackTimeline({ ...w.deps, monotonicNow: () => clock }))).toMatchObject({
      name: "SlackTimelineError", code: "budget_exhausted",
    });
  });

  it("does not reset the elapsed budget on restart, and is independent of the wall clock", async () => {
    const d = await drainModule();
    let clock = 0;
    const w = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, {
      before: ({ attempt, page }) => {
        clock += 30_000;
        if (attempt === 0 && page === 2) throw failWith("restart_required");
      },
    });
    // Three 30-second requests, a restart, then three more: 180 seconds against a 120-second budget.
    expect(await failureOf(() => d.drainSlackTimeline({ ...w.deps, monotonicNow: () => clock }))).toMatchObject({
      name: "SlackTimelineError", code: "budget_exhausted",
    });
    expect(w.calls.final).toEqual([]);
  });

  it("refuses accumulated output past the byte budget and allows exactly the budget", async () => {
    const d = await drainModule();
    // The measured quantity is pinned: UTF-8 bytes of the JSON of the normalized accumulated days.
    const bytes = Buffer.byteLength(JSON.stringify(expected(stable())), "utf8");
    const exact = world([stable()], 2);
    expect((await d.drainSlackTimeline({ ...exact.deps, budgets: { maxOutputBytes: bytes } })).days).toEqual(expected(stable()));
    const over = world([stable()], 2);
    const failure = await failureOf(() => d.drainSlackTimeline({ ...over.deps, budgets: { maxOutputBytes: bytes - 1 } }));
    expect(failure).toMatchObject({ name: "SlackTimelineError", code: "budget_exhausted" });
    expect(failure).not.toHaveProperty("days");
    expect(over.calls.final).toEqual([]);
  });

  it.each([
    ["a zero page budget", { maxPageRequests: 0 }],
    ["a negative byte budget", { maxOutputBytes: -1 }],
    ["a fractional time budget", { maxElapsedMs: 1.5 }],
    ["an infinite page budget", { maxPageRequests: Number.POSITIVE_INFINITY }],
    ["a non-numeric budget", { maxElapsedMs: "120000" }],
  ])("refuses %s as unavailable configuration before requesting anything", async (_label, budgets) => {
    const d = await drainModule();
    const w = world([stable()], 2);
    expect(await failureOf(() => d.drainSlackTimeline({ ...w.deps, budgets }))).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    expect(w.calls.start).toEqual([]);
  });
});
