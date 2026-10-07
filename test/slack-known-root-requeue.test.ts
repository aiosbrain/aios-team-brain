import { afterEach, describe, expect, it, vi } from "vitest";

import { TransactionExecutionError } from "@/lib/db/pg/tx";
import type { SqlExecutor, TransactionSession } from "@/lib/db/types";
import {
  SLACK_KNOWN_ROOT_LIMITS,
  SlackKnownRootDeadlineError,
  SlackKnownRootValidationError,
  createSlackKnownRootExecution,
  readSlackKnownRootItemPage,
  type SlackKnownRootEntry,
  type SlackKnownRootLocatedEntry,
  type SlackKnownRootPageRequest,
} from "@/lib/ingest/slack-known-root-page";
import {
  SLACK_KNOWN_ROOT_FAILURE_CATEGORIES,
  SLACK_KNOWN_ROOT_REFUSED_REASONS,
  SLACK_KNOWN_ROOT_UNATTESTED_REASONS,
  classifySlackKnownRootPreparationFailure,
  prepareSlackKnownRootRequeue,
  tallySlackKnownRootPage,
  type SlackKnownRootPageTally,
  type SlackKnownRootPreparationResult,
  type SlackKnownRootReceipt,
} from "@/lib/ingest/slack-known-root-requeue";

/**
 * The decorated session is handed only to the packet's own dependencies, so the one way to hold it is
 * to stand where a dependency stands. This wraps the REAL namespace-gate module: with no hook set —
 * which is every case but the lifecycle ones that set it — the real `lockReadySlackNamespaceGate`
 * runs, unchanged.
 */
const gateSeat = vi.hoisted(() => ({
  current: null as null | ((session: unknown, request: unknown) => unknown),
}));
vi.mock("@/lib/ingest/slack-namespace-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/slack-namespace-gate")>();
  return {
    ...actual,
    lockReadySlackNamespaceGate: (session: never, request: never) =>
      gateSeat.current ? gateSeat.current(session, request) : actual.lockReadySlackNamespaceGate(session, request),
  };
});
afterEach(() => {
  gateSeat.current = null;
});

/**
 * AIO-1170 AC-02 — the inactive known-root requeue packet, product contracts that need no database
 * (`docs/design/slack-known-root-requeue-spec.md` §4.1, §6, §8; KR-10 and KR-16 in part).
 *
 * FIRST RED CHECKPOINT. Both modules exist as typed stubs that return fixed placeholders, so every
 * case here compiles and runs; a failing case fails on BEHAVIOUR. Each case is written from the
 * specification, and none computes its expectation with a test-owned copy of the reducer or
 * classifier. Cases marked "(control)" are expected to pass against the stubs as well, and say why.
 */

const TEAM = "1a1b1c1d-1111-4111-8111-1111abcdef11";
const OTHER_TEAM = "2a2b2c2d-2222-4222-8222-2222abcdef22";
const ITEM = "0a000000-0000-4000-8000-00000000000a";
const INTEGRATION = "0b000000-0000-4000-8000-00000000000b";
const REVISION = "c".repeat(64);
const REVISIT_MS = 3_600_000;

/** Unique synthetic canaries. None may appear in anything this packet reports. */
const CANARY = {
  metadata: "CANARY-METADATA-7f3a91",
  token: "xoxb-CANARY-TOKEN-5d2c44",
  fingerprint: "CANARY-FINGERPRINT-9e8b17",
  ciphertext: "CANARY-CIPHERTEXT-1c6f02",
  sql: "select 'CANARY-SQL-4a7d39' from integrations",
} as const;
const CANARIES = Object.values(CANARY);

function expectNoCanary(value: unknown, label: string): void {
  const texts: string[] = [];
  const seen = new Set<unknown>();
  const collect = (current: unknown, depth: number): void => {
    if (typeof current === "string") return void texts.push(current);
    if (typeof current !== "object" || current === null || seen.has(current) || depth > 6) return;
    seen.add(current);
    if (current instanceof Error) texts.push(current.name, current.message, String(current.stack ?? ""));
    for (const key of Reflect.ownKeys(current)) {
      texts.push(String(key));
      try {
        collect((current as Record<PropertyKey, unknown>)[key], depth + 1);
      } catch {
        // a throwing accessor exposes nothing
      }
    }
    if (current instanceof Error && "cause" in current) collect((current as { cause?: unknown }).cause, depth + 1);
  };
  collect(value, 0);
  const text = texts.join("\n");
  for (const canary of CANARIES) expect(text.includes(canary), `${label}: ${canary.slice(0, 16)}… is absent`).toBe(false);
}

/** A session whose every use is recorded. A call that should not happen is visible, not fatal. */
function recordingSession(): { session: TransactionSession; statements: string[]; other: string[] } {
  const statements: string[] = [];
  const other: string[] = [];
  const executeSql = (async (text: string) => {
    statements.push(text);
    return { rows: [], rowCount: 0 };
  }) as SqlExecutor;
  const session = {
    get db(): never {
      other.push("db");
      throw new Error("fixture: the session's db client was used");
    },
    executeSql,
    optionalAudit: async <T>(_operation: () => Promise<T>, fallback: T): Promise<T> => {
      other.push("optionalAudit");
      return fallback;
    },
  } as unknown as TransactionSession;
  return { session, statements, other };
}

const execution = () => createSlackKnownRootExecution({ ambientDeadlineAt: null });

