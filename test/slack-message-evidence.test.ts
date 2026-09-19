import { describe, expect, it } from "vitest";
import {
  projectSlackMessageEvidence,
  SlackEvidenceConflictError,
  type SlackEvidenceUser,
  type SlackMessageEvidence,
} from "@/lib/ingest/sources/slack-message-evidence";
import type { SlackMessage } from "@/lib/ingest/sources/slack";

/**
 * Spec for the SOURCE-MESSAGE evidence projection (AIO-1170, packet 1 — pure helper, not yet wired
 * into the runner). The product outcome it serves: an eligible authored Slack message must produce
 * evidence for the right person on ITS OWN contribution day, and a later reply must never be able to
 * move an earlier day. That requires three things the current `participants[]` ledger cannot give:
 *
 *  • an EXACT per-message identity — `(workspace, channel, message_ts)` verbatim, so two messages a
 *    microsecond apart stay two messages;
 *  • an instant parsed WITHOUT floating point, so that microsecond survives into the UTC day;
 *  • an eligibility verdict with a reason, so a bot/system/tombstoned message earns no person credit
 *    while its thread's live messages still do.
 *
 * Every assertion below is written from that contract, not from the implementation.
 */

const SCOPE = { workspaceId: "T0AAAAAAA", channelId: "C0B8V119G4D" } as const;

/** Fixed request clock. Passed explicitly on every call — the projection has no ambient time. */
const NOW = new Date("2026-09-09T12:00:00.000Z");

/** 2026-09-09T00:00:00Z — exactly UTC midnight. */
const TS_MIDNIGHT = "1788912000.000000";
/** 2026-09-08T23:59:59Z — one second earlier, and therefore the PREVIOUS UTC day. */
const TS_BEFORE_MIDNIGHT = "1788911999.999999";
/** 2024-06-20T16:13:20Z */
const TS_BASE = "1718900000.000100";
/** …and its next-microsecond neighbour: a DIFFERENT message. */
const TS_BASE_NEXT_MICRO = "1718900000.000101";
/** 2026-09-10T00:00:00Z — after NOW. */
const TS_FUTURE = "1788998400.000000";

/**
 * A KNOWN human: the directory was read and it stated BOTH bot flags as false. A record that merely
 * has a display name is not a classification — see the unknown-flag fixtures below.
 */
const HUMAN: SlackEvidenceUser = { displayName: "Alex", isBot: false, isAppUser: false };
const users: Record<string, SlackEvidenceUser> = {
  U1: HUMAN,
  U2: { displayName: "Riley", isBot: false, isAppUser: false },
  UBOT: { displayName: "Deploybot", isBot: true, isAppUser: false },
  UAPP: { displayName: "Notion", isBot: false, isAppUser: true },
  // Flagged a bot while the OTHER flag was never read — still not a person.
  UBOT_PARTIAL: { displayName: "Halfbot", isBot: true },
  UAPP_PARTIAL: { displayName: "Halfapp", isAppUser: true },
  // Present in the directory, but the adapter could not read bot classification at all…
  UNFLAGGED: { displayName: "Pat" },
  // …or read only one of the two flags.
  UHALF: { displayName: "Jo", isBot: false },
  UGUEST: { displayName: "Sam (guest)", isBot: false, isAppUser: false, isRestricted: true },
  UGONE: { displayName: "Former Teammate", isBot: false, isAppUser: false, deleted: true },
};

/** The ledger key a `ts` gets under SCOPE. */
function id(ts: string): string {
  return `${SCOPE.workspaceId}:${SCOPE.channelId}:${ts}`;
}

function project(messages: readonly SlackMessage[], overrides: { now?: Date; users?: Record<string, SlackEvidenceUser> } = {}) {
  return projectSlackMessageEvidence(messages, {
    scope: SCOPE,
    now: overrides.now ?? NOW,
    users: "users" in overrides ? overrides.users : users,
  });
}

function only(messages: readonly SlackMessage[], overrides?: Parameters<typeof project>[1]): SlackMessageEvidence {
  const out = project(messages, overrides).messages;
  expect(out).toHaveLength(1);
  return out[0];
}

