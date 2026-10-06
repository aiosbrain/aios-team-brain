import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { PersonDay, TaskGroup, TimelineDay } from "@/lib/dashboard/timeline-group";

/**
 * AIO-1170 AC-09 — the PURE continuation contract (`lib/dashboard/slack-timeline-page-contract.ts`).
 *
 * One Slack aggregate is `(item, member, UTC day)`. A page of them is resumed through an opaque,
 * authenticated, snapshot-bound cursor, and a page is only ever a whole answer or one of four named
 * failures. These tests pin every place a plausible shortcut would turn "a page" into "a claim":
 * a tampered or re-keyed token being believed, a cursor outliving its fifteen minutes, an old
 * continuation surviving a new window, a terminal flag disagreeing with its cursor, a composer
 * inventing or dropping evidence, a merge conflict surfacing as a raw English error.
 *
 * The module is loaded per test through a non-literal specifier, deliberately. A static import of a
 * file that does not exist yet fails the whole file at link time; this way every case fails on its
 * own, by name, at the missing-module boundary.
 */

const REPO = join(import.meta.dirname, "..");
const CONTRACT_FILE = "lib/dashboard/slack-timeline-page-contract.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the module under test does not exist yet
type Loose = Record<string, any>;
type Json = Record<string, unknown>;

async function contract(): Promise<Loose> {
  return (await import(/* @vite-ignore */ join(REPO, CONTRACT_FILE))) as Loose;
}

type FailureCode = "invalid_request" | "restart_required" | "unavailable" | "budget_exhausted";

/** Run something that must fail with one of the four contract failures, and say which. */
async function failureOf(run: () => unknown): Promise<{ name: string; code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    const e = error as { name?: unknown; code?: unknown; message?: unknown };
    return { name: String(e?.name), code: String(e?.code), message: String(e?.message) };
  }
  throw new Error("expected a Slack timeline failure, but the call succeeded");
}

async function expectFailure(run: () => unknown, code: FailureCode): Promise<void> {
  expect(await failureOf(run)).toMatchObject({ name: "SlackTimelineError", code });
}

// Every fixture UUID carries hexadecimal LETTERS, so an "uppercase" mutation is a different string.
// A digits-only UUID would make the uppercase negative identical to the valid payload (red review,
// finding 1); the fixture control beside the malformed-payload table asserts this for all of them.
const TEAM = "1a1b1c1d-1111-4111-8111-1111abcdef11";
const OTHER_TEAM = "9f9e9d9c-9999-4999-8999-9999fedcba99";
const ITEM_A = "0a000000-0000-4000-8000-000000000001";
const ITEM_B = "0b000000-0000-4000-8000-000000000002";
const MEMBER_A = "a0000000-0000-4000-8000-00000000000a";
const MEMBER_B = "b0000000-0000-4000-8000-00000000000b";
const PRINCIPAL = `member:${MEMBER_A}`;
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
const AAD = "aios/slack-timeline-cursor/v1";
const AS_OF_MS = Date.parse("2024-06-21T12:00:00.000Z");
const DAY_MS = 86_400_000;
const TTL_MS = 900_000;
const hex = (seed: string): string => createHash("sha256").update(seed).digest("hex");

function ms(value: number): string {
  return new Date(value).toISOString();
}

function tuple(over: Json = {}): Json {
  return { day: "2024-06-20", at: "2024-06-20T16:13:20.000100Z", itemId: ITEM_A, memberId: MEMBER_A, ...over };
}

/** A complete, valid binding for a seven-day window pinned at AS_OF. */
function binding(over: Json = {}): Json {
  return {
    schemaVersion: 1,
    teamId: TEAM,
    principalKey: PRINCIPAL,
    viewKey: hex("view"),
    admissionBindingDigest: hex("admission"),
    sourceAdmissionBindingDigest: hex("source-admission"),
    authorizedSlackItemFingerprint: hex("items"),
    windowDays: 7,
    since: ms(AS_OF_MS - 7 * DAY_MS),
    asOf: ms(AS_OF_MS),
    issuedAt: ms(AS_OF_MS),
    expiresAt: ms(AS_OF_MS + TTL_MS),
    pageSize: 2,
    dataGeneration: "4",
    identityGeneration: "5",
    presentationGeneration: "6",
    creditInputDigest: hex("credit"),
    presentationInputDigest: hex("presentation"),
    ...over,
  };
}

function payload(over: Json = {}): Json {
  return { ...binding(), lastAggregateTuple: tuple(), ...over };
}

/**
 * The wire form, pinned here so the strict-schema negatives below are REAL authenticated tokens:
 * base64url( 0x01 version | 12-byte nonce | AES-256-GCM ciphertext | 16-byte tag ), AAD fixed,
 * plaintext the UTF-8 JSON payload.
 */
function seal(value: unknown, key: Buffer = KEY, version = 1): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(AAD, "utf8"));
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const body = Buffer.concat([cipher.update(Buffer.from(text, "utf8")), cipher.final()]);
  return Buffer.concat([Buffer.from([version]), nonce, body, cipher.getAuthTag()]).toString("base64url");
}

// ── timeline fixtures ────────────────────────────────────────────────────────

function slackItem(id: string, at: string, over: Json = {}): Json {
  return { id, title: "Thread in #general", source: "slack", kind: "thread", at, ...over };
}

function person(memberId: string, over: Partial<PersonDay> = {}): PersonDay {
  return {
    memberId, name: `Person ${memberId.slice(0, 2)}`, handle: `h-${memberId.slice(0, 2)}`, avatarUrl: null,
    total: 0, unlinked: 0, tasks: [], other: [], signals: [], ...over,
  };
}

function slackGroup(items: Json[]): { source: string; count: number; items: never[] } {
  return { source: "slack", count: items.length, items: items as never[] };
}

function task(taskId: string, items: Json[], over: Partial<TaskGroup> = {}): TaskGroup {
  return {
    taskId, title: `Task ${taskId}`, status: "in_progress", source: "linear",
    sources: [slackGroup(items)], evidenceCount: items.length, ...over,
  };
}

function day(date: string, people: PersonDay[], label = `label ${date}`): TimelineDay {
  return { date, label, people };
}

function aggregate(itemId: string, memberId: string, at: string, over: Json = {}): Json {
  const dayOf = at.slice(0, 10);
  return {
    id: JSON.stringify([itemId, memberId, dayOf]), sourceItemId: itemId, workspaceId: "TPAGE", channelId: "CPAGE",
    rootTs: "1718900000.000100", memberId, day: dayOf, at, messageCount: 1, rootAuthored: false,
    linkMessage: { messageTs: "1718900000.000100", occurredAt: at }, ...over,
  };
}

describe("Slack timeline page contract — published constants", () => {
  it("publishes the fixed cursor, window and page-size policy the specification names", async () => {
    const c = await contract();
    expect(c.SLACK_TIMELINE_CURSOR).toMatchObject({
      schemaVersion: 1, aad: AAD, maxEncodedBytes: 16 * 1024, ttlMs: TTL_MS, keyBytes: 32, nonceBytes: 12, tagBytes: 16,
    });
    expect([...c.SLACK_TIMELINE_WINDOW_DAYS]).toEqual([7, 14, 21, 28, 30]);
    expect(c.SLACK_TIMELINE_PAGE_SIZE).toMatchObject({ min: 1, max: 512, default: 128 });
  });

  it("names its four failures through one error type and nothing else", async () => {
    const c = await contract();
    for (const code of ["invalid_request", "restart_required", "unavailable", "budget_exhausted"]) {
      const error = new c.SlackTimelineError(code, "reason");
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: "SlackTimelineError", code });
    }
    expect(() => new c.SlackTimelineError("partial", "reason")).toThrow();
  });
});

