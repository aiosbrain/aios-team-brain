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
        // The second page shares the day 2024-06-20 with the first but no (day, person) pair, and the
        // shared merger compares a person only within one day — so a rename alone conflicts with
        // nothing here. The day's LABEL is shared presentation the merger does compare: relabelling
        // it mid-drain is the valid-shape cross-page conflict this case is about.
        for (const day of days) {
          day.label = "Relabelled mid-drain";
          for (const person of day.people) person.name = "Renamed mid-drain";
        }
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

  it("reports a monotonic clock that throws as unavailable, on its first reading and on any later one", async () => {
    const d = await drainModule();
    // The first reading is taken before anything is requested: a raw error must not escape it.
    const broken = world([stable()], 2);
    const atStart = await failureOf(() => d.drainSlackTimeline({ ...broken.deps, monotonicNow: () => { throw new Error("clock device failed"); } }));
    expect(atStart).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    expect(String(atStart.message)).not.toContain("clock device failed");
    expect(broken.calls.start).toEqual([]);

    // Learn how many readings a clean drain takes, then fail every one of them in turn.
    let readings = 0;
    const clean = world([stable()], 2);
    await d.drainSlackTimeline({ ...clean.deps, monotonicNow: () => { readings++; return 0; } });
    expect(readings).toBeGreaterThan(2);
    for (let failAt = 2; failAt <= readings; failAt++) {
      let n = 0;
      const w = world([stable(), stable({ asOfMs: AS_OF_2 })], 2);
      const failure = await failureOf(() => d.drainSlackTimeline({
        ...w.deps, monotonicNow: () => { if (++n === failAt) throw new Error("clock device failed"); return 0; },
      }));
      expect(failure, `reading ${failAt}`).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
      expect(failure).not.toHaveProperty("days");
      // A failed clock is not an overtake: no second attempt is started on it.
      expect(w.calls.start.length).toBeLessThanOrEqual(1);
    }
    // A clock that misreports is the same failed dependency.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "0", null]) {
      const w = world([stable()], 2);
      expect(await failureOf(() => d.drainSlackTimeline({ ...w.deps, monotonicNow: () => value }))).toMatchObject({
        name: "SlackTimelineError", code: "unavailable",
      });
      expect(w.calls.start).toEqual([]);
    }
  });
});

/**
 * Red review, finding 5. The elapsed tests above advance a clock inside callbacks that then RETURN,
 * so they prove a check made afterwards. A drain must also end a page request or a final validation
 * that never returns at all:
 *
 *  - `startPage(input, { signal })`, `nextPage(cursor, { signal })` and `validateFinal(input, { signal })`
 *    each receive an AbortSignal as a SECOND argument (the first arguments are unchanged).
 *  - While a call is pending the drain holds a deadline through the injectable
 *    `scheduleDeadline(callback, delayMs) => cancel` (default: the platform timer), never longer than
 *    the remaining shared elapsed budget. When it fires, the drain aborts that signal and rejects
 *    `budget_exhausted` at once — it does not wait for the abandoned call, does not restart, does not
 *    validate, and returns nothing accumulated.
 *
 * Deterministic and bounded: timers are fakes fired by hand, pending work is a promise the test
 * holds, and "still pending" is observed over a fixed number of event-loop turns. Nothing sleeps.
 */
