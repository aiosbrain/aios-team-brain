import { describe, expect, it } from "vitest";

import { selectSlackCreditIds, type SlackCreditSelection } from "@/lib/attribution/contributor-credit";
import type { SlackAccountMapping } from "@/lib/identity/resolve";
import { projectScopedSlackPersonDays, projectSlackPersonDays,
  type SlackScopedPersonDayInput } from "@/lib/ingest/slack-person-day";
import type { VisibleSlackMessage } from "@/lib/ingest/slack-message-read";

const rootTs = "1718841599.999999";
const rootAt = "2024-06-19T23:59:59.999999Z";

function message(
  ts: string, at: string, author: string,
  changes: Partial<VisibleSlackMessage> = {}
): VisibleSlackMessage {
  return { itemId: "item-1", workspaceId: "T1", channelId: "C1", rootTs,
    messageTs: ts, occurredAt: at, authorExternalId: author,
    isRoot: ts === rootTs, ...changes };
}

const members = new Map([["T1:U1", "member-1"], ["T1:U2", "member-1"],
  ["T1:U3", "member-2"]]);
const resolve = (qualified: string) => members.get(qualified) ?? null;

describe("inactive Slack message to person-day projection", () => {
  it("keeps exact UTC midnight and microseconds while collapsing two linked accounts on one thread/day", () => {
    const input = [
      message(rootTs, rootAt, "U1"),
      message("1718841600.000001", "2024-06-20T00:00:00.000001Z", "U1"),
      message("1718841600.000002", "2024-06-20T00:00:00.000002Z", "U2"),
      message("1718841600.000003", "2024-06-20T00:00:00.000003Z", "U2"),
    ];
    const days = projectSlackPersonDays(input, resolve);
    expect(days.map((row) => [row.day, row.messageCount, row.at, row.rootAuthored])).toEqual([
      ["2024-06-20", 3, "2024-06-20T00:00:00.000003Z", false],
      ["2024-06-19", 1, rootAt, true],
    ]);
    expect(days[0].messages.map((m) => m.messageTs)).toEqual([
      "1718841600.000001", "1718841600.000002", "1718841600.000003",
    ]);
    expect(days[0]).toMatchObject({ sourceItemId: "item-1", workspaceId: "T1",
      channelId: "C1", rootTs, memberId: "member-1" });
    expect(days[0].id).toBe(JSON.stringify(["item-1", "member-1", "2024-06-20"]));
  });

  it("retains sparse, multi-day replies on an old thread without giving root status to repliers", () => {
    const input = [
      message(rootTs, rootAt, "UNMAPPED"),
      message("1718841600.000001", "2024-06-20T00:00:00.000001Z", "U3"),
      message("1719014400.000001", "2024-06-22T00:00:00.000001Z", "U3"),
      message("1727740800.000001", "2024-10-01T00:00:00.000001Z", "U3"),
    ];
    const days = projectSlackPersonDays(input, resolve);
    expect(days.map((row) => row.day)).toEqual(["2024-10-01", "2024-06-22", "2024-06-20"]);
    expect(days.every((row) => row.memberId === "member-2" && !row.rootAuthored)).toBe(true);
    expect(days.every((row) => row.sourceItemId === "item-1" && row.rootTs === rootTs)).toBe(true);
    // Reader removes a tombstoned root; the same surviving replies retain the same days and IDs.
    expect(projectSlackPersonDays(input.slice(1), resolve)).toEqual(days);
  });

  it("keeps root authorship with its actual author when a different member replies that day", () => {
    const sameDayRoot = "1718841599.000001";
    const input = [
      message(sameDayRoot, "2024-06-19T23:59:59.000001Z", "U1",
        { rootTs: sameDayRoot, isRoot: true }),
      message("1718841599.000002", "2024-06-19T23:59:59.000002Z", "U3",
        { rootTs: sameDayRoot }),
    ];
    const days = projectSlackPersonDays(input, resolve);
    expect(days.map((row) => [row.memberId, row.rootAuthored])).toEqual([
      ["member-2", false], ["member-1", true],
    ]);
    expect(projectSlackPersonDays(input.slice(1), resolve)).toMatchObject([
      { memberId: "member-2", rootAuthored: false },
    ]);
  });

  it("passes only qualified authors to the resolver and leaves ambiguous or unmapped accounts uncredited", () => {
    const visited: string[] = [];
    const resolver = (qualified: string) => {
      visited.push(qualified);
      return qualified === "T1:U1" ? "member-1" : null;
    };
    const days = projectSlackPersonDays([
      message("1718841600.000001", "2024-06-20T00:00:00.000001Z", "U1"),
      message("1718841600.000002", "2024-06-20T00:00:00.000002Z", "UAMBIG"),
    ], resolver);
    expect(visited).toEqual(["T1:U1", "T1:UAMBIG"]);
    expect(days).toHaveLength(1);
    expect(days[0].messageCount).toBe(1);
    expect(() => projectSlackPersonDays([message(rootTs, rootAt, "U1")], () => {
      throw new Error("identity unavailable");
    })).toThrow("identity unavailable");
    expect(projectSlackPersonDays([message(rootTs, rootAt, "U1", { workspaceId: "T2" })], resolver)).toEqual([]);
  });

  it("is input-order independent, removes duplicate input, and rejects conflicting item or message identity", () => {
    const a = message(rootTs, rootAt, "U1");
    const b = message("1718841600.000002", "2024-06-20T00:00:00.000002Z", "U2");
    const c = message("1718841600.000001", "2024-06-20T00:00:00.000001Z", "U3");
    const expected = projectSlackPersonDays([a, b, c], resolve);
    expect(projectSlackPersonDays([c, b, a, b], resolve)).toEqual(expected);
    expect(expected.map((row) => row.memberId)).toEqual(["member-1", "member-2", "member-1"]);
    expect(() => projectSlackPersonDays([a, { ...a, authorExternalId: "U3" }], resolve))
      .toThrow("conflicting source message");
    expect(() => projectSlackPersonDays([a, { ...b, rootTs: "other-root" }], resolve))
      .toThrow("conflicting thread identity");
  });

  it("rejects a persisted instant that disagrees with the source timestamp", () => {
    expect(() => projectSlackPersonDays([
      message(rootTs, "2024-06-20T00:00:00.000000Z", "U1"),
    ], resolve)).toThrow("invalid source message");
  });
});