describe("message identity — the exact Slack strings, never a derived number", () => {
  it("keys a message on (workspace, channel, message_ts) verbatim", () => {
    const row = only([{ ts: TS_BASE, user: "U1", text: "hi" }]);
    expect(row.messageId).toBe(`${SCOPE.workspaceId}:${SCOPE.channelId}:${TS_BASE}`);
    expect(row.messageTs).toBe(TS_BASE); // byte-identical: no trim, no re-format, no case fold
    expect(row.workspaceId).toBe(SCOPE.workspaceId);
    expect(row.channelId).toBe(SCOPE.channelId);
  });

  it("qualifies the author as WORKSPACE:USER while retaining the raw Slack user id", () => {
    const row = only([{ ts: TS_BASE, user: "U1", text: "hi" }]);
    expect(row.authorExternalId).toBe("U1");
    expect(row.qualifiedAuthorId).toBe("T0AAAAAAA:U1");
  });

  it("keeps two messages one MICROSECOND apart distinct — in id, instant and count", () => {
    // The live normalizer converts with `parseFloat(ts) * 1000`, which collapses both of these onto
    // the same millisecond. That is exactly why identity may not be generated from a float.
    const out = project([
      { ts: TS_BASE, user: "U1", text: "first" },
      { ts: TS_BASE_NEXT_MICRO, user: "U1", text: "second" },
    ]).messages;
    expect(out).toHaveLength(2);
    expect(new Set(out.map((m) => m.messageId)).size).toBe(2);
    expect(out[0].occurredAt).not.toBe(out[1].occurredAt);
    expect(out.map((m) => m.occurredAt)).toEqual([
      "2024-06-20T16:13:20.000100Z",
      "2024-06-20T16:13:20.000101Z",
    ]);
  });

  it("orders deterministically by instant regardless of the order pages arrived in", () => {
    const shuffled: SlackMessage[] = [
      { ts: TS_MIDNIGHT, user: "U1", text: "c" },
      { ts: TS_BASE, user: "U1", text: "a" },
      { ts: TS_BEFORE_MIDNIGHT, user: "U1", text: "b" },
    ];
    const forward = project(shuffled).messages.map((m) => m.messageTs);
    const reversed = project([...shuffled].reverse()).messages.map((m) => m.messageTs);
    expect(forward).toEqual([TS_BASE, TS_BEFORE_MIDNIGHT, TS_MIDNIGHT]);
    expect(reversed).toEqual(forward);
  });

  it("refuses a scope that cannot form an unambiguous id", () => {
    const msgs: SlackMessage[] = [{ ts: TS_BASE, user: "U1", text: "hi" }];
    for (const scope of [
      { workspaceId: "", channelId: "C1" },
      { workspaceId: "T1", channelId: "" },
      { workspaceId: "T1:extra", channelId: "C1" },
      { workspaceId: "T1", channelId: "C 1" },
    ]) {
      expect(() => projectSlackMessageEvidence(msgs, { scope, now: NOW, users })).toThrow();
    }
  });

  it("drops a message with no timestamp at all — it has no identity — and says so", () => {
    const out = project([
      { ts: "", user: "U1", text: "no id" },
      { ts: "   ", user: "U1", text: "no id either" },
      { ts: TS_BASE, user: "U1", text: "real" },
    ]);
    expect(out.messages.map((m) => m.messageTs)).toEqual([TS_BASE]);
    expect(out.unidentifiableCount).toBe(2);
  });
});