describe("Slack timeline drain — pending work and the shared deadline", () => {
  interface FakeTimer { fire: () => void; delayMs: number; cancelled: boolean; fired: boolean }
  type Call = "start" | "next" | "final";
  type Settled = { state: "pending" } | { state: "fulfilled"; value: unknown } | { state: "rejected"; error: Json };

  /** A promise's state after a bounded number of event-loop turns. No timer, no sleep. */
  async function settled(promise: Promise<unknown>, turns = 25): Promise<Settled> {
    let outcome: Settled = { state: "pending" };
    promise.then(
      (value) => { outcome = { state: "fulfilled", value }; },
      (error) => { outcome = { state: "rejected", error: error as Json }; }
    );
    for (let n = 0; n < turns && outcome.state === "pending"; n++) await new Promise<void>((resolve) => setImmediate(resolve));
    return outcome;
  }

  /**
   * The fake page service with a controllable clock and timers. Every page request costs ten seconds
   * of monotonic time; the call named `hang` (its `hangOn`-th occurrence) never settles.
   */
  function harness(hang: Call | null, hangOn = 1, attempts: AttemptSpec[] = [stable(), stable({ asOfMs: AS_OF_2 })]) {
    const clock = { now: 50_000 };
    const w = world(attempts, 2, { before: () => { clock.now += 10_000; } });
    const timers: FakeTimer[] = [];
    const signals: { call: Call; signal: unknown }[] = [];
    const count: Record<Call, number> = { start: 0, next: 0, final: 0 };
    let finishLate = (): void => undefined;
    let pendingSignal: AbortSignal | undefined;
    const real: Record<Call, (input: never) => Promise<unknown>> = {
      start: w.deps.startPage as never, next: w.deps.nextPage as never, final: w.deps.validateFinal as never,
    };
    const wrap = (call: Call) => (input: unknown, context?: { signal?: AbortSignal }): Promise<unknown> => {
      count[call]++;
      signals.push({ call, signal: context?.signal });
      if (call === hang && count[call] === hangOn) {
        pendingSignal = context?.signal;
        const work = new Promise<never>((_resolve, reject) => { finishLate = () => reject(new Error("abandoned work finished late")); });
        work.catch(() => undefined); // the test owns this promise; the drain must not need it to settle
        return work;
      }
      return real[call](input as never);
    };
    return {
      w, clock, timers, signals, count,
      pendingSignal: () => pendingSignal,
      finishLate: () => finishLate(),
      fireAll: () => {
        for (let round = 0; round < 8; round++) {
          const armed = timers.filter((t) => !t.cancelled && !t.fired);
          if (armed.length === 0) return;
          for (const t of armed) { t.fired = true; t.fire(); }
        }
      },
      deps: {
        ...w.deps,
        startPage: wrap("start"), nextPage: wrap("next"), validateFinal: wrap("final"),
        monotonicNow: () => clock.now,
        scheduleDeadline: (callback: () => void, delayMs: number) => {
          const timer: FakeTimer = { fire: callback, delayMs, cancelled: false, fired: false };
          timers.push(timer);
          return () => { timer.cancelled = true; };
        },
      },
    };
  }

  it.each([
    ["the first page request", "start", 1, 0],
    ["a continuation request", "next", 1, 10_000],
    ["a later continuation request", "next", 2, 20_000],
    ["final validation", "final", 1, 30_000],
  ] as const)("ends a drain whose %s never settles: abort, budget_exhausted, nothing accumulated", async (_label, call, hangOn, spent) => {
    const d = await drainModule();
    const h = harness(call, hangOn);
    const run: Promise<unknown> = d.drainSlackTimeline(h.deps);
    run.catch(() => undefined);

    // Before the deadline: the drain is simply waiting. Nothing times out early.
    expect((await settled(run)).state, "the drain waits while its budget lasts").toBe("pending");
    expect(h.count[call], "the hanging call was reached").toBe(hangOn);
    const signal = h.pendingSignal();
    expect(signal, "the pending call was handed an AbortSignal").toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    // The pending call is guarded by a live deadline no longer than what is left of 120 seconds.
    const armed = h.timers.filter((t) => !t.cancelled && !t.fired);
    expect(armed.length, "a deadline is armed while the call is pending").toBeGreaterThan(0);
    for (const t of h.timers) expect(Number.isFinite(t.delayMs) && t.delayMs > 0, "a deadline is a positive finite delay").toBe(true);
    for (const t of armed) expect(t.delayMs).toBeLessThanOrEqual(120_000 - spent);

    // The shared budget runs out and the deadline fires. The call is STILL pending.
    h.clock.now += 120_001;
    h.fireAll();
    const after = await settled(run);
    expect(after.state, "the drain rejects without waiting for the abandoned call").toBe("rejected");
    const failure = (after as { error: Json }).error;
    expect(failure).toMatchObject({ name: "SlackTimelineError", code: "budget_exhausted" });
    for (const partial of ["days", "window_days", "binding", "aggregates"]) expect(failure).not.toHaveProperty(partial);
    expect(signal?.aborted, "the abandoned call was told to stop").toBe(true);

    // A timeout is not an overtake: no restart, no further page, no final validation after the fact.
    const frozen = { ...h.count };
    expect(frozen.start).toBe(1);
    if (call !== "final") expect(frozen.final).toBe(0);
    expect(h.timers.filter((t) => !t.cancelled && !t.fired), "no deadline is left armed").toEqual([]);

    // The abandoned call settling late changes nothing: no late result, no late request.
    h.finishLate();
    expect((await settled(run)).state).toBe("rejected");
    expect(h.count).toEqual(frozen);
  });

  it("does not grant a restarted attempt a fresh deadline: the second attempt's pending page ends on the shared budget", async () => {
    const d = await drainModule();
    // Attempt one: two completed requests (20 s), overtaken on the third. Attempt two hangs on its first page.
    const h = harness("start", 2);
    const overtaken = h.deps.nextPage;
    let nexts = 0;
    h.deps.nextPage = (input: unknown, context?: { signal?: AbortSignal }) => {
      if (++nexts === 2) return Promise.reject(failWith("restart_required"));
      return overtaken(input, context);
    };
    const run: Promise<unknown> = d.drainSlackTimeline(h.deps);
    run.catch(() => undefined);
    expect((await settled(run)).state).toBe("pending");
    expect(h.count.start).toBe(2);
    // Two page requests cost twenty seconds before the overtake: at most a hundred remain.
    for (const t of h.timers.filter((timer) => !timer.cancelled && !timer.fired)) expect(t.delayMs).toBeLessThanOrEqual(100_000);
    h.clock.now += 100_001;
    h.fireAll();
    const after = await settled(run);
    expect(after.state).toBe("rejected");
    expect((after as { error: Json }).error).toMatchObject({ name: "SlackTimelineError", code: "budget_exhausted" });
    expect(h.pendingSignal()?.aborted).toBe(true);
    expect(h.count.final).toBe(0);
  });

  it("cancels every deadline and aborts nothing on a drain that completes", async () => {
    const d = await drainModule();
    const h = harness(null);
    const result = await d.drainSlackTimeline(h.deps);
    expect(result).toEqual({ window_days: 7, days: expected(stable()) });
    // Three page requests and one final validation, each with its own live signal.
    expect(h.signals.map((entry) => entry.call)).toEqual(["start", "next", "next", "final"]);
    for (const entry of h.signals) {
      expect(entry.signal, `${entry.call} was handed an AbortSignal`).toBeInstanceOf(AbortSignal);
      expect((entry.signal as AbortSignal).aborted).toBe(false);
    }
    expect(h.timers.length, "the drain armed a deadline").toBeGreaterThan(0);
    expect(h.timers.filter((t) => !t.cancelled), "every deadline was cancelled").toEqual([]);
    // The first arguments are exactly what they were: the signal is a second argument, not a new field.
    expect(h.w.calls.start).toEqual([{ windowDays: 7, pageSize: 2 }]);
    expect(h.w.calls.next).toEqual(["cursor:0:2", "cursor:0:4"]);
    expect(h.w.calls.final).toEqual([{ binding: binding(AS_OF_1, 2), initialNonSlackSourceItemIds: [GITHUB_ITEM] }]);
    // A deadline that fires after the result was returned is inert.
    for (const t of h.timers) t.fire();
    expect(h.signals.every((entry) => !(entry.signal as AbortSignal).aborted)).toBe(true);
  });

  it("leaves no deadline armed when a page fails outright", async () => {
    const d = await drainModule();
    // Nothing is pending here: the first continuation simply rejects. No timer may outlive the drain.
    const h = harness(null);
    h.deps.nextPage = () => Promise.reject(failWith("unavailable"));
    expect(await failureOf(() => d.drainSlackTimeline(h.deps))).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    expect(h.timers.length, "the drain armed a deadline").toBeGreaterThan(0);
    expect(h.timers.filter((t) => !t.cancelled && !t.fired), "no deadline outlives the failed drain").toEqual([]);
  });

  it.each([
    ["a non-function", 42],
    ["a scheduler that returns no cancel function", () => undefined],
  ])("refuses %s as its deadline scheduler: unavailable, and nothing is left pending", async (_label, scheduleDeadline) => {
    const d = await drainModule();
    const w = world([stable()], 2);
    const failure = await failureOf(() => d.drainSlackTimeline({ ...w.deps, scheduleDeadline }));
    expect(failure).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    expect(failure).not.toHaveProperty("days");
    expect(w.calls.final).toEqual([]);
  });
});

