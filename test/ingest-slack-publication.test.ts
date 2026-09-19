import { describe, expect, it } from "vitest";
import type { TransactionSession } from "@/lib/db/types";
import type { ItemPayload } from "@/lib/api/schemas";
import { prepareSlackPublication, slackPublicationOption, type SlackPublicationOption } from "@/lib/ingest/slack-publication";

const TEAM = "00000000-0000-4000-8000-000000000001";
const ROOT = "1718900000.000100";
const claim = {
  scope: { teamId: TEAM, workspaceId: "T1", channelId: "C1", rootTs: ROOT },
  leaseOwner: "owner", leaseGeneration: 1, leaseExpiresAt: "2026-09-19T00:00:00.000Z",
  attempts: 1, pageCursor: null, snapshotGeneration: 1,
};
const option = slackPublicationOption({ claim, binding: { teamId: TEAM,
  integrationId: "00000000-0000-4000-8000-000000000002",
  configRevision: "a".repeat(64), tokenFingerprint: "b".repeat(64) },
  namespaceRevision: 0, channelName: "general", users: {} });
const payload = {
  project: "slack", path: `slack/t1/c1/${ROOT}.md`, kind: "transcript",
  access: "team", actor: "", body: "body", content_sha256: "a".repeat(64),
  frontmatter: { source: "slack", workspace_id: "T1", channel_id: "C1", ts: ROOT, thread_ts: ROOT },
} satisfies ItemPayload;

describe("inactive Slack publication option preflight", () => {
  it("captures an immutable claim and author directory across asynchronous publication", () => {
    const mutableClaim = { ...claim, scope: { ...claim.scope } };
    const users = { U1: { displayName: "first", isBot: false, isAppUser: false } };
    const captured = slackPublicationOption({ ...option, claim: mutableClaim, users });
    mutableClaim.scope.channelId = "C2";
    users.U1.displayName = "second";
    expect(captured.claim.scope.channelId).toBe("C1");
    expect(captured.users.U1.displayName).toBe("first");
  });

  it("refuses an unbranded option and mismatched scope before touching SQL", async () => {
    const session = { executeSql: () => { throw new Error("SQL must not run"); } } as unknown as TransactionSession;
    const unbranded = { claim: option.claim, binding: option.binding,
      namespaceRevision: option.namespaceRevision, channelName: option.channelName,
      users: option.users } as SlackPublicationOption;
    await expect(prepareSlackPublication(session, TEAM, payload, unbranded)).rejects.toThrow(/refused/);
    await expect(prepareSlackPublication(session, TEAM, { ...payload, path: "slack/t1/c2/fake.md" }, option))
      .rejects.toThrow(/refused/);
    await expect(prepareSlackPublication(session, TEAM, { ...payload,
      frontmatter: { ...payload.frontmatter, workspace_id: "T2" } }, option))
      .rejects.toThrow(/refused/);
  });
});
