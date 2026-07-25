import { describe, expect, it } from "vitest";
import { slackParticipations, slackContributors, foldProviderId } from "@/lib/ingest/slack-participants";

/**
 * Spec for the CONVERSATION work ledger. A Slack thread is ONE item rewritten on every reply, and each
 * version is stamped with the thread-ROOT author — so version authors are not the people who worked.
 * `participants[]` is, and this pins the extraction the credit oracle relies on.
 */
describe("slackContributors (the conversation work ledger)", () => {
  it("returns every distinct participant in work order (oldest last-message first)", () => {
    expect(
      slackContributors({
        source: "slack",
        participants: [
          { author_id: "UROOT", last_ts: "2026-07-01T10:00:00Z" },
          { author_id: "UREPLY", last_ts: "2026-07-03T10:00:00Z" },
          { author_id: "UMID", last_ts: "2026-07-02T10:00:00Z" },
        ],
      })
    ).toEqual(["UROOT", "UMID", "UREPLY"]);
  });

  it("is empty for a non-Slack item (versions stay in charge)", () => {
    expect(slackContributors({ source: "github", participants: [{ author_id: "U1" }] })).toEqual([]);
  });

  it("is empty for a Slack thread with no participants ledger (pre-ledger items)", () => {
    expect(slackContributors({ source: "slack" })).toEqual([]);
    expect(slackContributors(null)).toEqual([]);
  });

  it("ignores malformed entries rather than crediting a blank", () => {
    expect(
      slackContributors({ source: "slack", participants: [{ author_id: "" }, { author_id: 42 }, { author_id: "U9" }] })
    ).toEqual(["U9"]);
  });
});

describe("slackParticipations (entries the timeline needs)", () => {
  it("keeps each author's LATEST contribution time and orders oldest-first", () => {
    expect(
      slackParticipations({
        source: "slack",
        participants: [
          { author_id: "UA", last_ts: "2026-07-01T10:00:00Z" },
          { author_id: "UB", last_ts: "2026-07-03T10:00:00Z" },
          { author_id: "UA", last_ts: "2026-07-04T10:00:00Z" }, // duplicate author, later message
        ],
      })
    ).toEqual([
      { authorId: "UB", lastTs: "2026-07-03T10:00:00Z" },
      { authorId: "UA", lastTs: "2026-07-04T10:00:00Z" },
    ]);
  });
});

describe("foldProviderId", () => {
  it("folds case and trims, matching lib/identity/resolve.providerKey", () => {
    expect(foldProviderId("  U0123ABC ")).toBe("u0123abc");
  });
});
