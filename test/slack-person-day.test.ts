import { describe, expect, it } from "vitest";

import { projectSlackPersonDays } from "@/lib/ingest/slack-person-day";
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
});