function located(over: Partial<SlackKnownRootLocatedEntry> = {}): SlackKnownRootLocatedEntry {
  return {
    teamId: TEAM,
    itemId: ITEM,
    revisitAfterMs: REVISIT_MS,
    locator: {
      workspaceId: "T0SOURCE1",
      channelId: "C0KNOWN1",
      rootTs: "1718900000.000100",
      integrationId: INTEGRATION,
      bindingConfigRevision: REVISION,
      namespaceRevision: 3,
    },
    ...over,
  };
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The one sentence a caller-contract failure may say. Stated here, not imported: a changed message must fail. */
const STATIC_VALIDATION_MESSAGE = "slack known-root: invalid request";
const STATIC_DEADLINE_MESSAGE = "slack known-root: operation deadline exceeded";

/**
 * A static validation error: the packet's own class, with EXACTLY the static message — the same
 * bytes whatever was rejected — so nothing it was given can be quoted, formatted in or appended.
 */
function expectStaticValidationError(error: unknown, label: string): void {
  expect(error, `${label}: a validation error was thrown`).toBeInstanceOf(SlackKnownRootValidationError);
  expect((error as Error).message, `${label}: the message is the static sentence, exactly`).toBe(STATIC_VALIDATION_MESSAGE);
  expect((error as Error).name, label).toBe("SlackKnownRootValidationError");
  expect("cause" in (error as object) && (error as { cause?: unknown }).cause !== undefined, `${label}: no cause travels with it`).toBe(false);
  expectNoCanary(error, label);
}

// ── §4.1: preparation composes from the team and one enumerated entry ─────────

describe("known-root preparation — composed from teamId plus one enumerated entry", () => {
  it.each(["not_slack", "invalid_metadata", "missing_channel_binding", "missing_namespace_pin"] as const)(
    "reports an entry enumeration could not locate (%s) as unattested with that reason, and touches nothing",
    async (category) => {
      const { session, statements, other } = recordingSession();
      const entry: SlackKnownRootEntry = { teamId: TEAM, itemId: ITEM, revisitAfterMs: REVISIT_MS, unlocated: category };
      // The caller supplies the team and the entry. Nothing else exists to supply.
      const result = await prepareSlackKnownRootRequeue(session, { teamId: TEAM, entry }, execution());
      expect(result).toEqual({ outcome: "unattested", reason: category });
      // Unresolved coverage for this observation: no lock, no read, no write, no setting changed.
      //
      // ZERO STATEMENTS IS A DELIBERATE, STRONGER INVARIANT THAN THE SPECIFICATION STATES. §4.2 asks
      // for "no mutation", and §7.3 would permit a session-settings read and its restoration around
      // a result that needed neither. This packet pins the stronger form on purpose: an entry with
      // no locator names nothing to look up, so the session is not touched at all — not even to
      // read a timeout — and there is therefore nothing to restore and nothing that can fail.
      expect(statements, "no statement was issued").toEqual([]);
      expect(other, "no other session capability was used").toEqual([]);
    }
  );

  it("refuses a team that is not the entry's team as a static validation error, before any statement", async () => {
    const { session, statements } = recordingSession();
    const error = await rejection(() => prepareSlackKnownRootRequeue(session, { teamId: OTHER_TEAM, entry: located() }, execution()));
    expectStaticValidationError(error, "team mismatch");
    expect(statements).toEqual([]);
  });

  it("validates the locator again instead of trusting it: a fabricated one is refused before any statement", async () => {
    const fabricated: [string, SlackKnownRootLocatedEntry][] = [
      ["a workspace that is not an ASCII alphanumeric id", located({ locator: { ...located().locator, workspaceId: `T0 ${CANARY.metadata}` } })],
      ["an empty channel id", located({ locator: { ...located().locator, channelId: "" } })],
      ["a root the exact parser refuses", located({ locator: { ...located().locator, rootTs: `1718900000.1234567${CANARY.metadata}` } })],
      ["an integration that is not a UUID", located({ locator: { ...located().locator, integrationId: CANARY.token } })],
      ["a configuration revision that is not lowercase SHA-256 hex", located({ locator: { ...located().locator, bindingConfigRevision: REVISION.toUpperCase() } })],
      ["a fingerprint offered as the configuration revision", located({ locator: { ...located().locator, bindingConfigRevision: CANARY.fingerprint } })],
      ["a negative namespace revision", located({ locator: { ...located().locator, namespaceRevision: -1 } })],
      ["a fractional namespace revision", located({ locator: { ...located().locator, namespaceRevision: 1.5 } })],
      ["an unsafe namespace revision", located({ locator: { ...located().locator, namespaceRevision: Number.MAX_SAFE_INTEGER + 2 } })],
      ["an item that is not a UUID", located({ itemId: CANARY.metadata })],
      ["a revisit policy below the minimum", located({ revisitAfterMs: SLACK_KNOWN_ROOT_LIMITS.revisitAfterMs.min - 1 })],
    ];
    for (const [label, entry] of fabricated) {
      const { session, statements } = recordingSession();
      const error = await rejection(() => prepareSlackKnownRootRequeue(session, { teamId: TEAM, entry }, execution()));
      expectStaticValidationError(error, label);
      expect(statements, `${label}: refused before any statement`).toEqual([]);
    }
  });

  it("refuses an entry that is both located and unlocated, or neither", async () => {
    const both = { ...located(), unlocated: "not_slack" } as unknown as SlackKnownRootEntry;
    const neither = { teamId: TEAM, itemId: ITEM, revisitAfterMs: REVISIT_MS } as unknown as SlackKnownRootEntry;
    const unknownCategory = { teamId: TEAM, itemId: ITEM, revisitAfterMs: REVISIT_MS, unlocated: CANARY.metadata } as unknown as SlackKnownRootEntry;
    for (const [label, entry] of [["both", both], ["neither", neither], ["an unknown category", unknownCategory]] as const) {
      const { session, statements } = recordingSession();
      const error = await rejection(() => prepareSlackKnownRootRequeue(session, { teamId: TEAM, entry }, execution()));
      expectStaticValidationError(error, label);
      expect(statements).toEqual([]);
    }
  });
});

// ── §6: page requests, cursors and execution options ─────────────────────────

describe("known-root enumeration — invalid and boundary requests", () => {
  const request = (over: Record<string, unknown> = {}): SlackKnownRootPageRequest =>
    ({ teamId: TEAM, pageSize: 10, revisitAfterMs: REVISIT_MS, ...over }) as unknown as SlackKnownRootPageRequest;
  const cursor = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: 1, teamId: TEAM, upperItemId: "0f000000-0000-4000-8000-00000000000f",
    afterItemId: "0a000000-0000-4000-8000-00000000000a", revisitAfterMs: REVISIT_MS, ...over,
  });

  it.each<[string, Record<string, unknown>]>([
    ["a team that is not a UUID", { teamId: CANARY.metadata }],
    ["page size 0", { pageSize: 0 }],
    ["page size 101", { pageSize: 101 }],
    ["a fractional page size", { pageSize: 10.5 }],
    ["a page size given as text", { pageSize: "10" }],
    ["no revisit policy (there is no runtime default)", { revisitAfterMs: undefined }],
    ["a revisit policy one millisecond below the minimum", { revisitAfterMs: 59_999 }],
    ["a revisit policy one millisecond above the maximum", { revisitAfterMs: 86_400_001 }],
    ["a fractional revisit policy", { revisitAfterMs: 60_000.5 }],
    ["a cursor of another version", { cursor: cursor({ version: 2 }) }],
    ["a cursor of another team", { cursor: cursor({ teamId: OTHER_TEAM }) }],
    ["a cursor already past its own upper bound", { cursor: cursor({ afterItemId: "0f000000-0000-4000-8000-0000000000ff" }) }],
    ["a cursor whose bound is not a UUID", { cursor: cursor({ upperItemId: CANARY.metadata }) }],
    ["a cursor carrying a different revisit policy", { cursor: cursor({ revisitAfterMs: REVISIT_MS + 1 }) }],
    ["a cursor that is not an object", { cursor: CANARY.token }],
  ])("refuses %s as a static validation error, before any statement", async (label, over) => {
    const { session, statements } = recordingSession();
    const error = await rejection(() => readSlackKnownRootItemPage(session, request(over), execution()));
    expectStaticValidationError(error, label);
    expect(statements, "refused before any statement").toEqual([]);
  });

  // CONTROL — passes against the stub (it rejects nothing) and must keep passing: the bounds
  // themselves are valid requests. Whatever a recording session then makes of the read, it is not
  // a caller-contract failure.
  it.each<[string, Record<string, unknown>]>([
    ["page size 1", { pageSize: 1 }],
    ["page size 100", { pageSize: 100 }],
    ["the minimum revisit policy", { revisitAfterMs: 60_000 }],
    ["the maximum revisit policy", { revisitAfterMs: 86_400_000 }],
    ["a well-formed continuation cursor", { cursor: cursor() }],
  ])("does not refuse %s as a caller-contract error (control)", async (_label, over) => {
    const { session } = recordingSession();
    const error = await rejection(() => readSlackKnownRootItemPage(session, request(over), execution()));
    expect(error).not.toBeInstanceOf(SlackKnownRootValidationError);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an allowance below 1,000 ms", { allowanceMs: 999, ambientDeadlineAt: null }],
    ["an allowance above 5,000 ms", { allowanceMs: 5_001, ambientDeadlineAt: null }],
    ["a fractional allowance", { allowanceMs: 1_500.5, ambientDeadlineAt: null }],
    ["an ambient deadline that was never declared", {}],
    ["an ambient deadline that is not a finite number", { ambientDeadlineAt: Number.NaN }],
    ["a monotonic clock that is not a function", { ambientDeadlineAt: null, monotonicNow: 42 }],
  ])("refuses an execution context with %s", (label, options) => {
    const error = thrown(() => createSlackKnownRootExecution(options as never));
    expectStaticValidationError(error, label);
  });

  it("gives an execution context its default 2,000 ms allowance on the supplied clock, capped by an earlier ambient deadline", () => {
    const now = 50_000;
    const plain = createSlackKnownRootExecution({ ambientDeadlineAt: null, monotonicNow: () => now });
    expect(plain.allowanceMs).toBe(2_000);
    expect(plain.deadlineAt).toBe(now + 2_000);
    const wide = createSlackKnownRootExecution({ allowanceMs: 5_000, ambientDeadlineAt: null, monotonicNow: () => now });
    expect(wide.deadlineAt).toBe(now + 5_000);
    // An earlier ambient deadline can leave less than the minimum allowance; a later one changes nothing.
    expect(createSlackKnownRootExecution({ ambientDeadlineAt: now + 300, monotonicNow: () => now }).deadlineAt).toBe(now + 300);
    expect(createSlackKnownRootExecution({ ambientDeadlineAt: now + 60_000, monotonicNow: () => now }).deadlineAt).toBe(now + 2_000);
  });
});

// ── §7.2 and §11: both primitives enforce the execution object ───────────────

/**
 * Red review, MEDIUM. Validating the options of `createSlackKnownRootExecution` proves nothing about
 * what the two primitives do with the object they are HANDED: a caller can pass anything, and a
 * context that was sound when it was created can have run out, or its clock can have failed, by the
 * time a primitive is called. Each case below goes through a primitive, with a session that records
 * every use, and none depends on how a context is represented: a hand-built object is only ever
 * expected to be REFUSED, so an implementation that accepts nothing but its own contexts and one that
 * checks the fields both satisfy them.
 */