describe("time — exact UTC instants, and never the ingest clock", () => {
  it("places a message at UTC midnight on that day, and one microsecond earlier on the previous day", () => {
    const out = project([
      { ts: TS_BEFORE_MIDNIGHT, user: "U1", text: "late" },
      { ts: TS_MIDNIGHT, user: "U1", text: "early" },
    ]).messages;
    expect(out[0].occurredAt).toBe("2026-09-08T23:59:59.999999Z");
    expect(out[0].contributionDay).toBe("2026-09-08");
    expect(out[1].occurredAt).toBe("2026-09-09T00:00:00.000000Z");
    expect(out[1].contributionDay).toBe("2026-09-09");
  });

  it("an EDIT keeps the original instant and day, and only the content hash moves", () => {
    const before = only([{ ts: TS_BASE, user: "U1", text: "shipping today" }]);
    const after = only([{ ts: TS_BASE, user: "U1", text: "shipping today (edited)" }]);
    expect(after.messageId).toBe(before.messageId);
    expect(after.occurredAt).toBe(before.occurredAt);
    expect(after.contributionDay).toBe(before.contributionDay);
    expect(after.sourceHash).not.toBe(before.sourceHash);
  });

  it("an unparseable timestamp is excluded with a reason — it is NOT replaced by ingest time", () => {
    for (const ts of ["not-a-ts", "1718900000.1234567", "-1718900000.000100", "0.000000", "1e9.000000"]) {
      const row = only([{ ts, user: "U1", text: "hi" }]);
      expect(row.status).toBe("excluded");
      expect(row.reason).toBe("invalid_timestamp");
      expect(row.occurredAt).toBeNull();
      expect(row.contributionDay).toBeNull();
      // identity survives: the row still exists so the source's raw existence is recorded
      expect(row.messageTs).toBe(ts);
    }
  });

  it("a FUTURE timestamp keeps its own instant and earns no credit yet — no clamp to now", () => {
    const row = only([{ ts: TS_FUTURE, user: "U1", text: "clock skew" }]);
    expect(row.occurredAt).toBe("2026-09-10T00:00:00.000000Z");
    expect(row.contributionDay).toBe("2026-09-10");
    expect(row.status).toBe("unresolved"); // re-evaluable once the clock passes it, not a durable exclusion
    expect(row.reason).toBe("future_timestamp");
    expect(row.occurredAt).not.toBe(NOW.toISOString());
  });

  it("re-evaluates that same message to ELIGIBLE once the clock passes it — no source edit required", () => {
    // `unresolved/future_timestamp` is a not-yet verdict, not a durable exclusion: the SAME source
    // bytes must become creditable purely because time moved. Identity, instant, day and evidence
    // hash are unchanged across the transition, so re-reading cannot relocate or rewrite the message
    // — only its eligibility moves.
    const msg: SlackMessage = { ts: TS_FUTURE, user: "U1", text: "clock skew" };
    const before = only([msg], { now: NOW });
    const after = only([msg], { now: new Date("2026-09-10T00:00:01.000Z") });

    expect(before.status).toBe("unresolved");
    expect(before.reason).toBe("future_timestamp");
    expect(after.status).toBe("eligible");
    expect(after.reason).toBeNull();

    expect(after.messageId).toBe(before.messageId);
    expect(after.occurredAt).toBe(before.occurredAt);
    expect(after.contributionDay).toBe(before.contributionDay);
    expect(after.sourceHash).toBe(before.sourceHash);
  });

  it("has no ambient clock: the SAME messages project to the same instants under any `now`", () => {
    const msgs: SlackMessage[] = [{ ts: TS_BASE, user: "U1", text: "hi" }];
    const a = only(msgs, { now: new Date("2026-09-09T12:00:00.000Z") });
    const b = only(msgs, { now: new Date("2031-01-01T00:00:00.000Z") });
    expect(b.occurredAt).toBe(a.occurredAt);
    expect(b.contributionDay).toBe(a.contributionDay);
    expect(b.status).toBe(a.status);
  });

  it("actually consults the supplied `now` — a clock BEFORE the message makes it future", () => {
    // Negative control for the test above: if `now` were ignored (or read from Date.now()), this
    // message would come back eligible and the future rule would be unprovable.
    const row = only([{ ts: TS_BASE, user: "U1", text: "hi" }], { now: new Date("2020-01-01T00:00:00.000Z") });
    expect(row.reason).toBe("future_timestamp");
  });

  it("requires `now` rather than silently defaulting to the process clock", () => {
    expect(() =>
      projectSlackMessageEvidence([{ ts: TS_BASE, user: "U1", text: "hi" }], {
        scope: SCOPE,
        now: undefined as unknown as Date,
        users,
      })
    ).toThrow();
  });
});

