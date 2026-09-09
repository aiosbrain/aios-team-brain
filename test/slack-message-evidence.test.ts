import { describe, expect, it } from "vitest";
import {
  projectSlackMessageEvidence,
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

const HUMAN: SlackEvidenceUser = { displayName: "Alex" };
const users: Record<string, SlackEvidenceUser> = {
  U1: HUMAN,
  U2: { displayName: "Riley" },
  UBOT: { displayName: "Deploybot", isBot: true },
  UAPP: { displayName: "Notion", isAppUser: true },
  UGUEST: { displayName: "Sam (guest)", isRestricted: true },
  UGONE: { displayName: "Former Teammate", deleted: true },
};

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
    expect(out.conflictingDuplicateCount).toBe(0);
  });

  it("keeps the first observation but COUNTS a duplicate that disagrees, rather than dropping it silently", () => {
    // Overlapping pages can straddle an edit. Losing that quietly would make the ledger's change
    // detection wrong with no trace; the count is the trace.
    const out = project([
      { ts: TS_BASE, user: "U1", text: "original" },
      { ts: TS_BASE, user: "U1", text: "edited mid-scan" },
    ]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].sourceHash).toBe(only([{ ts: TS_BASE, user: "U1", text: "original" }]).sourceHash);
    expect(out.duplicateCount).toBe(1);
    expect(out.conflictingDuplicateCount).toBe(1);
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

  it("still credits guests and deactivated people — they are source identities, not bots", () => {
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

  it("excludes structural and file-only messages with a reason, keeping the current ingest filter", () => {
    for (const subtype of ["channel_join", "channel_leave", "channel_topic", "file_share", "message_changed"]) {
      const row = only([{ ts: TS_BASE, user: "U1", text: "x", subtype }]);
      expect(row.status).toBe("excluded");
      expect(row.reason).toBe("unsupported_subtype");
      expect(row.subtype).toBe(subtype);
    }
  });

  it("excludes a message with no renderable text (an attachment-only post)", () => {
    for (const text of [undefined, "", "   \n "]) {
      const row = only([{ ts: TS_BASE, user: "U1", text }]);
      expect(row.status).toBe("excluded");
      expect(row.reason).toBe("no_text");
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
      users: { ...users, U1: { displayName: "Alexandra Ruiz-Nakamura" }, U2: { displayName: "riley.k" } },
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
