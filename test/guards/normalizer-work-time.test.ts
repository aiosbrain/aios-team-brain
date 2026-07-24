import { describe, expect, it } from "vitest";
import { resolveWorkTime } from "@/lib/ingest/work-time";
import { normalizeThread } from "@/lib/ingest/sources/slack-normalize";
import { normalizeGithubFiles } from "@/lib/ingest/sources/github-files-normalize";
import { normalizeCommit } from "@/lib/codebases/commits-to-items";

/**
 * BUILD-FAILING GUARD: each connector's normalized payload either carries a resolvable WORK-TIME or
 * is explicitly listed as known-undated.
 *
 * The failure this prevents is silent by construction. An item with no resolvable work-time is
 * DROPPED by the timeline builder — ingested, attributed, searchable, and completely invisible in
 * the Timeline / "Working on". Nothing errors; the source looks healthy. That is exactly how
 * Notion / Google Drive / Confluence / web docs and every `github-files` repo doc went missing: the
 * key list had been extended with names no connector actually emits, so its coverage was vacuous.
 *
 * The invariant is therefore asserted at the SOURCE — each normalizer's own output — rather than
 * trusting that a key list and a producer happen to agree.
 *
 * SCOPE, stated honestly: this enumerates the normalizers rather than discovering them, so a NEW
 * connector is only covered once added below — adding it is the ask. `KNOWN_UNDATED` records the
 * producers that genuinely emit no time key today, so the gap is visible in code review instead of
 * being mistaken for coverage (their doc items are dated `synced_at` in the graph and dropped from
 * the timeline — the same H2/H3 failure mode, tracked as follow-up work).
 */

/** Producers that emit NO work-time today. Each entry is a known timeline-invisibility bug, not an
 *  exemption on principle — removing an entry (by making the producer emit a time) is the goal. */
const KNOWN_UNDATED = [
  "linear-normalize: per-issue doc items (normalizeLinearDocs)",
  "plane-normalize: per-issue doc items (normalizePlaneDocs)",
  "github-normalize: the issues table item",
] as const;

describe("guard: every normalizer emits a resolvable work-time", () => {
  it("slack thread → source_ts (the thread's own timestamp)", () => {
    const payload = normalizeThread(
      { root: { ts: "1719878400.000100", user: "U1", text: "hello" }, replies: [] },
      { channelId: "C123", channelName: "general", users: {} }
    );
    expect(resolveWorkTime(payload.frontmatter as Record<string, unknown>)).not.toBeNull();
  });

  it("git commit → committed_at", () => {
    const payload = normalizeCommit("aios-team-brain", {
      sha: "abc1234567",
      author: "Chetan",
      author_email: "c@example.com",
      message: "feat: thing",
      committed_at: "2026-06-20T10:00:00Z",
    });
    expect(payload).not.toBeNull();
    expect(resolveWorkTime(payload!.frontmatter as Record<string, unknown>)).toBe(
      "2026-06-20T10:00:00.000Z"
    );
  });

  it("github repo file → committed_at from its last commit", () => {
    const [payload] = normalizeGithubFiles({
      owner: "o",
      repo: "r",
      ref: "main",
      files: [
        {
          path: "docs/readme.md",
          body: "# hi",
          htmlUrl: "https://github.com/o/r/blob/main/docs/readme.md",
          authorName: "Chetan",
          authorEmail: "c@example.com",
          authorLogin: "chetan",
          committedAt: "2026-06-21T09:00:00Z",
        },
      ],
    });
    // Previously this frontmatter had NO time key at all — attributed, but timeline-invisible.
    expect(resolveWorkTime(payload.frontmatter as Record<string, unknown>)).toBe(
      "2026-06-21T09:00:00.000Z"
    );
  });

  it("pins the producers that are still undated, so the gap stays visible", () => {
    // Asserting the LIST is the point: shrinking it requires deleting an entry here, which forces the
    // change to be reviewed rather than a producer quietly staying invisible in the product.
    expect(KNOWN_UNDATED).toHaveLength(3);
  });

  it("a repo file whose last commit could not be fetched stays honestly undated", () => {
    // Best-effort attribution: GitHub failed us, so we must NOT invent a work-time (inventing one
    // would date the doc to sync-time and resurface old content as today's work).
    const [payload] = normalizeGithubFiles({
      owner: "o",
      repo: "r",
      ref: "main",
      files: [{ path: "docs/x.md", body: "# x" }],
    });
    expect(resolveWorkTime(payload.frontmatter as Record<string, unknown>)).toBeNull();
  });
});