describe("thread role — root vs reply, from the source's own thread_ts", () => {
  it("treats a message with no thread_ts, or a self-referencing one, as the root", () => {
    const bare = only([{ ts: TS_BASE, user: "U1", text: "kickoff" }]);
    expect(bare.isRoot).toBe(true);
    expect(bare.rootTs).toBe(TS_BASE);

    const selfRef = only([{ ts: TS_BASE, thread_ts: TS_BASE, user: "U1", text: "kickoff" }]);
    expect(selfRef.isRoot).toBe(true);
    expect(selfRef.rootTs).toBe(TS_BASE);
  });

  it("treats a message under another root as a reply, carrying that root's exact ts", () => {
    const row = only([{ ts: TS_BASE_NEXT_MICRO, thread_ts: TS_BASE, user: "U2", text: "on it" }]);
    expect(row.isRoot).toBe(false);
    expect(row.rootTs).toBe(TS_BASE);
  });

  it("a LIVE reply under a DELETED root stays eligible — the tombstone suppresses only itself", () => {
    const out = project([
      { ts: TS_BASE, user: "U1", text: "This message was deleted.", subtype: "tombstone", reply_count: 1 },
      { ts: TS_BASE_NEXT_MICRO, thread_ts: TS_BASE, user: "U2", text: "still here" },
    ]).messages;
    expect(out[0].status).toBe("excluded");
    expect(out[0].reason).toBe("tombstone");
    expect(out[1].status).toBe("eligible");
    expect(out[1].authorExternalId).toBe("U2");
    expect(out[1].rootTs).toBe(TS_BASE);
  });
});

describe("deduplication — one row per exact message id", () => {
  it("folds a thread_broadcast seen in BOTH history and replies into one eligible row", () => {
    const broadcast: SlackMessage = {
      ts: TS_BASE_NEXT_MICRO,
      thread_ts: TS_BASE,
      user: "U2",
      text: "also sending to channel",
      subtype: "thread_broadcast",
    };
    const out = project([broadcast, { ...broadcast }]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].status).toBe("eligible"); // a broadcast is a normal human message
    expect(out.messages[0].isRoot).toBe(false);
    expect(out.duplicateCount).toBe(1);
  });

  it("folds AGREEING repeats of several messages without complaint", () => {
    // The negative control for the conflict rule below: repetition alone is ordinary, and a batch
    // full of it still publishes.
    const a: SlackMessage = { ts: TS_BASE, user: "U1", text: "one" };
    const b: SlackMessage = { ts: TS_MIDNIGHT, user: "U2", text: "two" };
    const out = project([a, b, { ...a }, { ...b }, { ...a }]);
    expect(out.messages.map((m) => m.messageTs)).toEqual([TS_BASE, TS_MIDNIGHT]);
    expect(out.duplicateCount).toBe(3);
  });
});