/**
 * Stage 4 review. Two things the cases above did not pin.
 *
 *  - THE TIMER BOUND. A platform timer honours a delay of at most 2 147 483 647 ms; given one
 *    millisecond more, Node warns and fires after a single millisecond. An elapsed budget above that
 *    bound is therefore not "a very long budget" but an immediate deadline, and it is configuration
 *    the drain must refuse before it requests anything or arms anything.
 *
 *  - ACCEPTED PAGES THAT CHANGE AFTERWARDS. The drain accepts a page, then awaits the next page and
 *    final validation. A page service that keeps the graph it returned — a cache does — can change
 *    that graph during those awaits. What the drain publishes must be the pages it ACCEPTED: it
 *    either holds its own copy or refuses, and its result never changes under the caller either.
 *
 * Each case says whether CURRENT production is expected to fail it (a falsifier) or to pass it already
 * (a control, kept so a later change cannot quietly lose the behaviour).
 */
describe("Slack timeline drain — the timer bound, and accepted pages that change afterwards (Stage 4 review)", () => {
  const TIMER_MAX_MS = 2_147_483_647;

  /** A scheduler that never fires and records every delay it was asked for. */
  function recordingScheduler(): { timers: { delayMs: number; cancelled: boolean }[]; scheduleDeadline: (callback: () => void, delayMs: number) => () => void } {
    const timers: { delayMs: number; cancelled: boolean }[] = [];
    return {
      timers,
      scheduleDeadline: (_callback, delayMs) => {
        const timer = { delayMs, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
    };
  }

  // CONTROL — expected to pass on current production.
  it("accepts an elapsed budget of exactly the signed 32-bit timer maximum, and never asks for a longer delay (control)", async () => {
    const d = await drainModule();
    const w = world([stable()], 2);
    const clock = recordingScheduler();
    const result = await d.drainSlackTimeline({
      ...w.deps, budgets: { maxElapsedMs: TIMER_MAX_MS }, monotonicNow: () => 0, scheduleDeadline: clock.scheduleDeadline,
    });
    expect(result.days).toEqual(expected(stable()));
    expect(clock.timers.length, "the drain armed a deadline").toBeGreaterThan(0);
    for (const timer of clock.timers) {
      expect(Number.isSafeInteger(timer.delayMs) && timer.delayMs >= 1, "a deadline is a positive whole delay").toBe(true);
      expect(timer.delayMs, "a delay the platform timer honours").toBeLessThanOrEqual(TIMER_MAX_MS);
      expect(timer.cancelled).toBe(true);
    }
  });

  // FALSIFIER — current production accepts the budget and arms a timer with it.
  it.each([
    ["one millisecond above the timer maximum", TIMER_MAX_MS + 1],
    ["2^32 milliseconds", 2 ** 32],
    ["the largest safe integer", Number.MAX_SAFE_INTEGER],
  ])("refuses an elapsed budget of %s as unavailable configuration, before any request and before any timer", async (_label, maxElapsedMs) => {
    const d = await drainModule();
    const w = world([stable()], 2);
    const clock = recordingScheduler();
    const failure = await failureOf(() => d.drainSlackTimeline({
      ...w.deps, budgets: { maxElapsedMs }, monotonicNow: () => 0, scheduleDeadline: clock.scheduleDeadline,
    }));
    expect(failure).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    expect(failure).not.toHaveProperty("days");
    expect(w.calls.start, "nothing was requested").toEqual([]);
    expect(w.calls.final).toEqual([]);
    expect(clock.timers, "no deadline was armed with a delay the platform cannot honour").toHaveLength(0);
  });

  // FALSIFIER (source review, LOW) — the cap above bounds the BUDGET, not the delay derived from it.
  // A monotonic clock that reads 0 and then steps back to -5 makes the remaining time five
  // milliseconds MORE than the budget; at the maximum legal budget current production asks the
  // scheduler for 2 147 483 652 ms, which a platform timer fires after one. The drain itself is
  // healthy, so it must still complete — with every delay it asks for one a timer can hold.
  it("never asks for a delay above the timer maximum when the monotonic clock steps back under the maximum legal budget, and still completes", async () => {
    const d = await drainModule();
    const w = world([stable()], 2);
    const clock = recordingScheduler();
    let readings = 0;
    const result = await d.drainSlackTimeline({
      ...w.deps, budgets: { maxElapsedMs: TIMER_MAX_MS }, scheduleDeadline: clock.scheduleDeadline,
      monotonicNow: () => (readings++ === 0 ? 0 : -5),
    });
    expect(readings, "the clock was read again after its first reading, and had stepped back").toBeGreaterThan(1);
    // Ordinary completion is unchanged: three pages, one final validation, the whole result.
    expect(result).toEqual({ window_days: 7, days: expected(stable()) });
    expect(w.calls.next).toEqual(["cursor:0:2", "cursor:0:4"]);
    expect(w.calls.final).toHaveLength(1);
    // One deadline per page request and one for final validation, each within the platform's range.
    expect(clock.timers.length, "the drain armed a deadline for each call").toBeGreaterThanOrEqual(4);
    for (const timer of clock.timers) {
      expect(Number.isSafeInteger(timer.delayMs) && timer.delayMs >= 1, "a deadline is a positive whole delay").toBe(true);
      expect(timer.delayMs, "a delay the platform timer honours").toBeLessThanOrEqual(TIMER_MAX_MS);
      expect(timer.cancelled).toBe(true);
    }
  });

  function deepFreeze<T>(value: T): T {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  }

  /**
   * A page service that RETAINS every page it returns and can rewrite them later. Every write is
   * attempted on its own: a drain that froze a page in place has made it immutable too, and the
   * rewrite is then simply refused by the runtime — which is equally an accepted answer.
   */
  function retainingService() {
    const returned: Json[] = [];
    let rewrites = 0;
    const poke = (change: () => void): void => {
      try {
        change();
      } catch {
        // frozen in place: it cannot change under the drain either
      }
    };
    return {
      returned,
      rewrites: () => rewrites,
      retain: (page: Json): Json => { returned.push(page); return page; },
      rewrite: (): void => {
        if (returned.length === 0) return;
        rewrites++;
        for (const page of returned) {
          for (const day of page.days as TimelineDay[]) {
            for (const person of day.people) {
              for (const group of [...person.tasks.flatMap((task) => task.sources), ...person.other]) {
                // The rows are the objects the shared merger keeps by reference: Slack and non-Slack alike.
                for (const row of group.items) poke(() => { row.title = "MUTATED after the drain accepted this page"; });
                poke(() => { group.items.push({ id: "late-row", title: "MUTATED added row", source: group.source, kind: "pr", at: "2024-06-20T09:00:00Z" } as never); });
              }
              poke(() => { person.name = "MUTATED person"; });
            }
            poke(() => { day.label = "MUTATED label"; });
          }
          poke(() => { (page.binding as Json).dataGeneration = "999"; });
          poke(() => { (page.initialNonSlackSourceItemIds as string[] | undefined)?.push(item(99)); });
          poke(() => { (page.aggregates as Json[]).length = 0; });
        }
      },
    };
  }

  // FALSIFIER — current production publishes the rewritten rows: the accumulated days share row
  // objects with the pages they were merged from. (Its pinned binding and backing IDs are copies
  // already; those assertions are expected to hold today.)
  it.each([
    ["while a later page is being requested", "page"],
    ["during final validation", "final"],
  ] as const)("publishes the pages it ACCEPTED when the page service rewrites them %s", async (_label, when) => {
    const d = await drainModule();
    const service = retainingService();
    const w = world([stable(), stable({ asOfMs: AS_OF_2 })], 2, {
      // The drain is handed the very objects the service keeps.
      tamper: (page) => service.retain(page),
      before: () => { if (when === "page") service.rewrite(); },
      final: () => { if (when === "final") service.rewrite(); },
    });
    let result: Loose | null = null;
    let failure: Json | null = null;
    try {
      result = await d.drainSlackTimeline(w.deps);
    } catch (error) {
      const e = error as Json;
      failure = { ...e, name: String(e?.name), code: String(e?.code) };
    }
    expect(service.rewrites(), "the service rewrote pages it had already returned, while the drain was still running").toBeGreaterThan(0);

    if (result === null) {
      // Refusing a page graph that will not hold still is an accepted answer; a raw error is not.
      expect(failure).toMatchObject({ name: "SlackTimelineError" });
      expect(["restart_required", "unavailable"]).toContain(failure?.code);
      expect(failure).not.toHaveProperty("days");
      return;
    }
    // Otherwise the answer is exactly the accepted snapshot: nothing rewritten, nothing added.
    expect(JSON.stringify(result)).not.toContain("MUTATED");
    expect(JSON.stringify(result)).not.toContain("late-row");
    expect(result).toEqual({ window_days: 7, days: expected(stable()) });
    // Final validation was asked about the binding and backing IDs that were PINNED, not rewritten ones.
    expect(w.calls.final).toEqual([{ binding: binding(AS_OF_1, 2), initialNonSlackSourceItemIds: [GITHUB_ITEM] }]);

    // And the published result is the caller's: a later rewrite of the service's pages cannot reach it.
    const published = JSON.stringify(result);
    service.rewrite();
    expect(JSON.stringify(result)).toBe(published);
  });

  // CONTROL — expected to pass on current production. The real reader publishes deeply frozen pages
  // (the data-mechanics suite pins that); whatever the drain does to hold its own copy, it may not
  // need to write into a page it was handed.
  it("drains deeply frozen pages to the same result, writing into none of them (control)", async () => {
    const d = await drainModule();
    for (const size of [1, 2, 128]) {
      const pages: Json[] = [];
      const w = world([stable()], size, { tamper: (page) => { pages.push(deepFreeze(page)); return page; } });
      const result = await d.drainSlackTimeline(w.deps);
      expect(result.days).toEqual(expected(stable()));
      expect(pages).toHaveLength(Math.ceil(FIVE.length / size));
      // The first page's backing IDs and binding reached final validation intact.
      expect(w.calls.final).toEqual([{ binding: binding(AS_OF_1, size), initialNonSlackSourceItemIds: [GITHUB_ITEM] }]);
    }
  });
});
