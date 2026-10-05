import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AIO-1170 AC-07 — Slack directory classification and automatic identity linking (DIR-02, DIR-04,
 * DIR-06): the ADMISSION boundary in `syncSlackIdentities`.
 *
 * Automatic exact-email linking is allowed only for an account POSITIVELY classified as human:
 * `isBot === false && isAppUser === false`. A bot, an app, the Slack service account and every
 * account whose classification is missing, partial or not a literal boolean must be omitted BEFORE
 * the shared writer is called — the writer ignores classification and links by email.
 *
 * These tests drive the real adapter. The shared writer is replaced at the module boundary so each
 * case can read exactly which records the adapter forwarded and in which mode; the no-database case
 * puts the REAL writer back, so "an excluded account reaches no database" is proved against the code
 * that would otherwise read the roster. Fixtures are synthetic. The field names are written out as
 * plain runtime objects on purpose: the tests must reach today's behavior, not stop at a type error.
 */

const writer = vi.hoisted(() => ({
  syncProviderIdentities: vi.fn(),
  actual: null as null | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock("@/lib/identity/provider-sync", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  writer.actual = actual.syncProviderIdentities as (...args: unknown[]) => Promise<unknown>;
  return { ...actual, syncProviderIdentities: writer.syncProviderIdentities };
});

import { syncSlackIdentities } from "@/lib/ingest/sources/slack-identity";

const TEAM = "3f1a0b2c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ADMIN = { fixture: "admin-client" } as never;
const ZERO = { scanned: 0, mapped: 0, skipped: 0 };

type Entry = Record<string, unknown>;

/** A directory record with an id AND an email that the shared matcher would otherwise consider. */
function account(id: unknown, over: Entry = {}): Entry {
  const slug = typeof id === "string" ? id.trim().toLowerCase().replace(/[^a-z0-9]/g, "-") : "malformed";
  return { id, displayName: `Synthetic ${slug}`, email: `${slug}@roster.test`, ...over };
}
/** Positively classified human: both flags are the literal boolean false. */
const human = (id: unknown, over: Entry = {}): Entry => account(id, { isBot: false, isAppUser: false, ...over });

const sync = (users: unknown[], admin: unknown = ADMIN) =>
  syncSlackIdentities(admin as never, TEAM, users as never);

/** Every record the adapter handed to the shared writer, across all of its calls, in order. */
function forwarded(): Entry[] {
  return writer.syncProviderIdentities.mock.calls.flatMap((call) => call[3] as Entry[]);
}
const forwardedIds = (): unknown[] => forwarded().map((user) => user?.id);

/**
 * Every writer call carried the Slack provider, the caller's client and team, and EXACT-EMAIL mode.
 * (An all-excluded input may either skip the writer or hand it an empty list; both are no-ops.)
 */
function expectWriterContract(): void {
  for (const call of writer.syncProviderIdentities.mock.calls) {
    expect(call[0]).toBe(ADMIN);
    expect(call[1]).toBe(TEAM);
    expect(call[2]).toBe("slack");
    expect(Array.isArray(call[3])).toBe(true);
    expect(call[4]).toEqual({ exactEmailOnly: true });
  }
}

beforeEach(() => {
  writer.syncProviderIdentities.mockReset();
  // The stand-in keeps the real writer's shape: nothing in, zeros out; otherwise one outcome per record.
  writer.syncProviderIdentities.mockImplementation(async (_admin: unknown, _team: unknown, _provider: unknown, users: Entry[]) => ({
    scanned: users.length, mapped: users.length, skipped: 0,
  }));
});

describe("syncSlackIdentities — only a positively classified human reaches the shared writer", () => {
  it("forwards an explicit human unchanged, to provider slack, in exact-email mode (control)", async () => {
    const alice = human("U0HUMAN1", { displayName: "Alice Example", email: "alice@roster.test" });
    writer.syncProviderIdentities.mockResolvedValueOnce({ scanned: 1, mapped: 1, skipped: 0 });
    expect(await sync([alice])).toEqual({ scanned: 1, mapped: 1, skipped: 0 });
    expect(writer.syncProviderIdentities).toHaveBeenCalledTimes(1);
    expectWriterContract();
    expect(forwarded().map(({ id, displayName, email }) => ({ id, displayName, email }))).toEqual([
      { id: "U0HUMAN1", displayName: "Alice Example", email: "alice@roster.test" },
    ]);
  });

  // [name, the classification properties the record carries]
  const EXCLUDED: [string, Entry][] = [
    ["a bot", { isBot: true, isAppUser: false }],
    ["an app user", { isBot: false, isAppUser: true }],
    ["a bot that is also an app user", { isBot: true, isAppUser: true }],
    ["a bot whose app flag is missing", { isBot: true }],
    ["an app user whose bot flag is missing", { isAppUser: true }],
    ["an account with no classification at all", {}],
    ["an account with only isBot false", { isBot: false }],
    ["an account with only isAppUser false", { isAppUser: false }],
    ["an account whose flags are both undefined", { isBot: undefined, isAppUser: undefined }],
  ];
  // A value that is not the literal boolean false never establishes "not a bot" / "not an app".
  const NOT_A_BOOLEAN: [string, unknown][] = [
    ["null", null], ["undefined", undefined], ["0", 0], ["an empty string", ""], ['"false"', "false"], ['"true"', "true"],
    ["1", 1], ["an array", []], ["an object", {}],
  ];
  for (const [label, value] of NOT_A_BOOLEAN) {
    EXCLUDED.push([`isBot ${label} beside isAppUser false`, { isBot: value, isAppUser: false }]);
    EXCLUDED.push([`isAppUser ${label} beside isBot false`, { isBot: false, isAppUser: value }]);
  }

  it.each(EXCLUDED)("DIR-02 omits %s, even with an exact-match email, and still forwards the human beside it", async (_name, flags) => {
    const candidate = account("U0CANDIDATE", flags);
    for (const users of [[candidate, human("U0HUMAN1")], [human("U0HUMAN1"), candidate]]) {
      writer.syncProviderIdentities.mockClear();
      const result = await sync(users);
      expect(forwardedIds()).toEqual(["U0HUMAN1"]);
      expectWriterContract();
      // The excluded account is not an attempted match: only the admitted record is counted.
      expect(result).toEqual({ scanned: 1, mapped: 1, skipped: 0 });
    }
  });

  it("DIR-04 keeps a guest, a single-channel guest and a deactivated human eligible", async () => {
    const users = [
      human("U0ORDINARY"),
      human("U0GUEST", { isRestricted: true }),
      human("U0SINGLE", { isRestricted: true, isUltraRestricted: true }),
      human("U0DELETED", { deleted: true }),
      // Descriptive flags do not override a positive human classification, whatever they hold.
      human("U0ODDFLAGS", { deleted: "true", isRestricted: null, isUltraRestricted: 1 }),
    ];
    await sync(users);
    expect(forwardedIds()).toEqual(["U0ORDINARY", "U0GUEST", "U0SINGLE", "U0DELETED", "U0ODDFLAGS"]);
    expectWriterContract();
    // …and they do not rescue a bot or an unclassified account either.
    writer.syncProviderIdentities.mockClear();
    await sync([
      account("U0BOTGUEST", { isBot: true, isAppUser: false, isRestricted: true }),
      account("U0UNKNOWNDELETED", { deleted: true }),
      human("U0HUMAN1"),
    ]);
    expect(forwardedIds()).toEqual(["U0HUMAN1"]);
  });
});

describe("syncSlackIdentities — malformed directory entries are omitted, never thrown on", () => {
  const MALFORMED_ENTRIES: [string, unknown][] = [
    ["null", null], ["undefined", undefined], ["a bare string id", "U0BARESTRING"], ["a number", 42], ["a boolean", true],
    ["an empty array", []], ["an array holding a user", [{ id: "U0NESTED", email: "nested@roster.test", isBot: false, isAppUser: false }]],
  ];

  it.each(MALFORMED_ENTRIES)("DIR-02 skips an entry that is %s and keeps the valid human in the same input", async (_name, entry) => {
    for (const users of [[entry, human("U0HUMAN1")], [human("U0HUMAN1"), entry], [entry, human("U0HUMAN1"), entry]]) {
      writer.syncProviderIdentities.mockClear();
      const result = await sync(users);
      expect(forwardedIds()).toEqual(["U0HUMAN1"]);
      expect(result).toEqual({ scanned: 1, mapped: 1, skipped: 0 });
      expectWriterContract();
    }
  });

  // Each of these is explicitly "human" by its flags and carries an email: only the id disqualifies it.
  const INVALID_IDS: [string, Entry][] = [
    ["a missing id", { displayName: "No Id", email: "no-id@roster.test", isBot: false, isAppUser: false }],
    ["a null id", human(null)],
    ["an undefined id", human(undefined)],
    ["a numeric id", human(1234567)],
    ["a boolean id", human(true)],
    ["an object id", human({ toString: () => "U0COERCED" })],
    ["an array id", human(["U0ARRAY"])],
    ["an empty id", human("")],
    ["a blank id", human("   ")],
    ["a tab-and-newline id", human("\t\n")],
  ];

  it.each(INVALID_IDS)("DIR-02 rejects %s without coercing it, and keeps the valid human in the same input", async (_name, entry) => {
    for (const users of [[entry, human("U0HUMAN1")], [human("U0HUMAN1"), entry]]) {
      writer.syncProviderIdentities.mockClear();
      const result = await sync(users);
      expect(forwardedIds()).toEqual(["U0HUMAN1"]);
      expect(result).toEqual({ scanned: 1, mapped: 1, skipped: 0 });
    }
    // Never turned into a string id of its own.
    expect(JSON.stringify(forwardedIds())).not.toMatch(/U0COERCED|U0ARRAY|1234567|"true"|null/);
  });
});

describe("syncSlackIdentities — the Slack service account and forwarded-id fidelity", () => {
  it.each([["USLACKBOT"], ["uslackbot"], [" USLACKBOT "], [" uslackbot "], ["UsLaCkBoT"], ["TSPACE:USLACKBOT"], [" tspace:uslackbot "], ["tspace:USLACKBOT"]])(
    "DIR-02 always excludes the service account spelled %j, even when both flags are false",
    async (id) => {
      const result = await sync([human(id), human("U0HUMAN1")]);
      expect(forwardedIds()).toEqual(["U0HUMAN1"]);
      expect(result).toEqual({ scanned: 1, mapped: 1, skipped: 0 });
    }
  );

  it("DIR-02 excludes exactly that id — not ids that merely contain it, and not a workspace of that name", async () => {
    const users = [human("USLACKBOT2"), human("XUSLACKBOT"), human("TSPACE:USLACKBOTX"), human("USLACKBOT:U0HUMAN9")];
    await sync(users);
    expect(forwardedIds()).toEqual(["USLACKBOT2", "XUSLACKBOT", "TSPACE:USLACKBOTX", "USLACKBOT:U0HUMAN9"]);
  });

  it("DIR-02 never rewrites a forwarded id: outer whitespace, case and the workspace prefix all survive", async () => {
    const ids = [" U0PADDED ", "u0lower", "TSPACE:U0QUAL", " tspace:u0qualpad "];
    await sync(ids.map((id) => human(id)));
    expect(forwardedIds()).toEqual(ids);
    expectWriterContract();
  });
});

describe("syncSlackIdentities — a conflicting occurrence of one account omits every occurrence", () => {
  const bot = (id: string): Entry => account(id, { isBot: true, isAppUser: false });
  const unknown = (id: string): Entry => account(id);

  it.each([
    ["a bot and human spellings that differ by case and outer whitespace", [bot("UBOT1"), human("ubot1"), human(" UBOT1 ")]],
    ["the same, with the human seen first", [human("ubot1"), human(" UBOT1 "), bot("UBOT1")]],
    ["an unclassified occurrence beside a human one", [human("U0DUP"), unknown("u0dup")]],
    ["an app-user occurrence beside a human one", [account(" u0app ", { isBot: false, isAppUser: true }), human("U0APP")]],
    ["a workspace-qualified bot beside the same qualified human", [bot("TSPACE:UBOT1"), human(" tspace:ubot1 ")]],
    ["a wrong-typed occurrence beside a human one", [human("U0TYPED"), account("u0typed", { isBot: "false", isAppUser: false })]],
  ])("DIR-02 omits every occurrence for %s", async (_name, occurrences) => {
    const result = await sync([...occurrences, human("U0HUMAN1")]);
    expect(forwardedIds()).toEqual(["U0HUMAN1"]);
    expect(result).toEqual({ scanned: 1, mapped: 1, skipped: 0 });
  });

  it("DIR-02 does not merge a raw id with a workspace-qualified one, or two workspaces (controls)", async () => {
    await sync([bot("UBOT1"), human("TSPACE:UBOT1")]);
    expect(forwardedIds()).toEqual(["TSPACE:UBOT1"]);
    writer.syncProviderIdentities.mockClear();
    await sync([bot("TSPACE:UBOT1"), human("TOTHER:UBOT1")]);
    expect(forwardedIds()).toEqual(["TOTHER:UBOT1"]);
    writer.syncProviderIdentities.mockClear();
    await sync([human("UBOT1"), bot("TSPACE:UBOT1"), human("TOTHER:UBOT1")]);
    expect(forwardedIds()).toEqual(["UBOT1", "TOTHER:UBOT1"]);
  });

  it("DIR-02 folds ASCII letters only: a non-ASCII look-alike is a different account (control)", async () => {
    // U+0131 (dotless i) upper-cases to "I" and U+212A (Kelvin sign) lower-cases to "k" under the
    // platform's Unicode case mapping. Neither is the same Slack id as its ASCII look-alike.
    await sync([bot("UBOTI1"), human("UBOTı1")]);
    expect(forwardedIds()).toEqual(["UBOTı1"]);
    writer.syncProviderIdentities.mockClear();
    await sync([bot("UBOTK1"), human("UBOTK1")]);
    expect(forwardedIds()).toEqual(["UBOTK1"]);
  });

  it("DIR-02 forwards every occurrence of an all-human duplicate, unchanged and in order (control)", async () => {
    const users = [human("U0ABC"), human("u0abc"), human(" U0ABC "), human("TSPACE:U0ABC")];
    const result = await sync(users);
    expect(forwardedIds()).toEqual(["U0ABC", "u0abc", " U0ABC ", "TSPACE:U0ABC"]);
    // Per-occurrence counts are the shared writer's, untouched.
    expect(result).toEqual({ scanned: 4, mapped: 4, skipped: 0 });
  });
});

describe("syncSlackIdentities — results, failures and the database", () => {
  it("DIR-02 returns the shared writer's result for the admitted subset, with no added statistics", async () => {
    writer.syncProviderIdentities.mockResolvedValueOnce({ scanned: 2, mapped: 1, skipped: 1 });
    const result = await sync([
      account("U0BOT", { isBot: true, isAppUser: false }),
      human("U0HUMAN1"),
      account("U0UNKNOWN"),
      human("U0HUMAN2"),
      human("USLACKBOT"),
    ]);
    expect(result).toEqual({ scanned: 2, mapped: 1, skipped: 1 });
    expect(Object.keys(result).sort()).toEqual(["mapped", "scanned", "skipped"]);
    expect(writer.syncProviderIdentities).toHaveBeenCalledTimes(1);
    expect(forwardedIds()).toEqual(["U0HUMAN1", "U0HUMAN2"]);
    expectWriterContract();
  });

  it("DIR-02 an all-excluded directory with ids AND emails performs no database work at all", async () => {
    // The REAL shared writer, so this is the code that would read the roster for these records.
    expect(writer.actual).toEqual(expect.any(Function));
    writer.syncProviderIdentities.mockImplementation((...args: unknown[]) => (writer.actual as (...a: unknown[]) => Promise<unknown>)(...args));
    const touched: string[] = [];
    const forbidden = new Proxy({}, {
      get(_target, property) {
        if (typeof property === "symbol") return undefined;
        touched.push(String(property));
        throw new Error("fixture: the database must not be used");
      },
    });
    const excluded = [
      account("U0BOT", { isBot: true, isAppUser: false }),
      account("U0APP", { isBot: false, isAppUser: true }),
      account("U0UNKNOWN"),
      account("U0PARTIAL", { isBot: false }),
      account("U0TYPED", { isBot: "false", isAppUser: "false" }),
      human("USLACKBOT"),
      human(" tspace:uslackbot "),
      account("UDUP1", { isBot: true, isAppUser: false }),
      human("udup1"),
    ];
    // Non-vacuity of the fixtures themselves: every record carries a nonempty id and email.
    for (const user of excluded) {
      expect(typeof user.id === "string" && user.id.trim().length > 0).toBe(true);
      expect(typeof user.email === "string" && user.email.length > 0).toBe(true);
    }
    expect(await sync(excluded, forbidden)).toEqual(ZERO);
    expect(touched).toEqual([]);
    expect(await sync([], forbidden)).toEqual(ZERO);
    expect(touched).toEqual([]);

    // Control: ONE explicit human with the same shape does reach the roster read through this client,
    // so the proof above is about admission and not about records the matcher would have ignored.
    await expect(sync([human("U0HUMAN1")], forbidden)).rejects.toThrow("fixture: the database must not be used");
    expect(touched).toContain("from");
  });

  it("DIR-06 propagates a shared-writer failure for an admitted human, and never reports a mapping", async () => {
    const failure = new Error("identity roster read: unavailable");
    writer.syncProviderIdentities.mockRejectedValueOnce(failure);
    await expect(sync([account("U0BOT", { isBot: true, isAppUser: false }), human("U0HUMAN1")])).rejects.toBe(failure);
    expect(forwardedIds()).toEqual(["U0HUMAN1"]);
  });

  it("DIR-06 an all-excluded directory cannot fail on a writer it must not ask to match anything", async () => {
    writer.syncProviderIdentities.mockImplementation(async (_admin: unknown, _team: unknown, _provider: unknown, users: Entry[]) => {
      if (users.length > 0) throw new Error("fixture: an excluded account reached the shared writer");
      return { ...ZERO };
    });
    expect(await sync([account("U0BOT", { isBot: true, isAppUser: false }), account("U0UNKNOWN"), human("USLACKBOT")]))
      .toEqual(ZERO);
    expect(forwarded()).toEqual([]);
  });

  it("does not mutate the directory it was given", async () => {
    const users = [account("U0BOT", { isBot: true, isAppUser: false }), human(" U0HUMAN1 "), account("U0UNKNOWN")];
    const before = JSON.stringify(users);
    await sync(users);
    expect(JSON.stringify(users)).toBe(before);
    expect(users).toHaveLength(3);
  });
});
