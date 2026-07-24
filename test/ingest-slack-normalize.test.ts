import { describe, it, expect } from "vitest";
import { normalizeThread, threadParticipants, type NormalizeOpts } from "@/lib/ingest/sources/slack-normalize";
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

  it("emits per-participant frontmatter + a readable topic title (for the timeline)", () => {
    const thread: FetchedThread = {
      root: { ts: "1718900000.000100", user: "U1", text: "shipping the dual-backend today" },
      replies: [
        { ts: "1718900100.000200", user: "U2", text: "reviewing now" },
        { ts: "1718900200.000300", user: "U2", text: "lgtm" },
      ],
    };
    const p = normalizeThread(thread, opts);

    expect(p.frontmatter.title).toBe("#eng: shipping the dual-backend today");
    const parts = p.frontmatter.participants as { author_id: string; message_count: number }[];
    expect(parts.map((x) => x.author_id).sort()).toEqual(["U1", "U2"]);
    expect(parts.find((x) => x.author_id === "U2")?.message_count).toBe(2);
  });

  it("keeps repliers OUT of actor/authors — a participant must never steal thread ownership", () => {
    // The root author (U1) owns the item; a resolvable replier (U2) is a participant only. If U2
    // leaked into `actor`/`authors`, the attribution resolver could re-point the whole thread to them.
    const thread: FetchedThread = {
      root: { ts: "1718900000.000100", user: "U1", text: "kickoff" },
      replies: [{ ts: "1718900100.000200", user: "U2", text: "here" }],
    };
    const p = normalizeThread(thread, opts);
    expect(p.actor).toBe("Alex"); // U1, the root
    expect(p.frontmatter.author_id).toBe("U1");
    expect(p.frontmatter.authors).toBeUndefined();
  });
});

describe("threadParticipants", () => {
  const users = { U1: "Alex", U2: "Riley" };

  it("counts distinct authors with first/last contribution time", () => {
    const parts = threadParticipants(
      {
        root: { ts: "1718900000.000100", user: "U1", text: "a" },
        replies: [
          { ts: "1718900300.000200", user: "U2", text: "b" },
          { ts: "1718900500.000300", user: "U2", text: "c" },
        ],
      },
      users
    );
    const u2 = parts.find((p) => p.author_id === "U2")!;
    expect(u2.message_count).toBe(2);
    expect(u2.display_name).toBe("Riley");
    // last_ts is the LATER message (their timeline "contribution time"); first_ts the earlier.
    expect(Date.parse(u2.last_ts)).toBeGreaterThan(Date.parse(u2.first_ts));
  });

  it("skips messages with no user (a connector/system post never becomes a participant)", () => {
    const parts = threadParticipants(
      { root: { ts: "1.0", user: "U1", text: "a" }, replies: [{ ts: "2.0", user: undefined, text: "sys" }] },
      users
    );
    expect(parts.map((p) => p.author_id)).toEqual(["U1"]);
  });
});
