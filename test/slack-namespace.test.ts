import { describe, expect, it } from "vitest";
import {
  parseSlackItemPath,
  scopedSlackChannelPathPrefix,
  scopedSlackItemPath,
} from "@/lib/ingest/sources/slack-namespace";

/**
 * Spec for the Slack item-path NAMESPACE (AIO-1170, packet 3 — a pure helper nothing imports yet).
 *
 * The product outcome it serves: a Slack thread's path is its item identity, and today that path
 * (`slack/<channel>/<root-ts>.md`) carries no workspace. Two workspaces that share a channel id — or
 * one AIOS team connected to two workspaces — therefore collide on one identity. The design doc's
 * canonical path is `slack/<workspace>/<channel>/<root-ts>.md`, and moving to it needs one shared
 * reader that can tell the two stored shapes apart WITHOUT inventing the workspace the old shape
 * never recorded.
 *
 * So the contract under test is deliberately narrow, and every assertion is written from it:
 *
 *  • PARSING IS NOT IDENTITY. A three-segment path yields a `channelSegment` — a string that was on
 *    disk. It may be an old display-name slug; it is not proof of a channel ID, and it never acquires
 *    a workspace. The parsed shape is asserted key-for-key so no identity field can appear by
 *    accident.
 *  • THE STRING IS THE IDENTITY. Segments and the root `ts` come back byte-exact — never lowercased,
 *    trimmed or re-rendered from a parsed number. Two `ts` strings that denote the same instant are
 *    two different paths, because that is what the uniqueness constraint sees.
 *  • INVALID INPUT IS REJECTED, NEVER REPAIRED. `safeSegment` exists to coerce anything into a
 *    segment; that behaviour is exactly wrong here, because coercion maps a malformed stored path
 *    onto a VALID one belonging to somebody else. Rejection is `null` (parse) or a throw (build).
 *
 * Explicitly NOT in scope, and asserted nowhere below: whether a workspace/channel id is genuine,
 * whether an item may be published at a scoped path, and any migration of stored paths. Those are the
 * later gate/migration packets, which own the persisted provenance this file cannot see.
 */

/** 2024-06-20T16:13:20.000100Z */
const TS = "1718900000.000100";
/** …and its next-microsecond neighbour: a different message, therefore a different path. */
const TS_NEXT_MICRO = "1718900000.000101";

const WORKSPACE = "T0AAAAAAA";
const CHANNEL = "C0B8V119G4D";

describe("parseSlackItemPath — legacy (three-segment) paths", () => {
  it("parses an ID-keyed legacy path without claiming a workspace or an ID", () => {
    const parsed = parseSlackItemPath("slack/c0b8v119g4d/1718900000.000100.md");

    // Key-for-key: a `workspaceId`/`channelId` field appearing here would launder a path segment
    // into verified identity, which is the whole failure this module is shaped to avoid.
    expect(parsed && Object.keys(parsed).sort()).toEqual(["channelSegment", "kind", "rootTs"]);
    expect(parsed).toEqual({ kind: "legacy", channelSegment: "c0b8v119g4d", rootTs: TS });
  });

  it("parses an old display-name slug into the SAME shape — a slug is not a lesser kind of id", () => {
    const parsed = parseSlackItemPath("slack/all-vibrana/1718900000.000100.md");

    expect(parsed).toEqual({ kind: "legacy", channelSegment: "all-vibrana", rootTs: TS });
    // Nothing distinguishes the two legacy fixtures structurally, which is the point: the parser
    // cannot tell a channel id from a name slug, so it must not pretend either way.
    expect(parsed && Object.keys(parsed).sort()).toEqual(["channelSegment", "kind", "rootTs"]);
  });

  it("accepts the full safeSegment alphabet (letters, digits, underscore, hyphen)", () => {
    expect(parseSlackItemPath("slack/eng_team-2/1718900000.000100.md")).toEqual({
      kind: "legacy",
      channelSegment: "eng_team-2",
      rootTs: TS,
    });
    // safeSegment's own empty-name fallback is a real stored segment too.
    expect(parseSlackItemPath("slack/channel/1718900000.000100.md")).toMatchObject({
      kind: "legacy",
      channelSegment: "channel",
    });
  });
});