const TEAM = "team-1";
const A = "member-1";
const B = "member-2";
const C = "member-3";

function mapping(externalId: string, memberId: string,
  changes: Partial<SlackAccountMapping> = {}): SlackAccountMapping {
  return { teamId: TEAM, provider: "slack", externalId, memberId, state: "live", ...changes };
}

function selection(authors: readonly (string | null)[],
  locked = false, owner: string | null = null): SlackCreditSelection {
  return selectSlackCreditIds({ locked, currentMemberId: owner,
    messageLedger: { status: "present", resolvedHumanMemberIds: authors },
    participants: { status: "absent" }, legacyVersionMemberIds: [], legacyLatestWorkerId: null });
}

function scoped(overrides: Partial<SlackScopedPersonDayInput> = {}): SlackScopedPersonDayInput {
  return {
    teamId: TEAM,
    visibleMessages: [
      message(rootTs, rootAt, "U1"),
      message("1718841600.000001", "2024-06-20T00:00:00.000001Z", "U2"),
      message("1718841600.000002", "2024-06-20T00:00:00.000002Z", "U3"),
      message("1719014400.000001", "2024-06-22T00:00:00.000001Z", "U3"),
    ],
    mappings: [mapping("T1:U1", A), mapping("T1:U2", A), mapping("T1:U3", B)],
    humanMemberIds: new Set([A, B, C]),
    creditByItem: new Map([["item-1", selection([A, A, B, B])]]),
    ...overrides,
  };
}