describe("known-root primitives — the execution object is enforced by the primitive it is handed to", () => {
  const PRIMITIVES: [string, (session: TransactionSession, execution: unknown) => Promise<unknown>][] = [
    ["the page reader", (session, execution) =>
      readSlackKnownRootItemPage(session, { teamId: TEAM, pageSize: 10, revisitAfterMs: REVISIT_MS }, execution as never)],
    ["the preparer", (session, execution) =>
      prepareSlackKnownRootRequeue(session, { teamId: TEAM, entry: located() }, execution as never)],
  ];
  const NOW = 50_000;
  const steady = (): number => NOW;

  const MALFORMED: [string, unknown][] = [
    ["no execution at all", undefined],
    ["null", null],
    ["a string", CANARY.token],
    ["an empty object", {}],
    ["an array", [2_000, NOW + 2_000, steady]],
    ["a deadline that is not a number", { allowanceMs: 2_000, deadlineAt: CANARY.metadata, monotonicNow: steady }],
    ["a NaN deadline", { allowanceMs: 2_000, deadlineAt: Number.NaN, monotonicNow: steady }],
    ["an infinite deadline", { allowanceMs: 2_000, deadlineAt: Number.POSITIVE_INFINITY, monotonicNow: steady }],
    ["a negatively infinite deadline", { allowanceMs: 2_000, deadlineAt: Number.NEGATIVE_INFINITY, monotonicNow: steady }],
    ["no deadline", { allowanceMs: 2_000, monotonicNow: steady }],
    ["a NaN allowance", { allowanceMs: Number.NaN, deadlineAt: NOW + 2_000, monotonicNow: steady }],
    ["an infinite allowance", { allowanceMs: Number.POSITIVE_INFINITY, deadlineAt: NOW + 2_000, monotonicNow: steady }],
    ["an allowance below the minimum", { allowanceMs: 999, deadlineAt: NOW + 999, monotonicNow: steady }],
    ["an allowance above the maximum", { allowanceMs: 5_001, deadlineAt: NOW + 5_001, monotonicNow: steady }],
    ["a fractional allowance", { allowanceMs: 1_500.5, deadlineAt: NOW + 1_500, monotonicNow: steady }],
    ["an allowance given as text", { allowanceMs: "2000", deadlineAt: NOW + 2_000, monotonicNow: steady }],
    ["no clock", { allowanceMs: 2_000, deadlineAt: NOW + 2_000 }],
    ["a clock that is not a function", { allowanceMs: 2_000, deadlineAt: NOW + 2_000, monotonicNow: 42 }],
  ];

  describe.each(PRIMITIVES)("%s", (_primitive, run) => {
    it.each(MALFORMED)("refuses %s as a static validation error, before any statement", async (label, execution) => {
      const { session, statements, other } = recordingSession();
      const error = await rejection(() => run(session, execution));
      expectStaticValidationError(error, label);
      expect(statements, `${label}: refused before any statement`).toEqual([]);
      expect(other, `${label}: no other session capability was used`).toEqual([]);
    });

    // §11: "An already-expired ambient deadline issues no data SQL." Creating the context is allowed —
    // an ambient deadline that has passed is a fact about the caller's remaining time, not a malformed
    // option — and the primitive is what refuses to start. This packet pins the stronger form of
    // "no data SQL": the admission check comes first, so the session is not touched at all.
    it.each([1, 250, 60_000])("refuses a context whose ambient deadline passed %d ms before it was created: a deadline error, and not one statement", async (ago) => {
      let execution: unknown;
      expect(() => {
        execution = createSlackKnownRootExecution({ ambientDeadlineAt: NOW - ago, monotonicNow: steady });
      }, "creating it is allowed").not.toThrow();
      const { session, statements, other } = recordingSession();
      const error = await rejection(() => run(session, execution));
      expect(error, "the primitive rejected with the slice's deadline error").toBeInstanceOf(SlackKnownRootDeadlineError);
      expect((error as Error).message).toBe(STATIC_DEADLINE_MESSAGE);
      expectNoCanary(error, "deadline error");
      expect(statements, "no statement was issued").toEqual([]);
      expect(other).toEqual([]);
      // The same rejection is what the reporting classifier is given.
      expect(classifySlackKnownRootPreparationFailure(error)).toBe("deadline_exceeded");
    });

    // §7.2: the context is created BEFORE the transaction and reused across its attempts. One whose
    // allowance ran out before this call — a retry, or a late start — gets no fresh allowance.
    it("refuses a context whose own allowance ran out before the call: a retry gets no fresh allowance", async () => {
      let now = NOW;
      const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null, monotonicNow: () => now });
      now += SLACK_KNOWN_ROOT_LIMITS.allowanceMs.default + 1;
      const { session, statements } = recordingSession();
      const error = await rejection(() => run(session, execution));
      expect(error).toBeInstanceOf(SlackKnownRootDeadlineError);
      expect((error as Error).message).toBe(STATIC_DEADLINE_MESSAGE);
      expect(statements, "no statement was issued").toEqual([]);
    });

    // §7.2: "Invalid or failing clock reads throw safely." The clock is sound while the context is
    // created and fails afterwards, however many readings creation took.
    it.each<[string, () => number]>([
      ["throws", () => { throw new Error(`clock device failed: ${CANARY.metadata}`); }],
      ["throws something that is not an error", () => { throw CANARY.token; }],
      ["returns NaN", () => Number.NaN],
      ["returns Infinity", () => Number.POSITIVE_INFINITY],
      ["returns text", () => CANARY.fingerprint as unknown as number],
    ])("fails safely when the monotonic clock %s after creation: an error that leaks nothing, and not one statement", async (label, broken) => {
      let failed = false;
      const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null, monotonicNow: () => (failed ? broken() : NOW) });
      failed = true;
      const { session, statements, other } = recordingSession();
      const error = await rejection(() => run(session, execution));
      // An error of the packet's own making: never the clock's exception, and nothing it carried.
      expect(error, `${label}: the primitive rejected`).toBeInstanceOf(Error);
      expectNoCanary(error, label);
      expect(statements, `${label}: no statement was issued`).toEqual([]);
      expect(other).toEqual([]);
      // Whatever it is, it is reportable only as a closed category.
      expect(SLACK_KNOWN_ROOT_FAILURE_CATEGORIES as readonly string[]).toContain(classifySlackKnownRootPreparationFailure(error));
    });
  });

  it.each<[string, () => number]>([
    ["throws", () => { throw new Error(`clock device failed: ${CANARY.metadata}`); }],
    ["returns NaN", () => Number.NaN],
    ["returns Infinity", () => Number.POSITIVE_INFINITY],
    ["returns text", () => CANARY.fingerprint as unknown as number],
  ])("refuses to CREATE a context on a monotonic clock that %s, leaking nothing", (label, monotonicNow) => {
    const error = thrown(() => createSlackKnownRootExecution({ ambientDeadlineAt: null, monotonicNow }));
    expect(error, `${label}: creation threw`).toBeInstanceOf(Error);
    expectNoCanary(error, label);
  });

  // CONTROL — passes against the stubs and must keep passing: a sound context that still has time
  // is not what any case above refuses. Whatever a recording session then makes of the read, it is
  // neither a caller-contract failure nor a deadline.
  it.each(PRIMITIVES)("%s does not refuse a sound context that still has time (control)", async (_label, run) => {
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: NOW + 60_000, monotonicNow: steady });
    const { session } = recordingSession();
    const error = await rejection(() => run(session, execution));
    expect(error).not.toBeInstanceOf(SlackKnownRootValidationError);
    expect(error).not.toBeInstanceOf(SlackKnownRootDeadlineError);
  });
});

// ── §7.3 and §7.4: the decorated session, observed at the executor it wraps ───

/**
 * Source review (KR-12 in part). These cases drive the two PUBLIC primitives against a scripted
 * session and read the contract off the only place it is observable without a database: the
 * statements that reach the caller's own executor, in the order they reach it, and the values they
 * carry.
 *
 * The script is a small model of the server, not a copy of the implementation. It recognises a
 * timeout assignment by what it DOES — `set_config('statement_timeout' | 'lock_timeout', …)` or a
 * `SET` of either, local or not — and applies it to its own "effective settings"; it answers a read
 * of those settings; and everything else is a data statement, recorded with the settings in effect
 * when it was dispatched. No case counts statements or matches a statement's text beyond that, so an
 * implementation is free in how many reads it makes and how it words them.
 *
 * Cases marked "(control)" are expected to pass at the source-reviewed checkpoint and are the
 * lifecycle evidence that was missing. The regressing-clock case is expected to FAIL there.
 */