describe("parseSlackItemPath — scoped (four-segment) paths", () => {
  it("returns both namespace segments and the exact root ts", () => {
    const parsed = parseSlackItemPath("slack/t0aaaaaaa/c0b8v119g4d/1718900000.000100.md");

    expect(parsed).toEqual({
      kind: "scoped",
      workspaceSegment: "t0aaaaaaa",
      channelSegment: "c0b8v119g4d",
      rootTs: TS,
    });
    expect(parsed && Object.keys(parsed).sort()).toEqual([
      "channelSegment",
      "kind",
      "rootTs",
      "workspaceSegment",
    ]);
  });

  it("keeps the same channel + root ts in two workspaces distinct", () => {
    const a = parseSlackItemPath("slack/t0aaaaaaa/c0b8v119g4d/1718900000.000100.md");
    const b = parseSlackItemPath("slack/t0bbbbbbb/c0b8v119g4d/1718900000.000100.md");

    expect(a).not.toEqual(b);
    expect(a && "workspaceSegment" in a && a.workspaceSegment).toBe("t0aaaaaaa");
    expect(b && "workspaceSegment" in b && b.workspaceSegment).toBe("t0bbbbbbb");
  });

  it("preserves stored segment case — parsing is not an authorized migration", () => {
    // A scoped path that was stored with upper-case ids reads back exactly as stored. Canonicalizing
    // it here would silently report a path that is NOT the one the uniqueness constraint holds.
    expect(parseSlackItemPath("slack/T0AAAAAAA/C0B8V119G4D/1718900000.000100.md")).toEqual({
      kind: "scoped",
      workspaceSegment: "T0AAAAAAA",
      channelSegment: "C0B8V119G4D",
      rootTs: TS,
    });
  });
});

describe("root timestamps are strings, not reconstructed numbers", () => {
  it("keeps two microsecond-apart roots distinct end to end", () => {
    const first = scopedSlackItemPath(WORKSPACE, CHANNEL, TS);
    const second = scopedSlackItemPath(WORKSPACE, CHANNEL, TS_NEXT_MICRO);

    expect(first).not.toBe(second);
    expect(parseSlackItemPath(first)?.rootTs).toBe(TS);
    expect(parseSlackItemPath(second)?.rootTs).toBe(TS_NEXT_MICRO);
  });

  it("round-trips the ts bytes, including trailing and leading zeros", () => {
    for (const ts of ["1718900000.000100", "1718900000.000000", "1718900000.0", "0123456789.000001"]) {
      const path = scopedSlackItemPath(WORKSPACE, CHANNEL, ts);
      expect(path.endsWith(`/${ts}.md`)).toBe(true);
      expect(parseSlackItemPath(path)?.rootTs).toBe(ts);
    }
  });

  it("treats two spellings of ONE instant as two paths", () => {
    // `1718900000.0` and `1718900000.000000` are the same moment and different Slack `ts` strings.
    // The path is an identity, and the DB compares identities as text, so normalizing one onto the
    // other here would report a collision that does not exist (or hide one that does).
    expect(scopedSlackItemPath(WORKSPACE, CHANNEL, "1718900000.0")).not.toBe(
      scopedSlackItemPath(WORKSPACE, CHANNEL, "1718900000.000000")
    );
  });
});

