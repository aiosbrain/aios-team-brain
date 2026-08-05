import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  isAiAssisted,
  dayOf,
  parseCommits,
  aggregateContributions,
  fetchCommitsSince,
  type ApiCommit,
} from "@/lib/codebases/github-api-scan";
import aiTrailerCases from "@/test/fixtures/ai-trailer-cases.json";

// Spec: the GitHub-API sync must derive per-(author, day) contributions and AI-assist counts
// from a commit list WITHOUT a checkout, tolerating the messy shapes GitHub returns.

describe("isAiAssisted", () => {
  // Shared with ingestion/tests/test_codebase_analyzer.py's _AI_TRAILER test — both
  // detectors must agree on every case in the fixture, so they can't silently diverge.
  it.each(aiTrailerCases)("$message -> $expected", ({ message, expected }) => {
    expect(isAiAssisted(message)).toBe(expected);
  });
});

describe("dayOf", () => {
  it("returns the UTC calendar day", () => {
    expect(dayOf("2026-07-03T23:30:00Z")).toBe("2026-07-03");
  });
  it("returns '' for garbage", () => {
    expect(dayOf("not-a-date")).toBe("");
  });
});

describe("parseCommits", () => {
  it("normalizes the GitHub /commits shape and tolerates nulls", () => {
    const raw = [
      { sha: "abc", commit: { author: { name: "Chetan", email: "chetan@acme.com", date: "2026-07-01T10:00:00Z" }, message: "feat: a" } },
      { sha: "def", commit: { message: "fix: b" } }, // missing author
      { nonsense: true },
    ];
    const out = parseCommits(raw);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      sha: "abc",
      author_email: "chetan@acme.com",
      author_name: "Chetan",
      authored_date: "2026-07-01T10:00:00Z",
      message: "feat: a",
    });
    expect(out[1].author_email).toBe("");
    expect(out[2].sha).toBe("");
  });
  it("returns [] for non-arrays", () => {
    expect(parseCommits(null)).toEqual([]);
    expect(parseCommits({})).toEqual([]);
  });
});

describe("aggregateContributions", () => {
  const commits: ApiCommit[] = [
    { sha: "1", author_email: "Chetan@Acme.com", author_name: "Chetan", authored_date: "2026-07-01T09:00:00Z", message: "feat: a" },
    { sha: "2", author_email: "chetan@acme.com", author_name: "Chetan", authored_date: "2026-07-01T18:00:00Z", message: "fix: b\n\nCo-Authored-By: Claude" },
    { sha: "3", author_email: "chetan@acme.com", author_name: "Chetan", authored_date: "2026-07-02T08:00:00Z", message: "docs" },
    { sha: "4", author_email: "", author_name: "Nomail Dev", authored_date: "2026-07-02T08:00:00Z", message: "chore" },
  ];

  it("groups by lower-cased email + UTC day, counting commits and AI commits", () => {
    const rows = aggregateContributions(commits);
    const jul1 = rows.find((r) => r.author_key === "chetan@acme.com" && r.day === "2026-07-01");
    expect(jul1).toMatchObject({ commits: 2, ai_commits: 1 });
    const jul2 = rows.find((r) => r.author_key === "chetan@acme.com" && r.day === "2026-07-02");
    expect(jul2).toMatchObject({ commits: 1, ai_commits: 0 });
  });

  it("falls back to the name key when the email is hidden", () => {
    const rows = aggregateContributions(commits);
    const nomail = rows.find((r) => r.author_key === "nomail dev");
    expect(nomail).toMatchObject({ commits: 1, author_email: "" });
  });

  it("skips commits with no identity and no parseable day", () => {
    const rows = aggregateContributions([
      { sha: "x", author_email: "", author_name: "", authored_date: "2026-07-01T00:00:00Z", message: "m" },
      { sha: "y", author_email: "a@b.com", author_name: "A", authored_date: "bad", message: "m" },
    ]);
    expect(rows).toEqual([]);
  });
});

/**
 * The cutoff reaches GitHub verbatim (AIO-807). `ingestGithubApiScan` used to take `windowDays` and
 * re-derive `now − days` itself, which made "no history" (`days: 0`) mean `since = now` on every tick
 * — a commit pushed between two ticks was never in any window. The caller now owns the instant
 * (`commitSinceIso`), so this leg must carry it onto the request unmodified.
 */
describe("fetchCommitsSince — the anchor on the wire", () => {
  const calls: string[] = [];
  const stubFetch = (pages: unknown[][]) => {
    let page = 0;
    return vi.fn(async (url: string) => {
      calls.push(url);
      const body = pages[page++] ?? [];
      return { ok: true, json: async () => body } as unknown as Response;
    });
  };

  beforeEach(() => {
    calls.length = 0;
  });

  it("sends the caller's instant as `since=`, unmodified", async () => {
    vi.stubGlobal("fetch", stubFetch([[]]));
    await fetchCommitsSince("acme", "widgets", "tok", "2026-05-01T12:34:56.000Z");
    expect(calls[0]).toContain(`since=${encodeURIComponent("2026-05-01T12:34:56.000Z")}`);
    vi.unstubAllGlobals();
  });

  it("does not re-derive a window of its own — a second page carries the same instant", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ sha: `s${i}`, commit: { message: "m" } }));
    vi.stubGlobal("fetch", stubFetch([full, []]));
    await fetchCommitsSince("acme", "widgets", "tok", "2026-05-01T12:34:56.000Z");
    expect(calls).toHaveLength(2);
    for (const url of calls) expect(url).toContain(`since=${encodeURIComponent("2026-05-01T12:34:56.000Z")}`);
    vi.unstubAllGlobals();
  });
});