describe("known-root decorated session — statement order, refreshed timeouts, restoration and closure", () => {
  type TimeoutName = "statement_timeout" | "lock_timeout";
  interface Settings { statementMs: number; lockMs: number }
  interface Assignment { name: TimeoutName; ms: number; local: boolean }
  type Logged =
    | { kind: "settings-read" }
    | { kind: "timeouts"; assignments: Assignment[] }
    | { kind: "data"; text: string; effective: Settings };

  function milliseconds(value: unknown): number {
    const match = /^(\d+)\s*(ms|s|min)?$/.exec(String(value).trim());
    if (!match) return Number.NaN;
    const amount = Number(match[1]);
    return match[2] === "s" ? amount * 1_000 : match[2] === "min" ? amount * 60_000 : amount;
  }

  /** Every timeout assignment a statement makes, whichever of the server's spellings it uses. */
  function timeoutAssignments(text: string, params: readonly unknown[]): Assignment[] {
    const found: Assignment[] = [];
    const call = /set_config\s*\(\s*'(statement_timeout|lock_timeout)'\s*,\s*(?:\$(\d+)(?:::\w+)?|'([^']*)')\s*,\s*(true|false)\s*\)/gi;
    for (const match of text.matchAll(call)) {
      found.push({
        name: match[1].toLowerCase() as TimeoutName,
        ms: milliseconds(match[2] ? params[Number(match[2]) - 1] : match[3]),
        local: match[4].toLowerCase() === "true",
      });
    }
    const statement = /\bset\s+(local\s+|session\s+)?(statement_timeout|lock_timeout)\s*(?:=|\bto\b)\s*'?(\w+)'?/gi;
    for (const match of text.matchAll(statement)) {
      found.push({ name: match[2].toLowerCase() as TimeoutName, ms: milliseconds(match[3]), local: /^local/i.test(match[1] ?? "") });
    }
    return found;
  }

  interface Script {
    original?: Settings;
    /** Rows for a data statement. May advance a clock, throw, or wait. */
    respond?: (text: string, params: readonly unknown[]) => unknown[] | Promise<unknown[]>;
    /** Called for a timeout statement AFTER its assignments were recorded; may throw to fail it. */
    onTimeouts?: (assignments: Assignment[], dataSoFar: number) => void;
  }

  function scriptedSession(script: Script = {}) {
    const original: Settings = script.original ?? { statementMs: 30_000, lockMs: 1_500 };
    const effective: Settings = { ...original };
    const log: Logged[] = [];
    const other: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const executeSql = (async (text: string, params: unknown[] = []) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const assignments = timeoutAssignments(text, params);
        if (assignments.length > 0) {
          log.push({ kind: "timeouts", assignments });
          for (const assignment of assignments) {
            if (assignment.name === "statement_timeout") effective.statementMs = assignment.ms;
            else effective.lockMs = assignment.ms;
          }
          script.onTimeouts?.(assignments, log.filter((entry) => entry.kind === "data").length);
          return { rows: [{}], rowCount: 1 };
        }
        // The model answers ONE way of reading the settings: the `pg_settings` catalog, whose
        // `setting` is the server-normalized value in the setting's own unit (milliseconds here).
        // Any other read reaches the script as a data statement.
        if (/\bpg_settings\b/i.test(text)) {
          log.push({ kind: "settings-read" });
          const rows = [
            { name: "statement_timeout", setting: String(effective.statementMs), unit: "ms" },
            { name: "lock_timeout", setting: String(effective.lockMs), unit: "ms" },
          ];
          return { rows, rowCount: rows.length };
        }
        log.push({ kind: "data", text, effective: { ...effective } });
        const rows = await (script.respond ? script.respond(text, params) : []);
        return { rows, rowCount: rows.length };
      } finally {
        inFlight--;
      }
    }) as SqlExecutor;
    const session = {
      get db(): never {
        other.push("db");
        throw new Error("fixture: the caller's own db client was used");
      },
      executeSql,
      optionalAudit: async <T>(_operation: () => Promise<T>, fallback: T): Promise<T> => {
        other.push("optionalAudit");
        return fallback;
      },
    } as unknown as TransactionSession;
    return {
      session, log, other, original, effective,
      maxInFlight: () => maxInFlight,
      data: () => log.filter((entry): entry is Extract<Logged, { kind: "data" }> => entry.kind === "data"),
      assignments: () => log.flatMap((entry) => (entry.kind === "timeouts" ? entry.assignments : [])),
    };
  }
  type Scripted = ReturnType<typeof scriptedSession>;

  const pageRequest = { teamId: TEAM, pageSize: 10, revisitAfterMs: REVISIT_MS } as const;
  /** A stored gate row that is ready for the fixture locator: the real gate helper reads it. */
  const readyGateRow = {
    team_id: TEAM, raw_channel_id: "C0KNOWN1", state: "ready", revision: "3", ready_revision: "3",
    resolved_workspace_ids: ["T0SOURCE1"], completed_repair_id: "0c000000-0000-4000-8000-00000000000c", blocked_reason: null,
  };

  /** The order every outcome shares: settings are read before anything is set, and each data statement runs under a fresh assignment. */
  function expectOrdered(scripted: Scripted): void {
    const kinds = scripted.log.map((entry) => entry.kind);
    expect(kinds[0], "the original settings are read first").toBe("settings-read");
    // Between that first read and the last data statement the settings are only ever SET, each time
    // just before a data statement. A read-back that verifies the restoration afterwards is allowed;
    // a second read in the middle would not be the originals any more.
    const lastData = kinds.lastIndexOf("data");
    expect(kinds.slice(1, Math.max(lastData, 1)).filter((kind) => kind === "settings-read"), "no settings read between entry and the last data statement").toEqual([]);
    // Every assignment before the last data statement belongs to a data statement: it is directly
    // followed by one. Nothing is set and then left unused in the middle of the operation.
    kinds.slice(0, Math.max(lastData, 0)).forEach((kind, index) => {
      if (kind === "timeouts") expect(kinds[index + 1], `the assignment at ${index} is followed by its data statement`).toBe("data");
    });
    scripted.log.forEach((entry, index) => {
      if (entry.kind !== "data") return;
      const previous = scripted.log[index - 1];
      expect(previous?.kind, `data statement ${index} is immediately preceded by a timeout assignment`).toBe("timeouts");
      const names = previous?.kind === "timeouts" ? previous.assignments.map((assignment) => assignment.name).sort() : [];
      expect(names, `both timeouts are set before data statement ${index}`).toEqual(["lock_timeout", "statement_timeout"]);
    });
    // Nothing is ever set for the SESSION: a pooled connection keeps whatever outlives the transaction.
    expect(scripted.assignments().filter((assignment) => !assignment.local), "every assignment is transaction-local").toEqual([]);
    for (const assignment of scripted.assignments()) expect(Number.isSafeInteger(assignment.ms) && assignment.ms >= 0, "an assignment is whole milliseconds").toBe(true);
    expect(scripted.maxInFlight(), "the caller's executor never has two statements in flight").toBe(1);
    expect(scripted.other, "the caller's own db client and audit helper were never used").toEqual([]);
  }

  /** A normal result leaves both settings exactly as it found them, and the restoring assignment is the last statement. */
  function expectRestored(scripted: Scripted): void {
    // What follows the last data statement (or the entry read, when no data statement ran) is the
    // restoration and nothing else: at least one assignment, optionally a read-back that verifies it,
    // and never another data statement or an assignment after that read-back.
    const kinds = scripted.log.map((entry) => entry.kind);
    const tail = kinds.slice(Math.max(kinds.lastIndexOf("data"), 0) + 1);
    expect(tail.filter((kind) => kind === "data"), "no data statement follows the restoration").toEqual([]);
    expect(tail.filter((kind) => kind === "timeouts").length, "the settings are restored after the last data statement").toBeGreaterThanOrEqual(1);
    const firstReadBack = tail.indexOf("settings-read");
    if (firstReadBack >= 0) expect(tail.slice(firstReadBack), "nothing but read-backs follows a read-back").toEqual(tail.slice(firstReadBack).map(() => "settings-read"));
    expect(scripted.effective, "both original settings are in effect again").toEqual(scripted.original);
  }

  /** After a failed data statement nothing more is sent: no assignment, no restoration, no read, no data. */
  function expectNothingAfterLastData(scripted: Scripted): void {
    const kinds = scripted.log.map((entry) => entry.kind);
    const lastData = kinds.lastIndexOf("data");
    expect(lastData, "a data statement was dispatched").toBeGreaterThanOrEqual(0);
    expect(kinds.slice(lastData + 1), "no statement of any kind was sent after the failing data statement").toEqual([]);
    expect(kinds.slice(lastData + 1).filter((kind) => kind === "timeouts"), "in particular no timeout assignment or restoration").toEqual([]);
  }

  it("reads the original settings first, then sets both timeouts afresh before EVERY data statement from the time that is left (control)", async () => {
    const clock = { now: 500_000 };
    // Every data statement takes 300 ms and finds one item: a first page of a non-empty team.
    const scripted = scriptedSession({
      original: { statementMs: 0, lockMs: 0 },
      respond: () => { clock.now += 300; return [{ id: ITEM }]; },
    });
    const context = createSlackKnownRootExecution({ ambientDeadlineAt: null, monotonicNow: () => clock.now });
    const page = await readSlackKnownRootItemPage(scripted.session, pageRequest, context);
    expect(page.examined).toBe(1);

    expectOrdered(scripted);
    const data = scripted.data();
    // The upper bound and the id read are separate reads by §4.2: at least two data statements.
    expect(data.length, "a first page of a non-empty team is more than one read").toBeGreaterThanOrEqual(2);
    data.forEach((statement, index) => {
      const remaining = SLACK_KNOWN_ROOT_LIMITS.allowanceMs.default - 300 * index;
      // No more than what is left of the allowance, and not an arbitrary smaller number either.
      expect(statement.effective.statementMs, `statement timeout of data statement ${index}`).toBeLessThanOrEqual(remaining);
      expect(statement.effective.statementMs, `statement timeout of data statement ${index}`).toBeGreaterThanOrEqual(remaining - 1);
      expect(statement.effective.lockMs, `lock timeout of data statement ${index}`).toBeLessThanOrEqual(Math.min(SLACK_KNOWN_ROOT_LIMITS.lockTimeoutMs, remaining));
      // Zero would DISABLE the limit: an assignment before a data statement is never zero.
      expect(statement.effective.statementMs).toBeGreaterThanOrEqual(1);
      expect(statement.effective.lockMs).toBeGreaterThanOrEqual(1);
      if (index > 0) expect(statement.effective.statementMs, "refreshed, not reused").toBeLessThan(data[index - 1].effective.statementMs);
    });
    expectRestored(scripted);
  });

  it.each<[string, Settings, Settings]>([
    ["a stricter original statement timeout and lock timeout", { statementMs: 50, lockMs: 20 }, { statementMs: 50, lockMs: 20 }],
    ["a stricter original statement timeout with the lock timeout disabled", { statementMs: 40, lockMs: 0 }, { statementMs: 40, lockMs: 40 }],
    ["a stricter original lock timeout with the statement timeout disabled", { statementMs: 0, lockMs: 100 }, { statementMs: 2_000, lockMs: 100 }],
    ["a looser original statement timeout", { statementMs: 30_000, lockMs: 10_000 }, { statementMs: 2_000, lockMs: 250 }],
  ])("never loosens %s (control)", async (_label, original, ceiling) => {
    const scripted = scriptedSession({ original, respond: () => [{ id: ITEM }] });
    const context = createSlackKnownRootExecution({ ambientDeadlineAt: null, monotonicNow: () => 500_000 });
    await readSlackKnownRootItemPage(scripted.session, pageRequest, context);
    expectOrdered(scripted);
    expect(scripted.data().length).toBeGreaterThanOrEqual(1);
    for (const statement of scripted.data()) {
      expect(statement.effective.statementMs).toBeGreaterThanOrEqual(1);
      expect(statement.effective.statementMs).toBeLessThanOrEqual(ceiling.statementMs);
      expect(statement.effective.lockMs).toBeGreaterThanOrEqual(1);
      expect(statement.effective.lockMs).toBeLessThanOrEqual(ceiling.lockMs);
    }
    // Restored to the ORIGINALS, including a disabled (zero) one — not to this packet's own caps.
    expectRestored(scripted);
  });

  // EXPECTED RED at the source-reviewed checkpoint (review finding S6). The remaining time is
  // computed from the clock alone, so a monotonic clock that reads EARLIER than it did when the
  // context was created yields more "remaining" than the allowance that was declared, and that is
  // handed to the server as the statement timeout. With the original limit disabled nothing else
  // caps it. A context never grants more than its own allowance, whatever the clock says later.
  //
  // One case per module AND per allowance, so each is reported on its own.
  const REGRESSING_SUBJECTS: [string, (scripted: Scripted, context: never) => Promise<unknown>][] = [
    ["the page reader", (scripted, context) => readSlackKnownRootItemPage(scripted.session, pageRequest, context)],
    ["the preparer", (scripted, context) => prepareSlackKnownRootRequeue(scripted.session, { teamId: TEAM, entry: located() }, context)],
  ];
  const REGRESSING_CASES = REGRESSING_SUBJECTS.flatMap(([subject, run]) =>
    [1_000, 2_000, 5_000].map((allowanceMs): [string, number, typeof run] => [subject, allowanceMs, run]));

  it.each(REGRESSING_CASES)("never sets a statement timeout above the declared allowance when the monotonic clock regresses: %s, allowance %d ms", async (_subject, allowanceMs, run) => {
    let regressed = false;
    const scripted = scriptedSession({ original: { statementMs: 0, lockMs: 0 }, respond: () => [] });
    const context = createSlackKnownRootExecution({
      allowanceMs, ambientDeadlineAt: null, monotonicNow: () => (regressed ? 400_000 : 1_000_000),
    });
    // Ten minutes EARLIER on every reading after creation.
    regressed = true;
    let rejected: unknown;
    let settled = false;
    try {
      await run(scripted, context as never);
      settled = true;
    } catch (error) {
      rejected = error;
    }
    // Either the operation ran under its allowance, or it refused the clock outright: what it may
    // not do is run a statement with more time than the context declared.
    if (!settled) {
      // A refusal is one of the packet's two static errors, exactly — never an arbitrary rejection,
      // and never something a dependency or the session happened to throw.
      const staticRefusal =
        (rejected instanceof SlackKnownRootValidationError && rejected.message === STATIC_VALIDATION_MESSAGE) ||
        (rejected instanceof SlackKnownRootDeadlineError && rejected.message === STATIC_DEADLINE_MESSAGE);
      expect(staticRefusal, "a refusal of a regressing clock is the static validation or deadline error").toBe(true);
      expectNoCanary(rejected, "a refusal of the clock");
    }
    expect(scripted.data().length > 0 || !settled, "the operation ran a statement or refused").toBe(true);
    for (const statement of scripted.data()) {
      expect(statement.effective.statementMs, "statement timeout").toBeGreaterThanOrEqual(1);
      expect(statement.effective.statementMs, "statement timeout").toBeLessThanOrEqual(allowanceMs);
      expect(statement.effective.lockMs, "lock timeout").toBeGreaterThanOrEqual(1);
      expect(statement.effective.lockMs, "lock timeout").toBeLessThanOrEqual(Math.min(SLACK_KNOWN_ROOT_LIMITS.lockTimeoutMs, allowanceMs));
    }
    for (const assignment of scripted.assignments().filter((candidate) => candidate.name === "statement_timeout" && candidate.ms !== 0)) {
      expect(assignment.ms, "no statement timeout assignment exceeds the allowance").toBeLessThanOrEqual(allowanceMs);
    }
  });

  it.each<[string, Script["respond"], (scripted: Scripted) => Promise<unknown>, unknown]>([
    [
      "the page reader on an empty team", () => [],
      (scripted) => readSlackKnownRootItemPage(scripted.session, pageRequest, execution()),
      { entries: [], nextCursor: null, exhausted: true, examined: 0 },
    ],
    [
      "the page reader on a continuation that finds nothing more", () => [],
      (scripted) => readSlackKnownRootItemPage(scripted.session, {
        ...pageRequest,
        cursor: { version: 1, teamId: TEAM, upperItemId: "0f000000-0000-4000-8000-00000000000f", afterItemId: ITEM, revisitAfterMs: REVISIT_MS },
      }, execution()),
      { entries: [], nextCursor: null, exhausted: true, examined: 0 },
    ],
    [
      "the preparer refused at the namespace gate", () => [],
      (scripted) => prepareSlackKnownRootRequeue(scripted.session, { teamId: TEAM, entry: located() }, execution()),
      { outcome: "refused", reason: "namespace_changed_or_unready" },
    ],
    [
      "the preparer refused at the integration, after the gate locked",
      (text) => (/slack_channel_migration_gates/i.test(text) ? [readyGateRow] : []),
      (scripted) => prepareSlackKnownRootRequeue(scripted.session, { teamId: TEAM, entry: located() }, execution()),
      { outcome: "refused", reason: "source_not_current" },
    ],
  ])("restores both original settings before a normal result resolves: %s (control)", async (_label, respond, run, expected) => {
    const scripted = scriptedSession({ original: { statementMs: 30_000, lockMs: 1_500 }, respond });
    const result = await run(scripted);
    expect(result).toEqual(expected);
    expectOrdered(scripted);
    expect(scripted.data().length, "the outcome was reached through at least one data statement").toBeGreaterThanOrEqual(1);
    // While the operation ran the settings really were changed: the restoration is not a no-op.
    for (const statement of scripted.data()) expect(statement.effective).not.toEqual(scripted.original);
    expectRestored(scripted);
  });

  it("issues no statement at all for an unlocated entry: there is nothing to set and nothing to restore (control)", async () => {
    const scripted = scriptedSession();
    const entry: SlackKnownRootEntry = { teamId: TEAM, itemId: ITEM, revisitAfterMs: REVISIT_MS, unlocated: "invalid_metadata" };
    expect(await prepareSlackKnownRootRequeue(scripted.session, { teamId: TEAM, entry }, execution()))
      .toEqual({ outcome: "unattested", reason: "invalid_metadata" });
    expect(scripted.log).toEqual([]);
    expect(scripted.effective).toEqual(scripted.original);
  });

  it.each<[string, (scripted: Scripted) => Promise<unknown>]>([
    ["the page reader", (scripted) => readSlackKnownRootItemPage(scripted.session, pageRequest, execution())],
    ["the preparer", (scripted) => prepareSlackKnownRootRequeue(scripted.session, { teamId: TEAM, entry: located() }, execution())],
  ])("rethrows a failed statement as it is and sends nothing after it — no restoration: %s (control)", async (_label, run) => {
    // After a SQL failure the transaction may be aborted: a restoring statement would only mask the
    // primary error, and the caller's rollback undoes transaction-local settings by itself.
    const failure = Object.assign(new Error(`canceling statement: ${CANARY.sql}`), { code: "57014" });
    const scripted = scriptedSession({ respond: () => { throw failure; } });
    const error = await rejection(() => run(scripted));
    expect(error, "the very same error object, for the caller's rollback and retry logic").toBe(failure);
    expect(scripted.data(), "the failing statement was the only data statement").toHaveLength(1);
    expect(scripted.log.at(-1)?.kind, "nothing was sent after the failed statement").toBe("data");
    // Read off the event log itself: after the failing data statement there is no assignment, no
    // restoration, no read and no further data statement.
    expectNothingAfterLastData(scripted);
    // …and the assignment that preceded the failing statement is therefore still in effect on the
    // model: the settings were NOT put back by the packet. Rollback is what undoes them.
    expect(scripted.effective, "no restoring assignment was applied").not.toEqual(scripted.original);
    expect(scripted.maxInFlight()).toBe(1);
    expect(classifySlackKnownRootPreparationFailure(error)).toBe("statement_timeout");
  });

  it.each<[string, (scripted: Scripted, context: never) => Promise<unknown>]>([
    ["the page reader", (scripted, context) => readSlackKnownRootItemPage(scripted.session, pageRequest, context)],
    ["the preparer", (scripted, context) => prepareSlackKnownRootRequeue(scripted.session, { teamId: TEAM, entry: located() }, context)],
  ])("throws the deadline error when a statement outlives the allowance, and runs no further data statement: %s (control)", async (_label, run) => {
    const clock = { now: 500_000 };
    const scripted = scriptedSession({
      respond: (text) => {
        clock.now += 60_000;
        return /slack_channel_migration_gates/i.test(text) ? [readyGateRow] : [{ id: ITEM }];
      },
    });
    const context = createSlackKnownRootExecution({ ambientDeadlineAt: null, monotonicNow: () => clock.now });
    const error = await rejection(() => run(scripted, context as never));
    expect(error).toBeInstanceOf(SlackKnownRootDeadlineError);
    expect(scripted.data(), "the statement that ran out the clock was the last data statement").toHaveLength(1);
    expect(classifySlackKnownRootPreparationFailure(error)).toBe("deadline_exceeded");
  });

  it("never reports success when the restoring assignment itself fails (control)", async () => {
    const failure = Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
    const original = { statementMs: 30_000, lockMs: 1_500 };
    // The restoring assignment is the one that sets BOTH settings back to the originals after data ran.
    const scripted = scriptedSession({
      original,
      respond: () => [],
      onTimeouts: (assignments, dataSoFar) => {
        const restoring = dataSoFar > 0 &&
          assignments.some((assignment) => assignment.name === "statement_timeout" && assignment.ms === original.statementMs) &&
          assignments.some((assignment) => assignment.name === "lock_timeout" && assignment.ms === original.lockMs);
        if (restoring) throw failure;
      },
    });
    const error = await rejection(() => readSlackKnownRootItemPage(scripted.session, pageRequest, execution()));
    expect(error, "the restoration failure is thrown, not swallowed into an empty page").toBe(failure);
    expect(classifySlackKnownRootPreparationFailure(error)).toBe("database_failure");
  });

  it("hands its dependencies a session whose db and audit helper refuse, whose statements are sequential, and which stops working once the primitive settles (control)", async () => {
    const scripted = scriptedSession({ respond: () => [{ probe: 1 }] });
    let handed: TransactionSession | null = null;
    const seen: Record<string, unknown> = {};
    let auditRan = false;
    gateSeat.current = async (session: unknown) => {
      const decorated = session as TransactionSession;
      handed = decorated;
      // The builder: getting it, or using it, must fail — it must never yield a working client.
      seen.db = thrown(() => (decorated.db as unknown as { from: (table: string) => unknown }).from("items"));
      // The savepoint helper: it must fail, and must neither run the operation nor answer the fallback.
      seen.audit = await rejection(async () => decorated.optionalAudit(async () => { auditRan = true; return "ran"; }, "fallback"));
      // Statements still work while the operation is running…
      seen.probe = await decorated.executeSql("select 1 as probe");
      // …one at a time, however a dependency issues them.
      seen.pair = await Promise.allSettled([decorated.executeSql("select 'first' as probe"), decorated.executeSql("select 'second' as probe")]);
      return { outcome: "refused" };
    };

    const result = await prepareSlackKnownRootRequeue(scripted.session, { teamId: TEAM, entry: located() }, execution());
    expect(result).toEqual({ outcome: "refused", reason: "namespace_changed_or_unready" });
    // The handed session is never given to a matcher as a VALUE: `toBe` on two different objects
    // goes on to compare them deeply for its hint, which reads `db` on both — and each getter throws,
    // one of them recording a use of the caller's own client. Identity is decided here, as booleans.
    expect((handed as unknown) !== null, "the gate helper was handed a session").toBe(true);
    expect(Object.is(handed, scripted.session), "…and not the caller's own").toBe(false);

    expect(seen.db, "the decorated db refuses").toBeInstanceOf(Error);
    expect(seen.audit, "the decorated audit helper refuses").toBeInstanceOf(Error);
    expect(auditRan, "the audited operation never ran").toBe(false);
    expect(scripted.other, "neither capability reached the caller's own session").toEqual([]);
    expect(seen.probe).toMatchObject({ rows: [{ probe: 1 }] });
    expect((seen.pair as PromiseSettledResult<unknown>[])[0].status, "the first of two statements ran").toBe("fulfilled");
    expectOrdered(scripted);
    expectRestored(scripted);

    // After the primitive has settled, the executor somebody kept is of no further use: it rejects,
    // and nothing reaches the caller's connection.
    const kept = handed as unknown as TransactionSession;
    const before = scripted.log.length;
    expect(await rejection(() => kept.executeSql("select 1 as late")), "a retained executor rejects").toBeInstanceOf(Error);
    expect(scripted.log, "nothing was sent after the primitive settled").toHaveLength(before);
    // The getter is invoked INSIDE the callback, so the matcher observes it throwing.
    expect(() => kept.db, "the retained session's db still refuses").toThrow();
    expect(thrown(() => (kept.db as unknown as { from: (table: string) => unknown }).from("items"))).toBeInstanceOf(Error);
    expect(scripted.other, "the caller's own session was still never used").toEqual([]);
    expect(scripted.effective, "the settings stayed restored").toEqual(scripted.original);
  });

  it("leaves a retained executor unusable after a primitive that THREW as well (control)", async () => {
    // The dependency runs one statement that works and one that FAILS on the caller's connection,
    // and lets that failure propagate.
    const failure = new Error("dependency failed");
    const scripted = scriptedSession({
      respond: (text) => {
        if (/failing_probe/.test(text)) throw failure;
        return [{ probe: 1 }];
      },
    });
    let handed: TransactionSession | null = null;
    gateSeat.current = async (session: unknown) => {
      const decorated = session as TransactionSession;
      handed = decorated;
      await decorated.executeSql("select 1 as working_probe");
      await decorated.executeSql("select 1 as failing_probe");
      return { outcome: "locked" };
    };
    const error = await rejection(() => prepareSlackKnownRootRequeue(scripted.session, { teamId: TEAM, entry: located() }, execution()));
    expect(error).toBeInstanceOf(Error);
    expect(error, "the dependency's own failure, as it was thrown").toBe(failure);
    expect(classifySlackKnownRootPreparationFailure(error)).toBe("dependency_failure");
    const kept = handed as unknown as TransactionSession;
    // As above: decided as a boolean, never by handing the getter-bearing session to a matcher.
    expect((handed as unknown) !== null, "the gate helper was handed a session").toBe(true);

    // The event log, not an absence that was never possible: two data statements were dispatched,
    // the second is the one that failed, and NOTHING was sent after it — no timeout assignment, no
    // restoration, no read-back.
    const data = scripted.data();
    expect(data.map((statement) => /failing_probe/.test(statement.text)), "a working statement, then the failing one").toEqual([false, true]);
    expectNothingAfterLastData(scripted);
    // Each of the two was still preceded by its own assignment, and nothing was session-level.
    const kinds = scripted.log.map((entry) => entry.kind);
    expect(kinds[0], "the original settings were read first").toBe("settings-read");
    kinds.forEach((kind, index) => {
      if (kind === "data") expect(kinds[index - 1], `data statement ${index} was preceded by its assignment`).toBe("timeouts");
    });
    expect(scripted.assignments().filter((assignment) => !assignment.local)).toEqual([]);
    // The settings in effect are the ones set for the failing statement: the packet restored nothing.
    expect(scripted.effective, "no restoring assignment was applied").not.toEqual(scripted.original);

    const before = scripted.log.length;
    expect(await rejection(() => kept.executeSql("select 1 as late"))).toBeInstanceOf(Error);
    expect(scripted.log).toHaveLength(before);
  });
});