describe("contradictory batch — a snapshot that disagrees with itself publishes NOTHING", () => {
  const original: SlackMessage = { ts: TS_BASE, user: "U1", text: "original" };
  const edited: SlackMessage = { ts: TS_BASE, user: "U1", text: "edited mid-scan" };

  function conflictFrom(messages: readonly SlackMessage[]): SlackEvidenceConflictError {
    let caught: unknown;
    try {
      project(messages);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SlackEvidenceConflictError);
    return caught as SlackEvidenceConflictError;
  }

  it("fails the WHOLE projection rather than returning rows chosen by page order", () => {
    // Picking either observation would make the published evidence depend on which page arrived
    // first — the same batch, read in the other order, would credit differently. Neither snapshot is
    // known-good, so neither may be published; the caller retries and the previous complete evidence
    // stands untouched.
    expect(() => project([original, edited])).toThrow(SlackEvidenceConflictError);
    expect(() => project([edited, original])).toThrow(SlackEvidenceConflictError);
  });

  it("reports the SAME conflict identity set whichever order the observations arrived in", () => {
    const forward = conflictFrom([original, edited]);
    const reversed = conflictFrom([edited, original]);
    expect(forward.messageIds).toEqual([id(TS_BASE)]);
    expect(reversed.messageIds).toEqual(forward.messageIds);
    expect(forward.conflictingMessageCount).toBe(1);
  });

  it("withholds the UNAFFECTED messages too — a partial batch is not a publishable snapshot", () => {
    expect(() =>
      project([{ ts: TS_BEFORE_MIDNIGHT, user: "U2", text: "untouched" }, original, edited])
    ).toThrow(SlackEvidenceConflictError);
  });

  it("names every conflicting id, sorted, and no agreeing one", () => {
    const err = conflictFrom([
      original,
      edited,
      { ts: TS_MIDNIGHT, user: "U1", text: "same words" },
      { ts: TS_MIDNIGHT, user: "U2", text: "same words" }, // same id, different author
      { ts: TS_BEFORE_MIDNIGHT, user: "U1", text: "agreeing" },
      { ts: TS_BEFORE_MIDNIGHT, user: "U1", text: "agreeing" }, // exact repeat: not a conflict
    ]);
    expect(err.messageIds).toEqual([id(TS_BASE), id(TS_MIDNIGHT)]);
    expect(err.messageIds).toEqual([...err.messageIds].sort()); // stable across page order
    expect(err.conflictingMessageCount).toBe(2);
    expect(err.messageIds).not.toContain(id(TS_BEFORE_MIDNIGHT));
  });

  it("counts one conflicting id once however many disagreeing observations there were", () => {
    const err = conflictFrom([original, edited, { ts: TS_BASE, user: "U1", text: "edited again" }]);
    expect(err.messageIds).toEqual([id(TS_BASE)]);
    expect(err.conflictingMessageCount).toBe(1);
  });

  it("carries NO raw message content — only ids an operator can look up", () => {
    const err = conflictFrom([original, edited]);
    for (const secret of ["original", "edited mid-scan"]) {
      expect(err.message).not.toContain(secret);
      expect(JSON.stringify(err.messageIds)).not.toContain(secret);
    }
    expect(err.message).toContain(id(TS_BASE));
    expect(err.name).toBe("SlackEvidenceConflictError");
  });

  it("conflicts on AUTHOR and on THREAD PLACEMENT, not only on text", () => {
    // A disagreement is not necessarily an edit — a malformed or mixed page can restate the same id
    // with a different author or a different root, and either would move the credit.
    expect(() =>
      project([
        { ts: TS_BASE, user: "U1", text: "same" },
        { ts: TS_BASE, user: "U2", text: "same" },
      ])
    ).toThrow(SlackEvidenceConflictError);
    expect(() =>
      project([
        { ts: TS_BASE_NEXT_MICRO, thread_ts: TS_BASE, user: "U1", text: "same" },
        { ts: TS_BASE_NEXT_MICRO, user: "U1", text: "same" },
      ])
    ).toThrow(SlackEvidenceConflictError);
  });

  it("does not treat a broadcast returned by two endpoints as a conflict", () => {
    const broadcast: SlackMessage = {
      ts: TS_BASE_NEXT_MICRO,
      thread_ts: TS_BASE,
      user: "U2",
      text: "also sending to channel",
      subtype: "thread_broadcast",
    };
    expect(() => project([broadcast, { ...broadcast }])).not.toThrow();
  });
});

