import { describe, it, expect } from "vitest";
import { normalizeThread, type NormalizeOpts } from "@/lib/ingest/sources/slack-normalize";
import { itemPayloadSchema } from "@/lib/api/schemas";
import type { FetchedThread } from "@/lib/ingest/sources/slack";

const opts: NormalizeOpts = {
  channelId: "C0B8V119G4D",
  channelName: "eng",
  users: { U1: "Alex", U2: "Riley" },
  project: "slack",
};

describe("normalizeThread", () => {
  it("maps a single message to a valid transcript ItemPayload", () => {
    const thread: FetchedThread = {
      root: { ts: "1718900000.000100", user: "U1", text: "shipping the dual-backend today" },
      replies: [],
    };
    const p = normalizeThread(thread, opts);

    // conforms to the brain contract
    expect(() => itemPayloadSchema.parse(p)).not.toThrow();
    expect(p.kind).toBe("transcript");
    expect(p.path).toBe("slack/eng/1718900000.000100.md");
    expect(p.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(p.actor).toBe("Alex");
    expect(p.body).toContain("shipping the dual-backend today");
    expect(p.frontmatter.channel_id).toBe("C0B8V119G4D");
    expect(p.frontmatter.reply_count).toBe(0);
  });

  it("resolves @mentions and links, and appends thread replies", () => {
    const thread: FetchedThread = {
      root: { ts: "1718900100.000200", user: "U1", text: "hey <@U2> see <https://x.com|the doc>" },
      replies: [{ ts: "1718900200.000300", user: "U2", text: "on it" }],
    };
    const p = normalizeThread(thread, opts);
    expect(p.body).toContain("@Riley");
    expect(p.body).toContain("the doc (https://x.com)");
    expect(p.body).toContain("on it");
    expect(p.frontmatter.reply_count).toBe(1);
  });

  it("is deterministic — same thread yields the same sha (dedup-stable)", () => {
    const thread: FetchedThread = {
      root: { ts: "1718900300.000400", user: "U1", text: "same" },
      replies: [],
    };
    expect(normalizeThread(thread, opts).content_sha256).toBe(
      normalizeThread(thread, opts).content_sha256
    );
  });

  it("falls back to a safe path segment when the channel name is missing", () => {
    const p = normalizeThread(
      { root: { ts: "1.0", user: "U1", text: "x" }, replies: [] },
      { ...opts, channelName: "" }
    );
    expect(p.path).toMatch(/^slack\/[a-z0-9_-]+\/1\.0\.md$/);
  });
});