// ── §8.1: the pure failure classifier ────────────────────────────────────────

describe("known-root failure classifier — closed categories, fixed precedence, nothing leaked", () => {
  const sqlError = (code: string): Error => Object.assign(new Error(`driver said: ${CANARY.sql}`), { code });
  const outer = (options: { code?: string; unknownCommit?: boolean; cause?: unknown } = {}): TransactionExecutionError =>
    new TransactionExecutionError(`transaction failed running ${CANARY.sql}`, { sql: CANARY.sql, ...options });

  it("names the closed reporting vocabulary exactly", () => {
    expect([...SLACK_KNOWN_ROOT_FAILURE_CATEGORIES]).toEqual([
      "lock_timeout", "statement_timeout", "deadline_exceeded", "serialization_failure", "deadlock",
      "database_failure", "dependency_failure", "commit_unknown",
    ]);
  });

  it.each<[string, () => unknown, string]>([
    ["an unknown commit", () => outer({ unknownCommit: true }), "commit_unknown"],
    ["an unknown commit carrying a retryable SQLSTATE", () => outer({ unknownCommit: true, code: "40001" }), "commit_unknown"],
    ["an unknown commit carrying a lock-timeout SQLSTATE", () => outer({ unknownCommit: true, code: "55P03" }), "commit_unknown"],
    ["an unknown commit carrying a Node error code", () => outer({ unknownCommit: true, code: "ECONNRESET" }), "commit_unknown"],
    // Rung 1 above rung 2: with BOTH markers on the final rejection, the commit is what is unknown.
    ["an unknown commit that also carries the deadline marker", () => Object.assign(outer({ unknownCommit: true }), { slackKnownRootDeadlineExceeded: true }), "commit_unknown"],
    ["the deadline error itself marked as an unknown commit", () => Object.assign(new SlackKnownRootDeadlineError(), { unknownCommit: true }), "commit_unknown"],
    ["an unknown commit carrying the deadline marker and a statement-timeout SQLSTATE", () => Object.assign(outer({ unknownCommit: true, code: "57014" }), { slackKnownRootDeadlineExceeded: true }), "commit_unknown"],
    ["the slice's own deadline error", () => new SlackKnownRootDeadlineError(), "deadline_exceeded"],
    ["the deadline error even with a statement-timeout SQLSTATE attached", () => Object.assign(new SlackKnownRootDeadlineError(), { code: "57014" }), "deadline_exceeded"],
    ["SQLSTATE 55P03 from the driver", () => sqlError("55P03"), "lock_timeout"],
    ["SQLSTATE 55P03 on the outer transaction error", () => outer({ code: "55P03" }), "lock_timeout"],
    ["SQLSTATE 57014 from the driver", () => sqlError("57014"), "statement_timeout"],
    ["SQLSTATE 57014 on the outer transaction error", () => outer({ code: "57014" }), "statement_timeout"],
    ["SQLSTATE 40001", () => outer({ code: "40001" }), "serialization_failure"],
    ["SQLSTATE 40P01", () => sqlError("40P01"), "deadlock"],
    ["another SQLSTATE (23505)", () => sqlError("23505"), "database_failure"],
    ["the outer transaction error with no SQLSTATE at all", () => outer(), "database_failure"],
    ["the outer transaction error whose code is a Node code, not a SQLSTATE", () => outer({ code: "ECONNRESET" }), "database_failure"],
    ["a Node error code on an ordinary error", () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), "dependency_failure"],
    // FIVE upper-case characters, exactly the length of a SQLSTATE — and not one. A classifier that
    // tests only "five characters of [0-9A-Z]" reports a broken pipe as a database failure.
    ["a five-character Node code (EPIPE) on an ordinary error", () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" }), "dependency_failure"],
    ["a five-character Node code (EPERM) on an ordinary error", () => Object.assign(new Error("operation not permitted"), { code: "EPERM" }), "dependency_failure"],
    ["a five-character Node code (EBUSY) on an ordinary error", () => Object.assign(new Error("resource busy"), { code: "EBUSY" }), "dependency_failure"],
    // …while the same code on the shared transaction error is that error type, by rung 7's second clause.
    ["the outer transaction error whose code is EPIPE", () => outer({ code: "EPIPE" }), "database_failure"],
    ["an ordinary dependency exception", () => new Error(`dependency failed: ${CANARY.metadata}`), "dependency_failure"],
    ["a thrown string", () => CANARY.token, "dependency_failure"],
    ["a thrown null", () => null, "dependency_failure"],
  ])("classifies %s", (_label, make, expected) => {
    const result = classifySlackKnownRootPreparationFailure(make());
    expect(result).toBe(expected);
  });

  it("puts an unknown commit above everything a provisional callback result or a SQLSTATE says", () => {
    // The callback returned `enqueued`, the commit acknowledgement was lost, and the lost connection
    // surfaced a retryable code: still exactly one thing is known, and it is that nothing is.
    const cause = Object.assign(new Error(CANARY.sql), { code: "40001", provisional: { outcome: "enqueued" } });
    const error = Object.assign(outer({ unknownCommit: true, code: "40001", cause }), { result: { outcome: "enqueued" } });
    expect(classifySlackKnownRootPreparationFailure(error)).toBe("commit_unknown");
    // The marker must be TRUE: a false one is an ordinary transaction error with that code.
    expect(classifySlackKnownRootPreparationFailure(outer({ unknownCommit: false, code: "40001" }))).toBe("serialization_failure");
  });

  it("never looks inside a cause: only the final rejection's own marker and code count", () => {
    const hidden = outer({ cause: Object.assign(new Error("inner"), { code: "55P03", unknownCommit: true }) });
    expect(classifySlackKnownRootPreparationFailure(hidden)).toBe("database_failure");
    const wrapped = new Error("wrapper", { cause: new SlackKnownRootDeadlineError() });
    expect(classifySlackKnownRootPreparationFailure(wrapped)).toBe("dependency_failure");
  });

  it("returns a bare category for every input: no object, message, SQL, identifier or cause travels with it", () => {
    const inputs: unknown[] = [
      outer({ unknownCommit: true, code: "40001", cause: new Error(CANARY.ciphertext) }),
      outer({ code: "57014", cause: Object.assign(new Error(CANARY.sql), { detail: CANARY.fingerprint }) }),
      Object.assign(new Error(CANARY.token), { code: "55P03", sql: CANARY.sql, where: CANARY.metadata }),
      Object.assign(new SlackKnownRootDeadlineError(), { detail: CANARY.metadata }),
      new Error(CANARY.fingerprint),
      { message: CANARY.ciphertext, code: CANARY.metadata },
      CANARY.token,
    ];
    const seen = new Set<string>();
    for (const input of inputs) {
      const result: unknown = classifySlackKnownRootPreparationFailure(input);
      expect(typeof result).toBe("string");
      expect(SLACK_KNOWN_ROOT_FAILURE_CATEGORIES as readonly string[]).toContain(result);
      expectNoCanary(result, "classifier output");
      seen.add(result as string);
    }
    // Not one answer for everything: these seven inputs span five different categories.
    expect([...seen].sort()).toEqual(["commit_unknown", "deadline_exceeded", "dependency_failure", "lock_timeout", "statement_timeout"]);
  });

  it("fails safely on a malformed error: a throwing accessor exposes nothing and classifies as a dependency failure (control)", () => {
    // CONTROL — passes against the stub, which inspects nothing. It pins that inspection, once it
    // exists, neither throws the object's content nor lets a hostile getter choose the category.
    const hostile = new Proxy({}, {
      get: () => { throw new Error(CANARY.metadata); },
      has: () => { throw new Error(CANARY.metadata); },
      getPrototypeOf: () => { throw new Error(CANARY.metadata); },
    });
    const accessor = Object.defineProperties(new Error("x"), {
      code: { get: () => { throw new Error(CANARY.sql); } },
      unknownCommit: { get: () => { throw new Error(CANARY.token); } },
    });
    for (const input of [hostile, accessor, Object.create(null), Symbol("x"), 42, undefined]) {
      let result: unknown;
      expect(() => { result = classifySlackKnownRootPreparationFailure(input); }).not.toThrow();
      expect(result).toBe("dependency_failure");
    }
  });
});