describe("eligibility — who earns a person's work credit", () => {
  it("credits a plain human text message", () => {
    const row = only([{ ts: TS_BASE, user: "U1", text: "shipping the dual-backend today" }]);
    expect(row.status).toBe("eligible");
    expect(row.reason).toBeNull();
  });

  it("gives a bot_message NO human credit even though it carries a user id", () => {
    const row = only([{ ts: TS_BASE, user: "U1", text: "deploy finished", subtype: "bot_message" }]);
    expect(row.status).toBe("excluded");
    expect(row.reason).toBe("bot_message");
  });

  it("gives a message carrying a bot_id no human credit, even with no subtype", () => {
    const row = only([{ ts: TS_BASE, user: "U1", text: "build green", bot_id: "B123" }]);
    expect(row.status).toBe("excluded");
    expect(row.reason).toBe("bot_message");
  });

  it("gives a bot or app USER no credit, however normal the message looks", () => {
    expect(only([{ ts: TS_BASE, user: "UBOT", text: "deployed" }]).reason).toBe("bot_identity");
    expect(only([{ ts: TS_BASE, user: "UAPP", text: "page updated" }]).reason).toBe("bot_identity");
  });

  it("excludes a flagged bot even when the OTHER flag was never read", () => {
    // A positive bot signal is decisive on its own; it does not degrade to "unclassified" merely
    // because the record is incomplete.
    expect(only([{ ts: TS_BASE, user: "UBOT_PARTIAL", text: "deployed" }]).status).toBe("excluded");
    expect(only([{ ts: TS_BASE, user: "UBOT_PARTIAL", text: "deployed" }]).reason).toBe("bot_identity");
    expect(only([{ ts: TS_BASE, user: "UAPP_PARTIAL", text: "page updated" }]).reason).toBe("bot_identity");
  });

  it("credits only a KNOWN human — both bot flags read and both false", () => {
    const row = only([{ ts: TS_BASE, user: "U1", text: "hi" }]);
    expect(users.U1.isBot).toBe(false); // the fixture states the classification, it does not imply it
    expect(users.U1.isAppUser).toBe(false);
    expect(row.status).toBe("eligible");
  });

  it("leaves an author it cannot classify UNRESOLVED rather than assuming human", () => {
    // Directory present but this user is absent from it…
    const missing = only([{ ts: TS_BASE, user: "UNKNOWN1", text: "hi" }]);
    expect(missing.status).toBe("unresolved");
    expect(missing.reason).toBe("author_unclassified");

    // …and the whole directory unavailable (a users.list scope failure) is the same verdict, not
    // a channel-wide promotion of everyone to "human".
    const noDirectory = only([{ ts: TS_BASE, user: "U1", text: "hi" }], { users: undefined });
    expect(noDirectory.status).toBe("unresolved");
    expect(noDirectory.reason).toBe("author_unclassified");
  });

  it("treats a directory record with UNREAD bot flags as unclassified — a display name is not a classification", () => {
    // The failure this pins: an adapter that can list names but cannot read `is_bot`/`is_app_user`
    // would otherwise hand every author in the workspace a person's credit.
    const noFlags = only([{ ts: TS_BASE, user: "UNFLAGGED", text: "hi" }]);
    expect(noFlags.status).toBe("unresolved");
    expect(noFlags.reason).toBe("author_unclassified");

    // Half a classification is not one either: `is_bot:false` alone leaves app-user unknown.
    const halfRead = only([{ ts: TS_BASE, user: "UHALF", text: "hi" }]);
    expect(halfRead.status).toBe("unresolved");
    expect(halfRead.reason).toBe("author_unclassified");
  });

  it("still credits guests and deactivated people — they are source identities, not bots", () => {
    // Both are directory records with the bot flags READ and false; the guest/deleted flags are
    // beside the point, which is exactly the property under test.
    expect(only([{ ts: TS_BASE, user: "UGUEST", text: "here is the spec" }]).status).toBe("eligible");
    expect(only([{ ts: TS_BASE, user: "UGONE", text: "handing over" }]).status).toBe("eligible");
  });

  it("excludes an authorless message with a reason", () => {
    const row = only([{ ts: TS_BASE, text: "system post" }]);
    expect(row.status).toBe("excluded");
    expect(row.reason).toBe("no_author");
    expect(row.authorExternalId).toBeNull();
    expect(row.qualifiedAuthorId).toBeNull();
  });

  it("excludes structural subtypes with a reason, keeping the current ingest filter", () => {
    for (const subtype of ["channel_join", "channel_leave", "channel_topic", "message_changed"]) {
      const row = only([{ ts: TS_BASE, user: "U1", text: "x", subtype }]);
      expect(row.status).toBe("excluded");
      expect(row.reason).toBe("unsupported_subtype");
      expect(row.subtype).toBe(subtype);
    }
  });

  it("excludes a file_share EVEN WITH A CAPTION — attachment scope is unchanged, not newly eligible", () => {
    // A captioned file post carries real text, so this exclusion is a deliberate subtype policy, not
    // an accident of emptiness. Broadening attachment semantics is a separate decision; until it is
    // taken, such a post is reported as `unsupported_subtype` and never silently as "no text".
    const captioned = only([
      { ts: TS_BASE, user: "U1", text: "here are the Q3 numbers", subtype: "file_share" },
    ]);
    expect(captioned.status).toBe("excluded");
    expect(captioned.reason).toBe("unsupported_subtype");
    expect(captioned.subtype).toBe("file_share");

    // …and the caption-less one lands on the same verdict, by subtype, not by blankness.
    const bare = only([{ ts: TS_BASE, user: "U1", text: "", subtype: "file_share" }]);
    expect(bare.reason).toBe("unsupported_subtype");
  });

  it("excludes a message with NO subtype and no renderable text, separately, as no_text", () => {
    for (const text of [undefined, "", "   \n "]) {
      const row = only([{ ts: TS_BASE, user: "U1", text }]);
      expect(row.status).toBe("excluded");
      expect(row.reason).toBe("no_text");
      expect(row.subtype).toBeNull();
    }
  });

  it("reports ONE reason deterministically when several apply", () => {
    // bot_message + a blank body + an unclassified author all apply; the message-level bot verdict
    // is the reported one, so the reason cannot drift with fixture order.
    const row = only([{ ts: TS_BASE, user: "UNKNOWN1", text: "  ", subtype: "bot_message" }]);
    expect(row.reason).toBe("bot_message");
  });
});