describe("scoped builders", () => {
  it("canonicalizes provider ids to lower case and produces the design's path", () => {
    expect(scopedSlackItemPath(WORKSPACE, CHANNEL, TS)).toBe(
      "slack/t0aaaaaaa/c0b8v119g4d/1718900000.000100.md"
    );
    // Already-lower input is unchanged — canonicalization is idempotent.
    expect(scopedSlackItemPath("t0aaaaaaa", "c0b8v119g4d", TS)).toBe(
      scopedSlackItemPath(WORKSPACE, CHANNEL, TS)
    );
  });

  it("ends the channel prefix at the slash, so siblings cannot share it", () => {
    const prefix = scopedSlackChannelPathPrefix("T1", "C1");

    expect(prefix).toBe("slack/t1/c1/");
    expect(scopedSlackItemPath("T1", "C1", TS).startsWith(prefix)).toBe(true);
    // C10 merely STARTS with C1 — without the trailing slash a prefix read would sweep it in.
    expect(scopedSlackItemPath("T1", "C10", TS).startsWith(prefix)).toBe(false);
    // Same channel id, another workspace: a different namespace entirely.
    expect(scopedSlackItemPath("T2", "C1", TS).startsWith(prefix)).toBe(false);
    // And the workspace prefix is not a channel prefix.
    expect(scopedSlackItemPath("T1", "C1", TS).startsWith("slack/t1/c10/")).toBe(false);
  });

  it("agrees with the path builder segment for segment", () => {
    expect(scopedSlackItemPath(WORKSPACE, CHANNEL, TS).startsWith(
      scopedSlackChannelPathPrefix(WORKSPACE, CHANNEL)
    )).toBe(true);
  });

  it("refuses a legacy name slug rather than guessing what workspace it belonged to", () => {
    // The exact shape of the migration temptation: an old three-segment path's channel segment,
    // handed to the scoped builder. It is not alphanumeric, and even if it were, syntax is not
    // provenance — a workspace can only come from the later verified-provenance gate.
    expect(() => scopedSlackItemPath(WORKSPACE, "old-channel-name", TS)).toThrow(TypeError);
    expect(() => scopedSlackChannelPathPrefix(WORKSPACE, "old-channel-name")).toThrow(TypeError);
    expect(() => scopedSlackItemPath("", CHANNEL, TS)).toThrow(TypeError);
    expect(() => scopedSlackChannelPathPrefix("", CHANNEL)).toThrow(TypeError);
  });

  it("rejects unsafe ids outright — there is no sanitizing fallback", () => {
    const unsafe = [
      "C 1", // whitespace
      "c1/c2", // slash injection
      "..",
      ".",
      "%", // LIKE wildcard: this builder is a path helper, never an escaped SQL pattern
      "c%1",
      "T1:C1", // the evidence ledger's id delimiter
      "c1#frag",
      "c1?x=1",
      "c%2Fc2", // percent escape
      "c1\n",
      "chännel", // non-ASCII: safeSegment would have collapsed this; here it is a refusal
    ];
    for (const bad of unsafe) {
      expect(() => scopedSlackItemPath(WORKSPACE, bad, TS), `channel ${JSON.stringify(bad)}`).toThrow(
        TypeError
      );
      expect(() => scopedSlackItemPath(bad, CHANNEL, TS), `workspace ${JSON.stringify(bad)}`).toThrow(
        TypeError
      );
      expect(() => scopedSlackChannelPathPrefix(WORKSPACE, bad)).toThrow(TypeError);
    }
  });

  it("rejects a root ts that is not an exact Slack timestamp", () => {
    for (const bad of ["", "1718900000", "1718900000.", "1718900000.0001001", " 1718900000.000100", "abc", "1718900000.000100.md", "0.000100", "-1.000000", "1e9.000100"]) {
      expect(() => scopedSlackItemPath(WORKSPACE, CHANNEL, bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });
});

describe("parseSlackItemPath rejects anything that is not exactly one of the two shapes", () => {
  const rejected: [string, string][] = [
    ["a non-slack source", "github/acme-app/1718900000.000100.md"],
    ["source segment only", "slack"],
    ["a channel folder with no file", "slack/c1/"],
    ["two segments", "slack/1718900000.000100.md"],
    ["five segments", "slack/t1/c1/sub/1718900000.000100.md"],
    ["a leading slash", "/slack/c1/1718900000.000100.md"],
    ["a trailing slash", "slack/t1/c1/1718900000.000100.md/"],
    ["an empty middle segment", "slack//c1/1718900000.000100.md"],
    ["a dot segment", "slack/./1718900000.000100.md"],
    ["a traversal segment", "slack/../1718900000.000100.md"],
    ["traversal in a scoped path", "slack/t1/../1718900000.000100.md"],
    ["a backslash", "slack\\c1\\1718900000.000100.md"],
    ["whitespace in a segment", "slack/c 1/1718900000.000100.md"],
    ["a trailing space", "slack/t1/c1/1718900000.000100.md "],
    ["a query tail", "slack/t1/c1/1718900000.000100.md?x=1"],
    ["a fragment tail", "slack/t1/c1/1718900000.000100.md#top"],
    ["a URL", "https://example.test/slack/c1/1718900000.000100.md"],
    ["a percent escape", "slack/c%2Fc1/1718900000.000100.md"],
    ["a LIKE wildcard", "slack/%/1718900000.000100.md"],
    ["a wildcard inside a scoped segment", "slack/t1/c%/1718900000.000100.md"],
    ["the id delimiter", "slack/t1:c1/1718900000.000100.md"],
    ["a legacy-alphabet character in a scoped segment", "slack/t_1/c1/1718900000.000100.md"],
    ["a hyphen slug in a scoped segment", "slack/t1/old-channel-name/1718900000.000100.md"],
    ["the wrong extension", "slack/c1/1718900000.000100.txt"],
    ["an upper-case extension", "slack/c1/1718900000.000100.MD"],
    ["no extension", "slack/c1/1718900000.000100"],
    ["a seconds-only timestamp", "slack/c1/1718900000.md"],
    ["too many fractional digits", "slack/c1/1718900000.0001001.md"],
    ["a non-numeric root", "slack/c1/thread.md"],
    ["a zero epoch", "slack/c1/0.000100.md"],
    ["an empty string", ""],
  ];

  for (const [label, path] of rejected) {
    it(`returns null for ${label}`, () => {
      expect(parseSlackItemPath(path)).toBeNull();
    });
  }

  it("never repairs a rejected path into a valid identity", () => {
    // The failure mode this rules out: a helper that trims, drops an empty segment or safeSegments a
    // bad one, and hands back the path of a DIFFERENT, real thread.
    const nearMisses = [
      "slack//c0b8v119g4d/1718900000.000100.md",
      "slack/c0b8v119g4d/1718900000.000100.md ",
      "slack/C0B8V119G4D /1718900000.000100.md",
      "slack/t0aaaaaaa/c0b8v119g4d/../c0b8v119g4e/1718900000.000100.md",
    ];
    for (const path of nearMisses) {
      expect(parseSlackItemPath(path), path).toBeNull();
    }
  });

  it("is total over junk input", () => {
    for (const junk of [undefined, null, 42, {}, [], true]) {
      expect(parseSlackItemPath(junk as unknown as string)).toBeNull();
    }
  });
});

describe("purity", () => {
  it("is deterministic and free of ambient state", () => {
    const first = parseSlackItemPath(scopedSlackItemPath(WORKSPACE, CHANNEL, TS));
    const second = parseSlackItemPath(scopedSlackItemPath(WORKSPACE, CHANNEL, TS));
    expect(first).toEqual(second);
    // Parsing does not hand back a mutable view of anything shared.
    expect(first).not.toBe(second);
  });

  it("does not mutate or normalize its inputs", () => {
    const ts = `${TS}`;
    scopedSlackItemPath(WORKSPACE, CHANNEL, ts);
    expect(ts).toBe(TS);
    expect(WORKSPACE).toBe("T0AAAAAAA");
  });
});