describe("Slack timeline page contract — canonical digests", () => {
  it("binds canonical bytes, not key or iteration order", async () => {
    const c = await contract();
    const a = { b: 1, a: { d: [3, 1, 2], c: null } };
    const b = { a: { c: null, d: [3, 1, 2] }, b: 1 };
    expect(c.canonicalSlackTimelineJson(a)).toBe(c.canonicalSlackTimelineJson(b));
    expect(c.slackTimelineDigest(a)).toBe(c.slackTimelineDigest(b));
    expect(c.slackTimelineDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(c.slackTimelineDigest(a)).toBe(hex(c.canonicalSlackTimelineJson(a)));
  });

  it("keeps null distinct from absent and array order significant", async () => {
    const c = await contract();
    expect(c.slackTimelineDigest({ a: null })).not.toBe(c.slackTimelineDigest({}));
    expect(c.slackTimelineDigest({ a: [1, 2] })).not.toBe(c.slackTimelineDigest({ a: [2, 1] }));
    expect(c.slackTimelineDigest({ a: "1" })).not.toBe(c.slackTimelineDigest({ a: 1 }));
  });

  it.each([
    ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["a bigint", BigInt(1)],
    ["a Date", new Date(0)], ["a Map", new Map()], ["a function", () => 1],
  ])("refuses a value that is not JSON-safe (%s) instead of hashing a lossy rendering", async (_label, value) => {
    const c = await contract();
    await expectFailure(() => c.slackTimelineDigest({ value }), "unavailable");
  });

  it("fingerprints the authorized Slack item set independent of order, case and duplicates-free input", async () => {
    const c = await contract();
    const one = c.slackItemFingerprint([ITEM_B, ITEM_A]);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(c.slackItemFingerprint([ITEM_A, ITEM_B])).toBe(one);
    expect(c.slackItemFingerprint([ITEM_A.toUpperCase(), ITEM_B])).toBe(one);
    expect(c.slackItemFingerprint(new Set([ITEM_A, ITEM_B]))).toBe(one);
    expect(c.slackItemFingerprint([ITEM_A])).not.toBe(one);
    expect(c.slackItemFingerprint([])).not.toBe(one);
    await expectFailure(() => c.slackItemFingerprint([ITEM_A, ITEM_A]), "unavailable");
    await expectFailure(() => c.slackItemFingerprint(["not-a-uuid"]), "unavailable");
  });

  it("keeps a huge admission or proof inventory fixed-size by digest", async () => {
    const c = await contract();
    const grants = Array.from({ length: 20_000 }, (_, n) => ({ projectId: hex(`p${n}`), proof: hex(`proof${n}`) }));
    const digest = c.slackTimelineDigest({ grants });
    expect(digest).toHaveLength(64);
    const token = c.encodeSlackTimelineCursor(payload({ admissionBindingDigest: digest }), KEY);
    expect(token.length).toBeLessThan(2048);
  });

  it("derives the view key server-side from the complete logical view, never from a caller string", async () => {
    const c = await contract();
    const view = {
      teamId: TEAM, principalKey: PRINCIPAL, admissionKind: "member",
      view: { mode: "timeline", filters: { memberIds: [MEMBER_B, MEMBER_A] } },
      locale: "en-US", presentationPolicyVersion: "1",
    };
    const key = c.deriveSlackTimelineViewKey(view);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(c.deriveSlackTimelineViewKey({ ...view, view: { filters: { memberIds: [MEMBER_B, MEMBER_A] }, mode: "timeline" } })).toBe(key);
    for (const changed of [
      { ...view, teamId: OTHER_TEAM },
      { ...view, principalKey: `member:${MEMBER_B}` },
      { ...view, admissionKind: "legacy" },
      { ...view, view: { mode: "expanded", filters: view.view.filters } },
      { ...view, view: { mode: "timeline", filters: { memberIds: [MEMBER_A] } } },
      { ...view, locale: "de-DE" },
      { ...view, presentationPolicyVersion: "2" },
    ]) expect(c.deriveSlackTimelineViewKey(changed)).not.toBe(key);
    for (const missing of ["teamId", "principalKey", "admissionKind", "view", "locale", "presentationPolicyVersion"]) {
      const partial: Json = { ...view };
      delete partial[missing];
      await expectFailure(() => c.deriveSlackTimelineViewKey(partial), "unavailable");
    }
  });
});

describe("Slack timeline page contract — window and TTL", () => {
  it("pins asOf to the initial clock, since to exactly windowDays earlier, and expiry to fifteen minutes", async () => {
    const c = await contract();
    const now = new Date(AS_OF_MS);
    const window = c.slackTimelineWindow(now, 7);
    now.setUTCFullYear(2031); // the caller's Date is copied before use
    expect(window).toEqual({
      windowDays: 7, since: ms(AS_OF_MS - 7 * DAY_MS), asOf: ms(AS_OF_MS), issuedAt: ms(AS_OF_MS), expiresAt: ms(AS_OF_MS + TTL_MS),
    });
    for (const days of [14, 21, 28, 30]) {
      expect(c.slackTimelineWindow(new Date(AS_OF_MS), days).since).toBe(ms(AS_OF_MS - days * DAY_MS));
    }
  });

  it.each([0, 1, 6, 8, 29, 31, 7.5, -7, Number.NaN, "7", null, undefined])(
    "refuses window %s as an invalid request",
    async (days) => {
      const c = await contract();
      await expectFailure(() => c.slackTimelineWindow(new Date(AS_OF_MS), days), "invalid_request");
    }
  );

  it("refuses a clock it cannot do safe arithmetic on", async () => {
    const c = await contract();
    await expectFailure(() => c.slackTimelineWindow(new Date(Number.NaN), 7), "unavailable");
    await expectFailure(() => c.slackTimelineWindow("2024-06-21T12:00:00.000Z", 7), "unavailable");
    // The largest representable Date leaves no room for a fifteen-minute expiry.
    await expectFailure(() => c.slackTimelineWindow(new Date(8_640_000_000_000_000), 7), "unavailable");
  });

  it("requires restart exactly at expiry and never slides it", async () => {
    const c = await contract();
    const p = payload();
    expect(() => c.assertSlackTimelineCursorFresh(p, new Date(AS_OF_MS))).not.toThrow();
    expect(() => c.assertSlackTimelineCursorFresh(p, new Date(AS_OF_MS + TTL_MS - 1))).not.toThrow();
    await expectFailure(() => c.assertSlackTimelineCursorFresh(p, new Date(AS_OF_MS + TTL_MS)), "restart_required");
    await expectFailure(() => c.assertSlackTimelineCursorFresh(p, new Date(AS_OF_MS + TTL_MS + 1)), "restart_required");
    // A replay does not extend the lifetime: the same payload a moment before expiry is still bound
    // to the same expiresAt afterwards.
    const replayed = c.decodeSlackTimelineCursor(c.encodeSlackTimelineCursor(p, KEY), KEY);
    expect(replayed.expiresAt).toBe(ms(AS_OF_MS + TTL_MS));
    await expectFailure(() => c.assertSlackTimelineCursorFresh(replayed, new Date(AS_OF_MS + TTL_MS)), "restart_required");
  });

  it("refuses a cursor issued in the future, with zero tolerated skew, as an invalid request", async () => {
    const c = await contract();
    await expectFailure(() => c.assertSlackTimelineCursorFresh(payload(), new Date(AS_OF_MS - 1)), "invalid_request");
    // Backward wall-clock movement before issuedAt is the same condition at publication time.
    await expectFailure(() => c.assertSlackTimelineCursorFresh(payload(), new Date(AS_OF_MS - 60_000)), "invalid_request");
    await expectFailure(() => c.assertSlackTimelineCursorFresh(payload(), new Date(Number.NaN)), "unavailable");
  });
});

describe("Slack timeline page contract — authenticated cursor", () => {
  it("round-trips the complete binding and last tuple through an opaque token", async () => {
    const c = await contract();
    const token = c.encodeSlackTimelineCursor(payload(), KEY);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.byteLength(token, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(c.decodeSlackTimelineCursor(token, KEY)).toEqual(payload());
    // Nothing of the binding is readable from the wire form.
    const wire = Buffer.from(token, "base64url").toString("latin1");
    for (const secret of [TEAM, PRINCIPAL, ITEM_A, MEMBER_A, "2024-06-20"]) expect(wire).not.toContain(secret);
    expect(token).not.toContain(Buffer.from(TEAM).toString("base64url").slice(0, 16));
  });

  it("uses the pinned wire form: version, 12-byte nonce, ciphertext, 16-byte tag, fixed AAD", async () => {
    const c = await contract();
    // A token sealed by this test with the runtime crypto library is accepted…
    expect(c.decodeSlackTimelineCursor(seal(payload()), KEY)).toEqual(payload());
    // …and the module's own token has exactly that framing.
    const raw = Buffer.from(c.encodeSlackTimelineCursor(payload(), KEY), "base64url");
    expect(raw[0]).toBe(1);
    expect(raw.length).toBeGreaterThan(1 + 12 + 16);
  });

  it("uses a fresh nonce per encoding, so progress is never judged by ciphertext equality", async () => {
    const c = await contract();
    const tokens = new Set(Array.from({ length: 16 }, () => c.encodeSlackTimelineCursor(payload(), KEY)));
    expect(tokens.size).toBe(16);
    const nonces = new Set([...tokens].map((t) => Buffer.from(t, "base64url").subarray(1, 13).toString("hex")));
    expect(nonces.size).toBe(16);
    for (const token of tokens) expect(c.decodeSlackTimelineCursor(token, KEY)).toEqual(payload());
  });

  it("rejects ANY flipped byte — version, nonce, ciphertext or tag — as an invalid request", async () => {
    const c = await contract();
    const raw = Buffer.from(c.encodeSlackTimelineCursor(payload(), KEY), "base64url");
    for (let index = 0; index < raw.length; index++) {
      const tampered = Buffer.from(raw);
      tampered[index] ^= 0x01;
      await expectFailure(() => c.decodeSlackTimelineCursor(tampered.toString("base64url"), KEY), "invalid_request");
    }
  });

  it("rejects truncation, extension, re-keying and a foreign AAD as invalid requests", async () => {
    const c = await contract();
    const token = c.encodeSlackTimelineCursor(payload(), KEY);
    const raw = Buffer.from(token, "base64url");
    await expectFailure(() => c.decodeSlackTimelineCursor(raw.subarray(0, raw.length - 1).toString("base64url"), KEY), "invalid_request");
    await expectFailure(() => c.decodeSlackTimelineCursor(Buffer.concat([raw, Buffer.from([0])]).toString("base64url"), KEY), "invalid_request");
    await expectFailure(() => c.decodeSlackTimelineCursor(raw.subarray(0, 20).toString("base64url"), KEY), "invalid_request");
    // Key rotation cannot establish the token's former binding.
    await expectFailure(() => c.decodeSlackTimelineCursor(token, OTHER_KEY), "invalid_request");
    // Same key, same payload, different associated data.
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
    cipher.setAAD(Buffer.from("aios/slack-timeline-cursor/v2", "utf8"));
    const body = Buffer.concat([cipher.update(JSON.stringify(payload()), "utf8"), cipher.final()]);
    const foreign = Buffer.concat([Buffer.from([1]), nonce, body, cipher.getAuthTag()]).toString("base64url");
    await expectFailure(() => c.decodeSlackTimelineCursor(foreign, KEY), "invalid_request");
    // An authentic body under an unsupported wire version.
    await expectFailure(() => c.decodeSlackTimelineCursor(seal(payload(), KEY, 2), KEY), "invalid_request");
  });

  it.each([
    ["empty", ""], ["not base64url", "a+b/c=="], ["whitespace", " abc "], ["a number", 7], ["null", null],
    ["undefined", undefined], ["an object", {}],
  ])("rejects a malformed token (%s) before any decryption", async (_label, token) => {
    const c = await contract();
    await expectFailure(() => c.decodeSlackTimelineCursor(token, KEY), "invalid_request");
  });

  it("rejects an oversized untrusted token as invalid, and refuses to ENCODE one as budget exhaustion", async () => {
    const c = await contract();
    await expectFailure(() => c.decodeSlackTimelineCursor("A".repeat(16 * 1024 + 1), KEY), "invalid_request");
    // An authentic token over the bound is still refused on size, not trusted because it verifies.
    const huge = seal(payload({ principalKey: "p".repeat(20_000) }));
    expect(huge.length).toBeGreaterThan(16 * 1024);
    await expectFailure(() => c.decodeSlackTimelineCursor(huge, KEY), "invalid_request");
    // Encoding overflow yields no consumable page: budget_exhausted, never truncation.
    await expectFailure(() => c.encodeSlackTimelineCursor(payload({ principalKey: "p".repeat(20_000) }), KEY), "budget_exhausted");
  });

  it("treats a missing or wrong-length key as unavailable configuration, on both paths", async () => {
    const c = await contract();
    const token = c.encodeSlackTimelineCursor(payload(), KEY);
    for (const key of [undefined, null, "", Buffer.alloc(31, 1), Buffer.alloc(33, 1), "k".repeat(32), {}]) {
      await expectFailure(() => c.encodeSlackTimelineCursor(payload(), key), "unavailable");
      await expectFailure(() => c.decodeSlackTimelineCursor(token, key), "unavailable");
    }
  });

  it("never echoes key or payload material in a failure message", async () => {
    const c = await contract();
    const failures = [
      await failureOf(() => c.decodeSlackTimelineCursor(c.encodeSlackTimelineCursor(payload(), KEY), OTHER_KEY)),
      await failureOf(() => c.decodeSlackTimelineCursor(seal(payload({ teamId: "nope" })), KEY)),
      await failureOf(() => c.encodeSlackTimelineCursor(payload(), Buffer.alloc(31, 1))),
    ];
    for (const failure of failures) {
      for (const secret of [KEY.toString("hex"), KEY.toString("base64"), OTHER_KEY.toString("hex"), PRINCIPAL, ITEM_A, MEMBER_A]) {
        expect(failure.message).not.toContain(secret);
      }
    }
  });

  // Each of these is VALIDLY encrypted and authenticates; only strict validation refuses it.
  const MALFORMED: [string, unknown][] = [
    ["not JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a JSON null", "null"],
    ["schemaVersion 2", payload({ schemaVersion: 2 })],
    ["schemaVersion as a string", payload({ schemaVersion: "1" })],
    ["an unknown extra field", payload({ extra: true })],
    ["a missing digest", (() => { const p = payload(); delete p.creditInputDigest; return p; })()],
    ["a missing tuple", (() => { const p = payload(); delete p.lastAggregateTuple; return p; })()],
    ["an uppercase team UUID", payload({ teamId: TEAM.toUpperCase() })],
    ["a non-UUID team", payload({ teamId: "team" })],
    ["an empty principal", payload({ principalKey: "" })],
    ["a short digest", payload({ viewKey: "abc" })],
    ["an uppercase digest", payload({ admissionBindingDigest: hex("admission").toUpperCase() })],
    ["a numeric generation", payload({ dataGeneration: 4 })],
    ["a signed generation", payload({ identityGeneration: "-1" })],
    ["a zero-padded generation", payload({ presentationGeneration: "06" })],
    ["a window outside the allowed set", payload({ windowDays: 8, since: ms(AS_OF_MS - 8 * DAY_MS) })],
    ["a page size of zero", payload({ pageSize: 0 })],
    ["a page size of 513", payload({ pageSize: 513 })],
    ["a fractional page size", payload({ pageSize: 1.5 })],
    ["an asOf with microseconds", payload({ asOf: "2024-06-21T12:00:00.000000Z" })],
    ["an asOf without milliseconds", payload({ asOf: "2024-06-21T12:00:00Z" })],
    ["a non-UTC asOf", payload({ asOf: "2024-06-21T12:00:00.000+00:00" })],
    ["an impossible calendar instant", payload({ asOf: "2024-02-30T12:00:00.000Z", issuedAt: "2024-02-30T12:00:00.000Z" })],
    ["a since that is not asOf minus the window", payload({ since: ms(AS_OF_MS - 7 * DAY_MS + 1) })],
    ["an issuedAt that is not asOf", payload({ issuedAt: ms(AS_OF_MS + 1) })],
    ["an expiry that is not issuedAt plus fifteen minutes", payload({ expiresAt: ms(AS_OF_MS + TTL_MS + 1) })],
    ["a slid expiry", payload({ expiresAt: ms(AS_OF_MS + 2 * TTL_MS) })],
    // The last representable instant: its fifteen-minute expiry cannot be computed without overflow.
    ["an instant whose expiry arithmetic overflows", payload({
      asOf: "+275760-09-13T00:00:00.000Z", issuedAt: "+275760-09-13T00:00:00.000Z",
      since: "+275760-09-06T00:00:00.000Z", expiresAt: "+275760-09-13T00:15:00.000Z",
    })],
    ["a tuple day that is not a calendar day", payload({ lastAggregateTuple: tuple({ day: "2024-02-30", at: "2024-02-30T10:00:00.000000Z" }) })],
    ["a tuple day in the wrong shape", payload({ lastAggregateTuple: tuple({ day: "20240620" }) })],
    ["a tuple instant with millisecond precision", payload({ lastAggregateTuple: tuple({ at: "2024-06-20T16:13:20.000Z" }) })],
    ["a tuple instant on another day", payload({ lastAggregateTuple: tuple({ day: "2024-06-19" }) })],
    ["a tuple before the window", payload({ lastAggregateTuple: tuple({ day: "2024-06-14", at: "2024-06-14T11:59:59.999999Z" }) })],
    ["a tuple after asOf", payload({ lastAggregateTuple: tuple({ day: "2024-06-21", at: "2024-06-21T12:00:00.000001Z" }) })],
    ["a tuple with an uppercase item UUID", payload({ lastAggregateTuple: tuple({ itemId: ITEM_A.toUpperCase() }) })],
    ["a tuple with a non-UUID member", payload({ lastAggregateTuple: tuple({ memberId: "member" }) })],
    ["a tuple with an extra field", payload({ lastAggregateTuple: tuple({ rank: 1 }) })],
    ["a tuple that is an array", payload({ lastAggregateTuple: ["2024-06-20"] })],
  ];

  // A fixture control, deliberately independent of the module under test: it passes or fails on the
  // table alone. Without it a "malformed" row can be byte-identical to the valid payload, and the
  // decoder is then asked to accept and reject the same authenticated plaintext.
  it("fixture control: every malformed payload is a different plaintext from the valid one, and from each other", () => {
    const plaintext = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
    const valid = plaintext(payload());
    const seen = new Map<string, string>();
    for (const [label, value] of MALFORMED) {
      const text = plaintext(value);
      expect(text, `"${label}" must differ from the valid payload`).not.toBe(valid);
      expect(seen.get(text), `"${label}" duplicates another malformed fixture`).toBeUndefined();
      seen.set(text, label);
    }
    // The case-mutation rows specifically: each source value really has a letter to change.
    const uppercased: [string, string][] = [
      ["team UUID", TEAM], ["other team UUID", OTHER_TEAM], ["item UUID", ITEM_A], ["second item UUID", ITEM_B],
      ["member UUID", MEMBER_A], ["second member UUID", MEMBER_B], ["admission digest", hex("admission")],
    ];
    for (const [label, value] of uppercased) {
      expect(value.toUpperCase(), `${label} has no hexadecimal letter to uppercase`).not.toBe(value);
      expect(value, `${label} is canonical lowercase`).toBe(value.toLowerCase());
    }
    const byLabel = new Map(MALFORMED);
    expect((byLabel.get("an uppercase team UUID") as Json).teamId).toBe(TEAM.toUpperCase());
    expect((byLabel.get("an uppercase team UUID") as Json).teamId).not.toBe(payload().teamId);
    expect(((byLabel.get("a tuple with an uppercase item UUID") as Json).lastAggregateTuple as Json).itemId).not.toBe(ITEM_A);
    expect((byLabel.get("an uppercase digest") as Json).admissionBindingDigest).not.toBe(payload().admissionBindingDigest);
  });

  it.each(MALFORMED)("refuses an authentic token whose payload has %s", async (_label, value) => {
    const c = await contract();
    // The valid payload authenticates and decodes; this row differs from it only by its defect.
    expect(c.decodeSlackTimelineCursor(seal(payload()), KEY)).toEqual(payload());
    await expectFailure(() => c.decodeSlackTimelineCursor(seal(value), KEY), "invalid_request");
  });

  it("accepts tuples exactly on the inclusive window bounds", async () => {
    const c = await contract();
    const atSince = tuple({ day: "2024-06-14", at: "2024-06-14T12:00:00.000000Z" });
    const atAsOf = tuple({ day: "2024-06-21", at: "2024-06-21T12:00:00.000000Z" });
    for (const edge of [atSince, atAsOf]) {
      expect(c.decodeSlackTimelineCursor(seal(payload({ lastAggregateTuple: edge })), KEY).lastAggregateTuple).toEqual(edge);
    }
  });

  it("refuses to ENCODE a payload its own decoder would reject", async () => {
    const c = await contract();
    for (const bad of [payload({ pageSize: 0 }), payload({ expiresAt: ms(AS_OF_MS + 2 * TTL_MS) }), payload({ extra: 1 })]) {
      await expectFailure(() => c.encodeSlackTimelineCursor(bad, KEY), "unavailable");
    }
  });
});

describe("Slack timeline page contract — request and binding comparison", () => {
  const request = {
    teamId: TEAM, principalKey: PRINCIPAL, viewKey: hex("view"), windowDays: 7, pageSize: 2,
    authorizedSlackItemIds: new Set([ITEM_A, ITEM_B]),
  };

  it("accepts a cursor presented with the request it was issued for", async () => {
    const c = await contract();
    expect(() => c.assertSlackTimelineCursorRequest(payload(), request)).not.toThrow();
  });

  it.each([
    ["team", { teamId: OTHER_TEAM }],
    ["principal", { principalKey: `member:${MEMBER_B}` }],
    ["view", { viewKey: hex("another view") }],
    ["window", { windowDays: 14 }],
    ["page size", { pageSize: 3 }],
    ["authorized item set no longer holding the tuple's item", { authorizedSlackItemIds: new Set([ITEM_B]) }],
    ["empty authorized item set", { authorizedSlackItemIds: new Set<string>() }],
  ])("requires restart when the legitimate request's %s differs from the authenticated binding", async (_label, over) => {
    const c = await contract();
    await expectFailure(() => c.assertSlackTimelineCursorRequest(payload(), { ...request, ...over }), "restart_required");
  });

  it("treats every bound field as part of the snapshot: any change requires restart", async () => {
    const c = await contract();
    expect(() => c.assertSlackTimelineBindingUnchanged(binding(), binding())).not.toThrow();
    // The comparison is over bound values; an authenticated payload carries a tuple the binding does not.
    expect(() => c.assertSlackTimelineBindingUnchanged(binding(), payload())).not.toThrow();
    const changes: Json = {
      teamId: OTHER_TEAM, principalKey: `member:${MEMBER_B}`, viewKey: hex("v2"),
      admissionBindingDigest: hex("a2"), sourceAdmissionBindingDigest: hex("s2"),
      authorizedSlackItemFingerprint: hex("i2"), pageSize: 3,
      dataGeneration: "5", identityGeneration: "6", presentationGeneration: "7",
      creditInputDigest: hex("c2"), presentationInputDigest: hex("p2"),
    };
    for (const [field, value] of Object.entries(changes)) {
      await expectFailure(() => c.assertSlackTimelineBindingUnchanged(binding(), binding({ [field]: value })), "restart_required");
    }
    expect(Object.keys(changes).sort()).toEqual(
      Object.keys(binding()).filter((k) => !["schemaVersion", "windowDays", "since", "asOf", "issuedAt", "expiresAt"].includes(k)).sort()
    );
  });

  it("rejects an OLD continuation after the window or asOf was replaced (D5)", async () => {
    const c = await contract();
    const replacedWindow = binding({ windowDays: 14, since: ms(AS_OF_MS - 14 * DAY_MS) });
    const later = AS_OF_MS + 60_000;
    const replacedAsOf = binding({
      since: ms(later - 7 * DAY_MS), asOf: ms(later), issuedAt: ms(later), expiresAt: ms(later + TTL_MS),
    });
    await expectFailure(() => c.assertSlackTimelineBindingUnchanged(replacedWindow, payload()), "restart_required");
    await expectFailure(() => c.assertSlackTimelineBindingUnchanged(replacedAsOf, payload()), "restart_required");
    // A generation that merely moved FORWARD is still a different snapshot: no "newer is fine".
    await expectFailure(() => c.assertSlackTimelineBindingUnchanged(binding({ dataGeneration: "400" }), payload()), "restart_required");
  });

  it("refuses an incomplete binding on either side as unavailable, never as 'unchanged'", async () => {
    const c = await contract();
    const partial = binding();
    delete partial.creditInputDigest;
    await expectFailure(() => c.assertSlackTimelineBindingUnchanged(partial, binding()), "unavailable");
    await expectFailure(() => c.assertSlackTimelineBindingUnchanged(binding(), partial), "unavailable");
    await expectFailure(() => c.assertSlackTimelineBindingUnchanged(binding(), null), "unavailable");
  });
});

describe("Slack timeline page contract — aggregate order and compaction", () => {
  it("orders tuples by day DESC, instant DESC, item ASC, member ASC", async () => {
    const c = await contract();
    const ordered = [
      tuple({ day: "2024-06-21", at: "2024-06-21T00:00:00.000000Z" }),
      tuple({ day: "2024-06-20", at: "2024-06-20T23:59:59.999999Z", itemId: ITEM_B }),
      tuple({ day: "2024-06-20", at: "2024-06-20T16:13:20.000100Z", itemId: ITEM_A, memberId: MEMBER_A }),
      tuple({ day: "2024-06-20", at: "2024-06-20T16:13:20.000100Z", itemId: ITEM_A, memberId: MEMBER_B }),
      tuple({ day: "2024-06-20", at: "2024-06-20T16:13:20.000100Z", itemId: ITEM_B, memberId: MEMBER_A }),
      tuple({ day: "2024-06-20", at: "2024-06-20T16:13:20.000099Z", itemId: ITEM_A, memberId: MEMBER_A }),
      tuple({ day: "2024-06-19", at: "2024-06-19T23:00:00.000000Z" }),
    ];
    const shuffled = [ordered[4], ordered[6], ordered[0], ordered[3], ordered[5], ordered[1], ordered[2]];
    expect([...shuffled].sort(c.compareSlackAggregateTuples)).toEqual(ordered);
    for (let i = 0; i < ordered.length; i++) {
      expect(c.compareSlackAggregateTuples(ordered[i], ordered[i])).toBe(0);
      for (let j = i + 1; j < ordered.length; j++) {
        expect(c.compareSlackAggregateTuples(ordered[i], ordered[j])).toBeLessThan(0);
        expect(c.compareSlackAggregateTuples(ordered[j], ordered[i])).toBeGreaterThan(0);
      }
    }
  });

  function personDay(over: Json = {}): Json {
    return {
      id: JSON.stringify([ITEM_A, MEMBER_A, "2024-06-20"]), sourceItemId: ITEM_A, workspaceId: "TPAGE", channelId: "CPAGE",
      rootTs: "1718900000.000100", memberId: MEMBER_A, day: "2024-06-20", at: "2024-06-20T16:13:20.000300Z",
      messageCount: 3, rootAuthored: false,
      messages: [
        { messageTs: "1718900000.000200", occurredAt: "2024-06-20T16:13:20.000200Z" },
        { messageTs: "1718900000.000250", occurredAt: "2024-06-20T16:13:20.000250Z" },
        { messageTs: "1718900000.000300", occurredAt: "2024-06-20T16:13:20.000300Z" },
      ],
      ...over,
    };
  }

  it("projects the authoritative person-day to a compact record without its unbounded message list", async () => {
    const c = await contract();
    const compact = c.compactSlackAggregate(personDay());
    expect(compact).toEqual({
      id: JSON.stringify([ITEM_A, MEMBER_A, "2024-06-20"]), sourceItemId: ITEM_A, workspaceId: "TPAGE", channelId: "CPAGE",
      rootTs: "1718900000.000100", memberId: MEMBER_A, day: "2024-06-20", at: "2024-06-20T16:13:20.000300Z",
      messageCount: 3, rootAuthored: false,
      // Deleted or foreign root: the latest surviving message of THIS group is the link.
      linkMessage: { messageTs: "1718900000.000300", occurredAt: "2024-06-20T16:13:20.000300Z" },
    });
    expect(Object.prototype.hasOwnProperty.call(compact, "messages")).toBe(false);
  });

  it("links the surviving root this member authored when rootAuthored, not merely the latest message", async () => {
    const c = await contract();
    const compact = c.compactSlackAggregate(personDay({
      rootAuthored: true,
      messages: [
        { messageTs: "1718900000.000100", occurredAt: "2024-06-20T16:13:20.000100Z" },
        { messageTs: "1718900000.000300", occurredAt: "2024-06-20T16:13:20.000300Z" },
      ],
      messageCount: 2,
    }));
    expect(compact.linkMessage).toEqual({ messageTs: "1718900000.000100", occurredAt: "2024-06-20T16:13:20.000100Z" });
    expect(compact.rootTs).toBe("1718900000.000100");
    // rootAuthored without the root among the group's surviving messages is a contradiction.
    await expectFailure(() => c.compactSlackAggregate(personDay({ rootAuthored: true })), "unavailable");
  });

  it("breaks an equal-instant tie for the latest message by message id ascending", async () => {
    const c = await contract();
    const compact = c.compactSlackAggregate(personDay({
      messages: [
        { messageTs: "1718900000.0003", occurredAt: "2024-06-20T16:13:20.000300Z" },
        { messageTs: "1718900000.000300", occurredAt: "2024-06-20T16:13:20.000300Z" },
        { messageTs: "1718900000.000200", occurredAt: "2024-06-20T16:13:20.000200Z" },
      ],
    }));
    expect(compact.linkMessage.messageTs).toBe("1718900000.0003");
  });

  it("keeps a group of thousands of messages exact and within 2048 serialized bytes", async () => {
    const c = await contract();
    const messages = Array.from({ length: 5000 }, (_, n) => {
      const micro = String(n + 200).padStart(6, "0");
      return { messageTs: `1718900000.${micro}`, occurredAt: `2024-06-20T16:13:20.${micro}Z` };
    });
    const compact = c.compactSlackAggregate(personDay({ messages, messageCount: 5000, at: "2024-06-20T16:13:20.005199Z" }));
    expect(compact.messageCount).toBe(5000);
    expect(compact.linkMessage).toEqual({ messageTs: "1718900000.005199", occurredAt: "2024-06-20T16:13:20.005199Z" });
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThanOrEqual(2048);
  });

  it("refuses an oversized provider identity instead of truncating it", async () => {
    const c = await contract();
    const exact = "C".repeat(256);
    expect(c.compactSlackAggregate(personDay({ channelId: exact })).channelId).toBe(exact);
    for (const field of ["workspaceId", "channelId", "rootTs"]) {
      await expectFailure(() => c.compactSlackAggregate(personDay({ [field]: "X".repeat(257) })), "unavailable");
    }
    // 256 is a UTF-8 BYTE bound: 129 two-byte characters are 258 bytes.
    await expectFailure(() => c.compactSlackAggregate(personDay({ channelId: "é".repeat(129) })), "unavailable");
    await expectFailure(() => c.compactSlackAggregate(personDay({
      messages: [{ messageTs: "9".repeat(300), occurredAt: "2024-06-20T16:13:20.000300Z" }], messageCount: 1,
    })), "unavailable");
  });

  it.each([
    ["an unsafe count", { messageCount: Number.MAX_SAFE_INTEGER + 1 }],
    ["a zero count", { messageCount: 0, messages: [] }],
    ["a count that disagrees with the complete message list", { messageCount: 2 }],
    ["an id that is not its own tuple", { id: JSON.stringify([ITEM_B, MEMBER_A, "2024-06-20"]) }],
    ["an instant on another day", { at: "2024-06-21T00:00:00.000000Z" }],
    ["an instant that is not the group maximum", { at: "2024-06-20T16:13:20.000250Z" }],
    ["an uppercase item id", { sourceItemId: ITEM_A.toUpperCase(), id: JSON.stringify([ITEM_A.toUpperCase(), MEMBER_A, "2024-06-20"]) }],
  ])("refuses a projected group with %s as unavailable", async (_label, over) => {
    const c = await contract();
    await expectFailure(() => c.compactSlackAggregate(personDay(over)), "unavailable");
  });
});

describe("Slack timeline page contract — terminal and progress invariants", () => {
  // Three DIFFERENT groups of one day, in aggregate order (instant DESC).
  const first = tuple({ at: "2024-06-20T16:13:20.000300Z" });
  const second = tuple({ at: "2024-06-20T16:13:20.000200Z", memberId: MEMBER_B });
  const third = tuple({ at: "2024-06-20T16:13:20.000100Z", itemId: ITEM_B });
  const entry = (t: Json): Json => ({ id: JSON.stringify([t.itemId, t.memberId, t.day]), tuple: t });

  function page(over: Json = {}): Json {
    return {
      days: [], window_days: 7, asOf: ms(AS_OF_MS), binding: binding(),
      aggregates: [entry(first), entry(second)],
      nextSlackCursor: "opaque", slackComplete: false, ...over,
    };
  }
  const lastOf = (p: Json): Json => ((p.aggregates as Json[]).at(-1) as Json).tuple as Json;

  it("accepts a full nonterminal page whose cursor is its last emitted tuple", async () => {
    const c = await contract();
    const p = page();
    expect(() => c.assertSlackTimelinePageProtocol({ page: p, requestTuple: null, nextTuple: lastOf(p) })).not.toThrow();
  });

  it("accepts terminal pages of zero through pageSize aggregates, including an empty one", async () => {
    const c = await contract();
    for (const aggregates of [[], [entry(first)], [entry(first), entry(second)]]) {
      const p = page({ aggregates, nextSlackCursor: null, slackComplete: true });
      expect(() => c.assertSlackTimelinePageProtocol({ page: p, requestTuple: null, nextTuple: null })).not.toThrow();
    }
  });

  it("accepts a continuation strictly after its request cursor", async () => {
    const c = await contract();
    const p = page({ aggregates: [entry(second), entry(third)] });
    expect(() => c.assertSlackTimelinePageProtocol({ page: p, requestTuple: first, nextTuple: third })).not.toThrow();
  });

  it.each([
    ["complete with a non-null cursor", (p: Json) => ({ page: { ...p, slackComplete: true }, requestTuple: null, nextTuple: lastOf(p) })],
    ["incomplete with a null cursor", (p: Json) => ({ page: { ...p, nextSlackCursor: null }, requestTuple: null, nextTuple: null })],
    ["an empty nonterminal page", (p: Json) => ({ page: { ...p, aggregates: [] }, requestTuple: null, nextTuple: first })],
    ["a nonterminal page shorter than pageSize", (p: Json) => ({ page: { ...p, aggregates: [entry(first)] }, requestTuple: null, nextTuple: first })],
    ["more aggregates than pageSize", (p: Json) => ({
      page: { ...p, aggregates: [entry(first), entry(second), entry(third)] }, requestTuple: null, nextTuple: third,
    })],
    ["a cursor that is not the last emitted tuple", (p: Json) => ({ page: p, requestTuple: null, nextTuple: first })],
    ["a cursor that skips past the last emitted tuple", (p: Json) => ({ page: p, requestTuple: null, nextTuple: third })],
    ["a cursor without an authenticated tuple", (p: Json) => ({ page: p, requestTuple: null, nextTuple: null })],
    ["a duplicate aggregate", (p: Json) => ({ page: { ...p, aggregates: [entry(first), entry(first)] }, requestTuple: null, nextTuple: first })],
    ["aggregates out of tuple order", (p: Json) => ({ page: { ...p, aggregates: [entry(second), entry(first)] }, requestTuple: null, nextTuple: first })],
    ["an aggregate equal to the request cursor", (p: Json) => ({ page: { ...p, aggregates: [entry(first), entry(second)] }, requestTuple: first, nextTuple: second })],
    ["an aggregate before the request cursor", (p: Json) => ({ page: { ...p, aggregates: [entry(first), entry(second)] }, requestTuple: second, nextTuple: second })],
    ["an aggregate id that is not its tuple", (p: Json) => ({
      page: { ...p, aggregates: [{ id: "wrong", tuple: first }, entry(second)] }, requestTuple: null, nextTuple: lastOf(p),
    })],
    ["the same group twice under two instants", (p: Json) => ({
      page: { ...p, aggregates: [entry(first), entry(tuple({ at: "2024-06-20T16:13:20.000250Z" }))] },
      requestTuple: null, nextTuple: tuple({ at: "2024-06-20T16:13:20.000250Z" }),
    })],
    ["an aggregate outside the bound window", (p: Json) => ({
      page: { ...p, aggregates: [entry(first), entry(tuple({ day: "2024-06-01", at: "2024-06-01T00:00:00.000000Z" }))] },
      requestTuple: null, nextTuple: tuple({ day: "2024-06-01", at: "2024-06-01T00:00:00.000000Z" }),
    })],
    ["a window that disagrees with its binding", (p: Json) => ({ page: { ...p, window_days: 14 }, requestTuple: null, nextTuple: lastOf(p) })],
    ["an asOf that disagrees with its binding", (p: Json) => ({ page: { ...p, asOf: ms(AS_OF_MS + 1) }, requestTuple: null, nextTuple: lastOf(p) })],
    ["no binding", (p: Json) => ({ page: { ...p, binding: undefined }, requestTuple: null, nextTuple: lastOf(p) })],
    ["days that are not an array", (p: Json) => ({ page: { ...p, days: null }, requestTuple: null, nextTuple: lastOf(p) })],
  ])("refuses %s as a protocol violation", async (_label, build) => {
    const c = await contract();
    await expectFailure(() => c.assertSlackTimelinePageProtocol(build(page())), "unavailable");
  });

  it("requires a terminal page to carry the complete binding even when it has no rows", async () => {
    const c = await contract();
    const partial = binding();
    delete partial.presentationInputDigest;
    const p = page({ aggregates: [], nextSlackCursor: null, slackComplete: true, binding: partial });
    await expectFailure(() => c.assertSlackTimelinePageProtocol({ page: p, requestTuple: null, nextTuple: null }), "unavailable");
  });

  it("judges page size from aggregates, never from the number of presentation rows", async () => {
    const c = await contract();
    const one = aggregate(ITEM_A, MEMBER_A, "2024-06-20T16:13:20.000300Z");
    // One aggregate associated with three tasks renders three rows, and is still ONE aggregate.
    const item = slackItem(one.id as string, one.at as string);
    const days = [day("2024-06-20", [person(MEMBER_A, { tasks: [task("T1", [item]), task("T2", [item]), task("T3", [item])] })])];
    const p = page({ days, aggregates: [entry(first)], nextSlackCursor: null, slackComplete: true });
    expect(() => c.assertSlackTimelinePageProtocol({ page: p, requestTuple: null, nextTuple: null })).not.toThrow();
    const short = page({ days, aggregates: [entry(first)] });
    await expectFailure(() => c.assertSlackTimelinePageProtocol({ page: short, requestTuple: null, nextTuple: first }), "unavailable");
  });
});

describe("Slack timeline page contract — composer output", () => {
  const a1 = aggregate(ITEM_A, MEMBER_A, "2024-06-20T16:13:20.000300Z");
  const a2 = aggregate(ITEM_B, MEMBER_A, "2024-06-20T16:13:20.000200Z");
  const b1 = aggregate(ITEM_A, MEMBER_B, "2024-06-19T10:00:00.000000Z");
  const row = (a: Json, over: Json = {}): Json => slackItem(a.id as string, a.at as string, over);

  function composed(): TimelineDay[] {
    return [
      day("2024-06-20", [person(MEMBER_A, {
        tasks: [task("T1", [row(a1)]), task("T2", [row(a1), row(a2)])],
      })]),
      day("2024-06-19", [person(MEMBER_B, { other: [slackGroup([row(b1)])] })]),
    ];
  }

  it("accepts same-date multi-task groups that carry exactly the aggregates' IDs", async () => {
    const c = await contract();
    expect(() => c.assertComposedSlackDays({ aggregates: [a1, a2, b1], days: composed() })).not.toThrow();
    expect(() => c.assertComposedSlackDays({ aggregates: [], days: [] })).not.toThrow();
  });

  it.each([
    ["omits an aggregate", (d: TimelineDay[]) => { d.pop(); return d; }],
    ["invents a Slack evidence ID", (d: TimelineDay[]) => {
      d[0].people[0].other = [slackGroup([slackItem(JSON.stringify([ITEM_B, MEMBER_A, "2024-06-20"]) + "x", "2024-06-20T10:00:00.000000Z")])] as never;
      return d;
    }],
    ["renders an aggregate under another member", (d: TimelineDay[]) => { d[1].people[0].memberId = MEMBER_A; return d; }],
    ["renders an aggregate on another day", (d: TimelineDay[]) => { d[1].date = "2024-06-18"; return d; }],
    ["changes an aggregate's instant", (d: TimelineDay[]) => {
      (d[1].people[0].other[0].items[0] as { at: string }).at = "2024-06-19T10:00:00.000001Z";
      return d;
    }],
    ["emits non-Slack evidence", (d: TimelineDay[]) => {
      d[0].people[0].other = [{ source: "github", count: 1, items: [{ id: "g1", title: "PR", source: "github", kind: "pr", at: "2024-06-20T10:00:00Z" }] }];
      return d;
    }],
    ["labels a Slack row with another source", (d: TimelineDay[]) => {
      (d[1].people[0].other[0].items[0] as { source: string }).source = "github";
      return d;
    }],
    ["carries a synopsis", (d: TimelineDay[]) => { d[0].people[0].summary = "did things"; return d; }],
    ["carries signals", (d: TimelineDay[]) => {
      d[0].people[0].signals = [{ kind: "decision", count: 1, items: [{ id: "d1", kind: "decision", title: "D", at: "2024-06-20" }] }];
      return d;
    }],
    ["has an empty person", (d: TimelineDay[]) => { d.push(day("2024-06-18", [person(MEMBER_B)])); return d; }],
    ["repeats a day", (d: TimelineDay[]) => { d.push(d[1]); return d; }],
    ["repeats a person within a day", (d: TimelineDay[]) => { d[0].people.push(d[0].people[0]); return d; }],
    ["repeats a task within a person", (d: TimelineDay[]) => { d[0].people[0].tasks.push(d[0].people[0].tasks[0]); return d; }],
    ["has an undated day", (d: TimelineDay[]) => { d[1].date = "unknown"; return d; }],
    ["is not an array", () => ({}) as unknown as TimelineDay[]],
  ])("refuses a composer that %s", async (_label, mutate) => {
    const c = await contract();
    await expectFailure(() => c.assertComposedSlackDays({ aggregates: [a1, a2, b1], days: mutate(composed()) }), "unavailable");
  });

  it("does not let a locked owner with no messages be rendered", async () => {
    const c = await contract();
    // The owner has no aggregate of their own: any row under them is invented evidence.
    const days = composed();
    days[0].people.push(person(MEMBER_B, { other: [slackGroup([row(a1)])] as never }));
    await expectFailure(() => c.assertComposedSlackDays({ aggregates: [a1, a2, b1], days }), "unavailable");
  });
});

describe("Slack timeline page contract — merge classification", () => {
  const a1 = aggregate(ITEM_A, MEMBER_A, "2024-06-20T16:13:20.000300Z");
  const a2 = aggregate(ITEM_B, MEMBER_A, "2024-06-20T16:13:20.000200Z");
  const row = (a: Json, over: Json = {}): Json => slackItem(a.id as string, a.at as string, over);
  const github = { source: "github", count: 1, items: [{ id: "g1", title: "PR", source: "github", kind: "pr", at: "2024-06-20T09:00:00Z" }] };

  function initial(): TimelineDay[] {
    return [day("2024-06-20", [person(MEMBER_A, { total: 1, unlinked: 1, other: [github] })])];
  }
  const continuation = (items: Json[], over: Partial<PersonDay> = {}): TimelineDay[] =>
    [day("2024-06-20", [person(MEMBER_A, { other: [slackGroup(items)] as never, ...over })])];

  it("merges through the shared merger and counts each Slack ID once across task associations (D4)", async () => {
    const c = await contract();
    const page = [day("2024-06-20", [person(MEMBER_A, {
      tasks: [task("T1", [row(a1)]), task("T2", [row(a1)])], other: [slackGroup([row(a2)])] as never,
    })])];
    const merged = c.mergeSlackTimelineDays(initial(), page);
    const p = merged[0].people[0];
    // One GitHub row + two UNIQUE Slack IDs; the per-task associations both remain visible.
    expect(p.total).toBe(3);
    expect(p.tasks.map((t: TaskGroup) => [t.taskId, t.evidenceCount])).toEqual([["T1", 1], ["T2", 1]]);
    expect(p.other.find((g: { source: string }) => g.source === "slack").count).toBe(1);
  });

  it("normalizes an already assembled first page identically to the multi-page path", async () => {
    const c = await contract();
    const twoPages = c.mergeSlackTimelineDays(c.mergeSlackTimelineDays(initial(), continuation([row(a1)])), continuation([row(a2)]));
    const onePage = c.mergeSlackTimelineDays(c.mergeSlackTimelineDays(initial(), continuation([row(a1), row(a2)])), []);
    expect(onePage).toEqual(twoPages);
    expect(onePage[0].people[0].total).toBe(3);
    // An empty final merge still normalizes and is idempotent.
    expect(c.mergeSlackTimelineDays(onePage, [])).toEqual(onePage);
    expect(c.mergeSlackTimelineDays([], [])).toEqual([]);
  });

  it("merges an idempotent duplicate delivery without double counting", async () => {
    const c = await contract();
    const once = c.mergeSlackTimelineDays(initial(), continuation([row(a1)]));
    expect(c.mergeSlackTimelineDays(once, continuation([row(a1)]))).toEqual(once);
  });

  it("keeps more than six same-day groups for one person", async () => {
    const c = await contract();
    const rows = Array.from({ length: 9 }, (_, n) => {
      const item = `0c000000-0000-4000-8000-00000000000${n}`;
      return slackItem(JSON.stringify([item, MEMBER_A, "2024-06-20"]), `2024-06-20T16:13:20.00000${n}Z`);
    });
    const merged = c.mergeSlackTimelineDays(initial(), continuation(rows));
    const slack = merged[0].people[0].other.find((g: { source: string }) => g.source === "slack");
    expect(slack.items).toHaveLength(9);
    expect(slack.count).toBe(9);
    expect(merged[0].people[0].total).toBe(10);
  });

  it.each([
    ["the same evidence ID with a different title", () => continuation([row(a1, { title: "Renamed thread" })])],
    ["the same person with a different name", () => continuation([row(a2)], { name: "Renamed Person" })],
    ["the same day with a different label", () => [day("2024-06-20", [person(MEMBER_A, { other: [slackGroup([row(a2)])] as never })], "Today")]],
    ["the same task with a different status", () => [day("2024-06-20", [person(MEMBER_A, { tasks: [task("T1", [row(a2)], { status: "done" })] })])]],
  ])("classifies a valid-shape cross-page conflict (%s) as restart_required, never a raw merger error", async (_label, build) => {
    const c = await contract();
    const existing = c.mergeSlackTimelineDays(initial(), [day("2024-06-20", [person(MEMBER_A, {
      tasks: [task("T1", [row(a1)])],
    })])]);
    const failure = await failureOf(() => c.mergeSlackTimelineDays(existing, build()));
    expect(failure).toMatchObject({ name: "SlackTimelineError", code: "restart_required" });
    expect(failure.message).not.toMatch(/^Conflicting /);
    expect(failure.message).not.toContain(MEMBER_A);
  });

  it.each([
    ["existing days that are not an array", () => [null, continuation([row(a1)])]],
    ["a page that is not an array", () => [initial(), {}]],
    ["a continuation with non-Slack evidence", () => [initial(), [day("2024-06-20", [person(MEMBER_A, { other: [github] })])]]],
    ["a continuation with a synopsis", () => [initial(), continuation([row(a1)], { summary: "did things" })]],
    ["a continuation with signals", () => [initial(), continuation([row(a1)], {
      signals: [{ kind: "decision", count: 1, items: [{ id: "d1", kind: "decision", title: "D", at: "2024-06-20" }] }],
    })]],
    ["a continuation row on the wrong day", () => [initial(), continuation([slackItem(a1.id as string, "2024-06-19T10:00:00.000000Z")])]],
    ["a continuation person with no evidence", () => [initial(), [day("2024-06-20", [person(MEMBER_A)])]]],
    ["a continuation day with no people", () => [initial(), [day("2024-06-20", [])]]],
    ["an undated continuation day", () => [initial(), [day("unknown", [person(MEMBER_A, { other: [slackGroup([row(a1)])] as never })])]]],
    ["a duplicate continuation day", () => [initial(), [...continuation([row(a1)]), ...continuation([row(a2)])]]],
    ["a duplicate existing day", () => [[...initial(), ...initial()], continuation([row(a1)])]],
    ["a duplicate person in one day", () => [initial(), [day("2024-06-20", [
      person(MEMBER_A, { other: [slackGroup([row(a1)])] as never }), person(MEMBER_A, { other: [slackGroup([row(a2)])] as never }),
    ])]]],
    ["a duplicate task in one person", () => [initial(), [day("2024-06-20", [person(MEMBER_A, {
      tasks: [task("T1", [row(a1)]), task("T1", [row(a2)])],
    })])]]],
    ["a malformed Slack row", () => [initial(), continuation([{ id: a1.id, source: "slack", at: a1.at }])]],
    ["an invalid calendar day", () => [initial(), [day("2024-02-30", [person(MEMBER_A, { other: [slackGroup([row(a1)])] as never })])]]],
  ])("refuses malformed merge input (%s) as unavailable BEFORE merging", async (_label, build) => {
    const c = await contract();
    const [existing, page] = build() as [TimelineDay[], TimelineDay[]];
    await expectFailure(() => c.mergeSlackTimelineDays(existing, page), "unavailable");
  });

  // Final review, finding 3. Rows of a NON-Slack group were never looked at before the merger was
  // called. The shared merger sorts them by `at` and `id`, so `[null, null]` made it throw — and a
  // throw from that call is reported as a cross-page conflict. A malformed dependency result is
  // `unavailable`; `restart_required` is reserved for well-formed pages that disagree.
  const pr = (id: string, over: Json = {}): Json => ({ id, title: "PR", source: "github", kind: "pr", at: "2024-06-20T09:00:00Z", ...over });
  const without = (row: Json, key: string): Json => { const copy = { ...row }; delete copy[key]; return copy; };
  const NON_SLACK_ROWS: [string, unknown[]][] = [
    ["two null rows (the review counterexample)", [null, null]],
    ["one null row", [null]],
    ["a string where a row belongs", ["row", pr("g2")]],
    ["a number where a row belongs", [7, pr("g2")]],
    ["an array where a row belongs", [[], pr("g2")]],
    ["a row with no id", [without(pr("g1"), "id"), pr("g2")]],
    ["a row whose id is not a string", [pr("g1", { id: 42 }), pr("g2")]],
    ["a row with an empty id", [pr(""), pr("g2")]],
    ["rows with no instant", [without(pr("g1"), "at"), without(pr("g2"), "at")]],
    ["a row whose instant is not a string", [pr("g1", { at: 20240620 }), pr("g2")]],
  ];
  /** Existing days whose one non-Slack group holds `items`, unlinked or nested under a task. */
  const existingWith = (items: unknown[], placement: "other" | "task"): TimelineDay[] => {
    const group = { source: "github", count: 2, items } as never;
    return [day("2024-06-20", [person(MEMBER_A, {
      total: 2, unlinked: 2,
      other: placement === "other" ? [group] : [],
      tasks: placement === "task" ? [{ taskId: "T9", title: "Tracked task", status: "in_progress", source: "linear", evidenceCount: 2, sources: [group] }] : [],
    })])];
  };

  it.each(NON_SLACK_ROWS)("refuses existing non-Slack evidence holding %s as unavailable, never as a merge conflict", async (_label, items) => {
    const c = await contract();
    for (const placement of ["other", "task"] as const) {
      // With a continuation to merge, with nothing to merge (the normalization every first page gets)…
      for (const page of [continuation([row(a1)]), []]) {
        const failure = await failureOf(() => c.mergeSlackTimelineDays(existingWith(items, placement), page));
        expect(failure, placement).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
      }
      // …and as the assembled first page a drain checks before it normalizes.
      await expectFailure(() => c.assertAssembledSlackDays({ aggregates: [], days: existingWith(items, placement) }), "unavailable");
    }
  });

  it("accepts well-formed non-Slack rows, capped or dated by day alone (control)", async () => {
    const c = await contract();
    for (const placement of ["other", "task"] as const) {
      // A count above the rendered rows is a cap; a bare date is how a meeting is dated. Neither is malformed.
      const existing = existingWith([pr("g1"), pr("m1", { source: "meetings", kind: "meeting", at: "2024-06-20" })], placement);
      (existing[0].people[0][placement === "other" ? "other" : "tasks"][0] as { count?: number }).count = 9;
      expect(() => c.assertAssembledSlackDays({ aggregates: [], days: existing })).not.toThrow();
      const merged = c.mergeSlackTimelineDays(existing, continuation([row(a1)]));
      expect(JSON.stringify(merged)).toContain('"g1"');
      expect(JSON.stringify(merged)).toContain('"m1"');
      // A well-formed page that DISAGREES with it is still a restart, exactly as before.
      const conflict = [day("2024-06-20", [person(MEMBER_A, { other: [slackGroup([row(a1)])] as never })], "Another label")];
      await expectFailure(() => c.mergeSlackTimelineDays(existing, conflict), "restart_required");
    }
  });

  it("does not mutate either input, so a caller can retry after any refusal", async () => {
    const c = await contract();
    const existing = initial();
    const page = continuation([row(a1)]);
    const before = JSON.stringify([existing, page]);
    c.mergeSlackTimelineDays(existing, page);
    await failureOf(() => c.mergeSlackTimelineDays(existing, continuation([row(a1)], { name: "Renamed" })));
    expect(JSON.stringify([existing, page])).toBe(before);
  });

  it("keeps labels bound to asOf: a page composed after UTC midnight still merges with the first", async () => {
    const c = await contract();
    // Both pages label 2024-06-20 from the SAME bound asOf, so the wall clock crossing midnight
    // between them cannot turn "Today" into "Yesterday" and manufacture a conflict.
    const label = "Yesterday";
    const firstPage = c.mergeSlackTimelineDays([], [day("2024-06-20", [person(MEMBER_A, { other: [slackGroup([row(a1)])] as never })], label)]);
    const merged = c.mergeSlackTimelineDays(firstPage, [day("2024-06-20", [person(MEMBER_A, { other: [slackGroup([row(a2)])] as never })], label)]);
    expect(merged[0].label).toBe(label);
    expect(merged[0].people[0].total).toBe(2);
  });
});