describe("inactive team-scoped factual Slack person-days", () => {
  it("keeps each actual author's UTC days, merges qualified accounts, and sorts independent of input order", () => {
    const input = scoped();
    const days = projectScopedSlackPersonDays(input);
    expect(days.map((day) => [day.day, day.memberId, day.messageCount, day.rootAuthored])).toEqual([
      ["2024-06-22", B, 1, false],
      ["2024-06-20", B, 1, false],
      ["2024-06-20", A, 1, false],
      ["2024-06-19", A, 1, true],
    ]);
    expect(days[0].at).toBe("2024-06-22T00:00:00.000001Z");
    expect(projectScopedSlackPersonDays({ ...input,
      visibleMessages: [...input.visibleMessages].reverse(), mappings: [...input.mappings].reverse(),
    })).toEqual(days);

    const sameMember = projectScopedSlackPersonDays(scoped({ visibleMessages: [
      message("1718841600.000001", "2024-06-20T00:00:00.000001Z", "U1"),
      message("1718841600.000002", "2024-06-20T00:00:00.000002Z", "U2"),
    ] }));
    expect(sameMember).toMatchObject([{ memberId: A, day: "2024-06-20", messageCount: 2 }]);
    expect(sameMember[0].messages.map((entry) => entry.messageTs))
      .toEqual(["1718841600.000001", "1718841600.000002"]);
  });

  it("uses only exact live account mappings in the source workspace and current human roster", () => {
    const input = scoped({
      visibleMessages: [
        message(rootTs, rootAt, "U1"),
        message("1718841600.000001", "2024-06-20T00:00:00.000001Z", "U2"),
        message("1718841600.000002", "2024-06-20T00:00:00.000002Z", "U3"),
        message("1718841600.000003", "2024-06-20T00:00:00.000003Z", "U4"),
        message("1718841600.000004", "2024-06-20T00:00:00.000004Z", "U5"),
        message("1718841600.000005", "2024-06-20T00:00:00.000005Z", "U6"),
        message("1718841600.000006", "2024-06-20T00:00:00.000006Z", "U7"),
        message("1718841600.000007", "2024-06-20T00:00:00.000007Z", "U8"),
      ],
      mappings: [mapping("T2:U1", A), mapping("T1:U1", A, { state: "archived" }),
        mapping("U2", A), mapping("T1:U3", A), mapping("T1:U3", A),
        mapping("t1:U4", A), mapping("T1:U5", A, { provider: "Slack" }),
        mapping("T1:U6", A, { teamId: "other-team" }),
        mapping("T1:U7", "connector"), mapping("T1:U8", A)],
      creditByItem: new Map([["item-1", selection([A])]]),
    });
    const days = projectScopedSlackPersonDays(input);
    expect(days).toMatchObject([{ memberId: A, messageCount: 1,
      messages: [{ messageTs: "1718841600.000007" }] }]);
    expect(projectScopedSlackPersonDays({ ...input,
      mappings: [...input.mappings, mapping("T1:U8", A, { externalId: "t1:u8" })],
    })).toEqual([]);
  });

  it("requires selected credit for the same source item and never borrows another item's credit", () => {
    const input = scoped({ visibleMessages: [message(rootTs, rootAt, "U1"),
      message(rootTs, rootAt, "U1", { itemId: "item-2", channelId: "C2" })] });
    expect(projectScopedSlackPersonDays(input).map((day) => day.sourceItemId)).toEqual(["item-1"]);
    expect(projectScopedSlackPersonDays({ ...input, creditByItem: new Map() })).toEqual([]);
    expect(projectScopedSlackPersonDays({ ...input,
      creditByItem: new Map([["item-1", selection([])]]),
    })).toEqual([]);
    expect(projectScopedSlackPersonDays({ ...input,
      creditByItem: new Map([["item-1", selection([B])]]),
    })).toEqual([]);
  });

  it("never presents legacy or participant credit as verified message-day evidence", () => {
    const input = scoped();
    for (const kind of ["structured_participants_present", "legacy_partial"] as const) {
      expect(projectScopedSlackPersonDays({ ...input,
        creditByItem: new Map([["item-1", { kind, creditIds: { contributorIds: [A, B], primaryId: A } }]]),
      })).toEqual([]);
    }
  });

  it("uses each visible item's source workspace and never emits an item absent from visible evidence", () => {
    const t1 = message(rootTs, rootAt, "U1");
    const t2 = message(rootTs, rootAt, "U1", { itemId: "item-2", workspaceId: "T2", channelId: "C2" });
    const input = scoped({ visibleMessages: [t1, t2],
      mappings: [mapping("T1:U1", A), mapping("T2:U1", B)],
      creditByItem: new Map([["item-1", selection([A])], ["item-2", selection([B])]]),
    });
    expect(projectScopedSlackPersonDays(input).map((day) =>
      [day.sourceItemId, day.workspaceId, day.memberId])).toEqual([
      ["item-1", "T1", A], ["item-2", "T2", B],
    ]);
    expect(projectScopedSlackPersonDays({ ...input, visibleMessages: [t1] })
      .map((day) => day.sourceItemId)).toEqual(["item-1"]);
  });

  it("honors a correction lock only on the corrected owner's actual message days", () => {
    const input = scoped({ creditByItem: new Map([["item-1", selection([A, A, B], true, B)]]) });
    expect(projectScopedSlackPersonDays(input).map((day) => [day.day, day.memberId]))
      .toEqual([["2024-06-22", B], ["2024-06-20", B]]);
    expect(projectScopedSlackPersonDays({ ...input,
      creditByItem: new Map([["item-1", selection([A, A, B], true, C)]]),
    })).toEqual([]);
    expect(projectScopedSlackPersonDays({ ...input,
      creditByItem: new Map([["item-1", selection([A, A, B], true, null)]]),
    })).toEqual([]);
    expect(projectScopedSlackPersonDays({ ...input,
      creditByItem: new Map([["item-1", selection([A, A, B])]]),
    }).map((day) => day.memberId)).toEqual([B, B, A, A]);
  });

  it("rejects incomplete upstream arrays and malformed selections instead of treating them as empty", () => {
    const input = scoped();
    expect(() => projectScopedSlackPersonDays({ ...input,
      visibleMessages: undefined as unknown as VisibleSlackMessage[],
    })).toThrow("incomplete projection input");
    for (const invalid of [undefined, { status: "failed" }, { kind: "legacy_partial" },
      { kind: "verified_message_ledger_present", creditIds: undefined },
      { kind: "verified_message_ledger_present", creditIds: { contributorIds: null, primaryId: A } }]) {
      expect(() => projectScopedSlackPersonDays({ ...input,
        creditByItem: new Map([["item-1", invalid as SlackCreditSelection]]),
      })).toThrow("invalid credit selection");
    }
  });
});
