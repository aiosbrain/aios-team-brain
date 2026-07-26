import { describe, it, expect } from "vitest";
import {
  normalizeThread,
  threadParticipants,
  slackChannelPathPrefix,
  type NormalizeOpts,
} from "@/lib/ingest/sources/slack-normalize";
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
    // Keyed on the immutable channel ID, not the display name (which is mutable — see the rename spec).
    expect(p.path).toBe("slack/c0b8v119g4d/1718900000.000100.md");
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

/**
 * Spec: an item's PATH is its identity, so it must be keyed on something immutable. The Slack display
 * name is neither immutable nor lossless, and both properties caused real corruption:
 *  • RENAME — every thread re-keys to a new path, creating a duplicate item per thread. Nothing
 *    diff-deletes those, so both copies live on in retrieval, credit and the timeline forever.
 *  • NON-LATIN — `safeSegment` strips everything outside [a-z0-9_-], so a CJK/emoji name collapsed to
 *    a shared fallback folder; Slack `ts` is unique only WITHIN a channel, so two such channels could
 *    land on the SAME path and overwrite each other's content every tick.
 * The display name lives in `frontmatter.channel`, which is what surfaces render.
 */
describe("normalizeThread path identity", () => {
  const thread = { root: { ts: "1718900000.000100", user: "U1", text: "hi" }, replies: [] };

  it("is STABLE across a channel rename", () => {
    const before = normalizeThread(thread, { channelId: "C0B8V119G4D", channelName: "growth", users: {} });
    const after = normalizeThread(thread, { channelId: "C0B8V119G4D", channelName: "marketing", users: {} });
    expect(after.path).toBe(before.path); // same thread → same item, no duplicate
    expect(after.frontmatter.channel).toBe("marketing"); // the new name still surfaces for display
  });

  it("keeps two non-Latin-named channels on DISTINCT paths", () => {
    // Same thread ts in two different channels — previously both collapsed to one folder and could
    // overwrite each other, because ts is only unique within a channel.
    const a = normalizeThread(thread, { channelId: "C0AAA", channelName: "日本語", users: {} });
    const b = normalizeThread(thread, { channelId: "C0BBB", channelName: "🚀", users: {} });
    expect(a.path).not.toBe(b.path);
    expect(a.frontmatter.channel).toBe("日本語"); // the real name is preserved for display
  });
});

/**
 * The removal path finds a channel's items by PATH PREFIX, so the prefix helper and the path writer
 * must agree exactly. They did not, once: the caller hand-rolled `slack/${channelId.toLowerCase()}/`
 * while the path came from `safeSegment`. A prefix that stops matching doesn't error — the purge
 * reports "0 items" and the content it was supposed to remove quietly stays.
 */
describe("slackChannelPathPrefix", () => {
  const thread = { root: { ts: "1719878400.000100", user: "U1", text: "hi" }, replies: [] };
  it("is a prefix of the path the normalizer writes", () => {
    for (const channelId of ["C0B8V119G4D", "c0lower", "C-weird.id"]) {
      const path = normalizeThread(thread, { channelId, channelName: "n", users: {} }).path;
      expect(path.startsWith(slackChannelPathPrefix(channelId))).toBe(true);
    }
  });

  it("always ends in '/' so a purge can't reach a sibling channel", () => {
    expect(slackChannelPathPrefix("C0AAA").endsWith("/")).toBe(true);
  });
});