describe("source hash — raw evidence only", () => {
  const thread: SlackMessage[] = [
    { ts: TS_BASE, user: "U1", text: "shipping today", reply_count: 0 },
    { ts: TS_BASE_NEXT_MICRO, thread_ts: TS_BASE, user: "U2", text: "on it" },
  ];

  it("does not move when a display name changes", () => {
    const before = project(thread).messages.map((m) => m.sourceHash);
    const after = project(thread, {
      users: {
        ...users,
        U1: { ...users.U1, displayName: "Alexandra Ruiz-Nakamura" },
        U2: { ...users.U2, displayName: "riley.k" },
      },
    }).messages.map((m) => m.sourceHash);
    expect(after).toEqual(before);
  });

  it("does not move when the ROOT's reply_count changes as a reply arrives", () => {
    // Otherwise every reply rewrites the root's evidence hash and the ledger reports a semantic
    // change on a message nobody touched.
    const before = only([{ ts: TS_BASE, user: "U1", text: "shipping today", reply_count: 0 }]).sourceHash;
    const after = only([{ ts: TS_BASE, user: "U1", text: "shipping today", reply_count: 7 }]).sourceHash;
    expect(after).toBe(before);
  });

  it("MOVES when raw text, subtype, author or thread placement changes", () => {
    const base = only([{ ts: TS_BASE, user: "U1", text: "shipping today" }]).sourceHash;
    expect(only([{ ts: TS_BASE, user: "U1", text: "shipping tomorrow" }]).sourceHash).not.toBe(base);
    expect(only([{ ts: TS_BASE, user: "U1", text: "shipping today", subtype: "bot_message" }]).sourceHash).not.toBe(base);
    expect(only([{ ts: TS_BASE, user: "U2", text: "shipping today" }]).sourceHash).not.toBe(base);
    expect(
      only([{ ts: TS_BASE, thread_ts: TS_BEFORE_MIDNIGHT, user: "U1", text: "shipping today" }]).sourceHash
    ).not.toBe(base);
  });

  it("is stable across runs and hex-shaped", () => {
    const a = only([{ ts: TS_BASE, user: "U1", text: "same" }]).sourceHash;
    expect(only([{ ts: TS_BASE, user: "U1", text: "same" }]).sourceHash).toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