// ── §8.2 and §8.3: the pure page tally reducer ───────────────────────────────

describe("known-root page tally — one contribution per page slot", () => {
  const committed = (entryIndex: number, result: SlackKnownRootPreparationResult, attempts: 1 | 2 = 1): SlackKnownRootReceipt =>
    ({ entryIndex, state: "committed", attempts, result });
  const failed = (entryIndex: number, failure: (typeof SLACK_KNOWN_ROOT_FAILURE_CATEGORIES)[number], attempts: 0 | 1 | 2 = 1): SlackKnownRootReceipt =>
    ({ entryIndex, state: "failed", attempts, failure });
  const notAttempted = (entryIndex: number): SlackKnownRootReceipt => ({ entryIndex, state: "not_attempted", attempts: 0 });

  const PARENTS = ["enqueued", "already_pending", "not_due", "unattested", "refused", "preparation_failed", "not_attempted"] as const;
  const sum = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((a, b) => a + b, 0);

  /** The accounting identities of §8.2, checked on the exported reducer's own output. */
  function expectClosed(tally: SlackKnownRootPageTally): void {
    expect(PARENTS.reduce((total, key) => total + tally[key], 0), "examined is the sum of the seven parents").toBe(tally.examined);
    expect(sum(tally.failureCounts), "failure categories sum to preparation_failed").toBe(tally.preparation_failed);
    expect(sum(tally.unattestedCounts), "unattested reasons sum to unattested").toBe(tally.unattested);
    expect(sum(tally.refusedCounts), "refused reasons sum to refused").toBe(tally.refused);
    expect(Object.keys(tally.failureCounts).sort()).toEqual([...SLACK_KNOWN_ROOT_FAILURE_CATEGORIES].sort());
    expect(Object.keys(tally.unattestedCounts).sort()).toEqual([...SLACK_KNOWN_ROOT_UNATTESTED_REASONS].sort());
    expect(Object.keys(tally.refusedCounts).sort()).toEqual([...SLACK_KNOWN_ROOT_REFUSED_REASONS].sort());
    for (const value of [...PARENTS.map((key) => tally[key]), tally.examined]) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
  }

  it("counts every outcome of one page exactly once", () => {
    const tally = tallySlackKnownRootPage({
      examined: 9,
      receipts: [
        committed(0, { outcome: "enqueued" }),
        committed(1, { outcome: "already_pending" }),
        committed(2, { outcome: "not_due" }),
        committed(3, { outcome: "unattested", reason: "not_slack" }),
        committed(4, { outcome: "unattested", reason: "contradictory_ledger" }),
        committed(5, { outcome: "refused", reason: "binding_changed" }),
        failed(6, "lock_timeout"),
        failed(7, "commit_unknown"),
        notAttempted(8),
      ],
    });
    expect(tally).toMatchObject({
      examined: 9, enqueued: 1, already_pending: 1, not_due: 1, unattested: 2, refused: 1, preparation_failed: 2, not_attempted: 1,
    });
    expect(tally.unattestedCounts).toMatchObject({ not_slack: 1, contradictory_ledger: 1, item_missing: 0 });
    expect(tally.refusedCounts).toMatchObject({ binding_changed: 1, source_not_current: 0 });
    expect(tally.failureCounts).toMatchObject({ lock_timeout: 1, commit_unknown: 1, deadlock: 0 });
    expectClosed(tally);
  });

  it("counts a slot once however many attempts its transaction took", () => {
    // Attempt 1 rolled back and attempt 2 committed: one success. Both attempts failed: one failure.
    const tally = tallySlackKnownRootPage({
      examined: 2,
      receipts: [committed(0, { outcome: "enqueued" }, 2), failed(1, "serialization_failure", 2)],
    });
    expect(tally).toMatchObject({ examined: 2, enqueued: 1, preparation_failed: 1, not_attempted: 0 });
    expect(tally.failureCounts.serialization_failure).toBe(1);
    expectClosed(tally);
  });

  it.each([0, 1, 2] as const)("accepts a FAILED receipt with %d attempts: setup can fail before any callback runs", (attempts) => {
    const tally = tallySlackKnownRootPage({ examined: 1, receipts: [failed(0, "database_failure", attempts)] });
    expect(tally).toMatchObject({ examined: 1, preparation_failed: 1, enqueued: 0, not_attempted: 0 });
    expect(tally.failureCounts.database_failure).toBe(1);
    expectClosed(tally);
  });

  it("never counts an unknown commit as the insertion its callback reported", () => {
    const tally = tallySlackKnownRootPage({ examined: 1, receipts: [failed(0, "commit_unknown", 1)] });
    expect(tally).toMatchObject({ examined: 1, enqueued: 0, preparation_failed: 1 });
    expect(tally.failureCounts.commit_unknown).toBe(1);
    expectClosed(tally);
  });

  it("collapses an exact duplicate of a slot's final receipt", () => {
    const once = tallySlackKnownRootPage({ examined: 2, receipts: [committed(0, { outcome: "enqueued" }, 2), failed(1, "deadlock")] });
    const twice = tallySlackKnownRootPage({
      examined: 2,
      receipts: [
        committed(0, { outcome: "enqueued" }, 2), failed(1, "deadlock"),
        committed(0, { outcome: "enqueued" }, 2), failed(1, "deadlock"), failed(1, "deadlock"),
      ],
    });
    expect(once).toMatchObject({ examined: 2, enqueued: 1, preparation_failed: 1 });
    expect(twice).toEqual(once);
    expectClosed(twice);
  });

  it("counts a slot nobody started exactly once, as not attempted", () => {
    const tally = tallySlackKnownRootPage({
      examined: 3, receipts: [committed(0, { outcome: "not_due" }), notAttempted(1), notAttempted(2), notAttempted(2)],
    });
    expect(tally).toMatchObject({ examined: 3, not_due: 1, not_attempted: 2, preparation_failed: 0 });
    expectClosed(tally);
  });

  it("tallies an empty page, and a full one of a hundred slots", () => {
    const empty = tallySlackKnownRootPage({ examined: 0, receipts: [] });
    expect(empty).toMatchObject({ examined: 0, enqueued: 0, not_attempted: 0, preparation_failed: 0 });
    expectClosed(empty);
    const full = tallySlackKnownRootPage({
      examined: 100, receipts: Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? committed(index, { outcome: "enqueued" }) : notAttempted(index))),
    });
    expect(full).toMatchObject({ examined: 100, enqueued: 50, not_attempted: 50 });
    expectClosed(full);
  });

  it.each<[string, number, unknown[]]>([
    ["two conflicting receipts for one slot (committed and failed)", 1, [committed(0, { outcome: "enqueued" }), failed(0, "commit_unknown")]],
    ["two conflicting receipts for one slot (different results)", 1, [committed(0, { outcome: "enqueued" }), committed(0, { outcome: "already_pending" })]],
    ["the same result reported under different attempt counts", 1, [committed(0, { outcome: "enqueued" }, 1), committed(0, { outcome: "enqueued" }, 2)]],
    ["a started slot also reported as not attempted", 1, [failed(0, "deadlock"), notAttempted(0)]],
    ["a slot with no receipt", 2, [committed(0, { outcome: "enqueued" })]],
    ["an index past the page", 1, [committed(0, { outcome: "enqueued" }), committed(1, { outcome: "enqueued" })]],
    ["a negative index", 1, [committed(-1, { outcome: "enqueued" })]],
    ["a fractional index", 1, [committed(0.5, { outcome: "enqueued" })]],
    ["an examined count of 101", 101, Array.from({ length: 101 }, (_, index) => notAttempted(index))],
    ["a negative examined count", -1, []],
    ["a fractional examined count", 1.5, [notAttempted(0)]],
    ["a committed receipt with zero attempts", 1, [{ entryIndex: 0, state: "committed", attempts: 0, result: { outcome: "enqueued" } }]],
    ["a committed receipt with three attempts", 1, [{ entryIndex: 0, state: "committed", attempts: 3, result: { outcome: "enqueued" } }]],
    ["a failed receipt with three attempts", 1, [{ entryIndex: 0, state: "failed", attempts: 3, failure: "deadlock" }]],
    ["a not-attempted receipt that claims an attempt", 1, [{ entryIndex: 0, state: "not_attempted", attempts: 1 }]],
    ["a failure outside the closed vocabulary", 1, [{ entryIndex: 0, state: "failed", attempts: 1, failure: CANARY.metadata }]],
    ["an outcome outside the closed vocabulary", 1, [{ entryIndex: 0, state: "committed", attempts: 1, result: { outcome: CANARY.metadata } }]],
    ["an unattested result with a refusal's reason", 1, [{ entryIndex: 0, state: "committed", attempts: 1, result: { outcome: "unattested", reason: "binding_changed" } }]],
    ["a refusal with no reason", 1, [{ entryIndex: 0, state: "committed", attempts: 1, result: { outcome: "refused" } }]],
    ["an enqueued result carrying a reason", 1, [{ entryIndex: 0, state: "committed", attempts: 1, result: { outcome: "enqueued", reason: "not_slack" } }]],
    ["a provisional callback result that never reached a commit", 1, [{ entryIndex: 0, state: "provisional", attempts: 1, result: { outcome: "enqueued" } }]],
    ["a per-attempt record instead of a final receipt", 1, [{ entryIndex: 0, attempt: 1, state: "failed", attempts: 1, failure: "serialization_failure" }]],
    ["a committed receipt that also names a failure", 1, [{ entryIndex: 0, state: "committed", attempts: 1, result: { outcome: "enqueued" }, failure: "commit_unknown" }]],
    ["a `{ ok: false }` result", 1, [{ entryIndex: 0, state: "committed", attempts: 1, result: { ok: false, error: CANARY.sql } }]],
    ["a receipt that is not an object", 1, [CANARY.token]],
    ["receipts that are not an array", 1, [] as unknown[]],
  ])("refuses %s with a static contract error, and chooses nothing", (label, examined, receipts) => {
    const input = label === "receipts that are not an array" ? { examined, receipts: CANARY.token } : { examined, receipts };
    const error = thrown(() => tallySlackKnownRootPage(input as never));
    expectStaticValidationError(error, label);
  });

  it("returns counters only: no receipt, item id, cursor or error, and nothing a receipt carried", () => {
    const receipts = [
      { ...committed(0, { outcome: "enqueued" }), itemId: ITEM, note: CANARY.metadata },
      { ...failed(1, "database_failure"), error: new Error(CANARY.sql), sql: CANARY.sql },
    ];
    // Extra fields on a receipt are a contract error; a clean page of the same two slots is counted.
    expectStaticValidationError(thrown(() => tallySlackKnownRootPage({ examined: 2, receipts } as never)), "receipts carrying extra fields");
    const tally = tallySlackKnownRootPage({ examined: 2, receipts: [committed(0, { outcome: "enqueued" }), failed(1, "database_failure")] });
    expect(Object.keys(tally).sort()).toEqual([
      "already_pending", "enqueued", "examined", "failureCounts", "not_attempted", "not_due", "preparation_failed",
      "refused", "refusedCounts", "unattested", "unattestedCounts",
    ]);
    expect(JSON.stringify(tally)).not.toContain(ITEM);
    expectNoCanary(tally, "tally output");
    expectClosed(tally);
  });

  it("copies its input: a caller changing the receipts afterwards changes no tally already returned", () => {
    const receipts: SlackKnownRootReceipt[] = [committed(0, { outcome: "enqueued" }), notAttempted(1)];
    const tally = tallySlackKnownRootPage({ examined: 2, receipts });
    const before = JSON.stringify(tally);
    receipts[1] = failed(1, "deadlock");
    receipts.push(committed(0, { outcome: "refused", reason: "binding_changed" }));
    expect(JSON.stringify(tally)).toBe(before);
    expect(tally).toMatchObject({ examined: 2, enqueued: 1, not_attempted: 1 });
  });
});
