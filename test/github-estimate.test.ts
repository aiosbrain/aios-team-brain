import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countFromLinkHeader,
  episodesForBytes,
  episodesForIssueCount,
  estimateFromTree,
  ISSUES_PER_EPISODE_EST,
} from "@/lib/integrations/github-estimate";
import { CHUNK_CHARS, MAX_EPISODE_CHUNKS } from "@/lib/graph/project";
import { MAX_FILE_BYTES, MAX_FILES_PER_REPO } from "@/lib/ingest/sources/github-files";

/**
 * The pre-link import estimator (AIO-798). Spec-first, from the design doc's contract: the estimate
 * is the IMPORTER'S arithmetic run against tree metadata — same globs, same size skip, same file
 * cap, same projector chunk math — so every assertion here is phrased against the importer's
 * constants, never against literals that could drift from them.
 */

describe("episodesForBytes — the projector's own chunk math", () => {
  it("one chunk for a small doc, ceil() for larger, hard-capped at MAX_EPISODE_CHUNKS", () => {
    expect(episodesForBytes(1)).toBe(1);
    expect(episodesForBytes(CHUNK_CHARS)).toBe(1);
    expect(episodesForBytes(CHUNK_CHARS + 1)).toBe(2);
    expect(episodesForBytes(CHUNK_CHARS * (MAX_EPISODE_CHUNKS + 5))).toBe(MAX_EPISODE_CHUNKS);
    expect(episodesForBytes(0)).toBe(0);
  });
});

describe("estimateFromTree — mirrors what the importer will actually fetch", () => {
  const md = (path: string, size: number) => ({ type: "blob", path, size });

  it("counts only glob-matched blobs and sums their chunked episodes", () => {
    const out = estimateFromTree(
      [
        md("README.md", 100),
        md("docs/design/a.md", CHUNK_CHARS * 3),
        md("src/index.ts", 5_000), // not markdown — the importer never fetches it
        { type: "tree", path: "docs" }, // not a blob
      ],
      undefined,
      false
    );
    expect(out.files).toBe(2);
    expect(out.fileEpisodes).toBe(1 + 3);
    expect(out.atLeast).toBe(false);
  });

  it("skips files over MAX_FILE_BYTES exactly as the importer does", () => {
    const out = estimateFromTree([md("huge.md", MAX_FILE_BYTES + 1), md("ok.md", 10)], undefined, false);
    expect(out.files).toBe(1);
    expect(out.fileEpisodes).toBe(1);
  });

  it("honours a custom fileGlobs config, like the importer", () => {
    const out = estimateFromTree([md("a.md", 10), md("b.rst", 10)], ["*.rst"], false);
    expect(out.files).toBe(1);
  });

  it("a truncated tree is a floor, not a total", () => {
    expect(estimateFromTree([md("a.md", 10)], undefined, true).atLeast).toBe(true);
  });

  it("the importer's file cap binds the estimate AND flags it as a floor", () => {
    const blobs = Array.from({ length: MAX_FILES_PER_REPO + 5 }, (_, i) => md(`f${i}.md`, 10));
    const out = estimateFromTree(blobs, undefined, false);
    expect(out.files).toBe(MAX_FILES_PER_REPO);
    expect(out.atLeast).toBe(true);
  });
});

describe("countFromLinkHeader — the per_page=1 pagination trick", () => {
  it('reads the rel="last" page number as the count', () => {
    const link = '<https://api.github.com/repos/o/r/commits?since=x&per_page=1&page=347>; rel="last", <...>; rel="next"';
    expect(countFromLinkHeader(link, 1)).toBe(347);
  });

  it("no Link header means one page — the count is the page length, NOT zero", () => {
    // Load-bearing for single-commit repos: a missing header is 'everything fit', not 'nothing'.
    expect(countFromLinkHeader(null, 1)).toBe(1);
    expect(countFromLinkHeader(null, 0)).toBe(0);
  });

  it('a Link header without rel="last" falls back to the page length', () => {
    expect(countFromLinkHeader('<https://x>; rel="prev"', 1)).toBe(1);
  });
});

describe("episodesForIssueCount", () => {
  it("floors at the shared-item chunk cap and divides by the documented estimate constant", () => {
    expect(episodesForIssueCount(0)).toBe(0);
    expect(episodesForIssueCount(1)).toBe(1);
    expect(episodesForIssueCount(ISSUES_PER_EPISODE_EST * 3)).toBe(3);
    expect(episodesForIssueCount(ISSUES_PER_EPISODE_EST * (MAX_EPISODE_CHUNKS + 9))).toBe(MAX_EPISODE_CHUNKS);
  });
});

describe("live coupling to the projector's env-tuned chunk size", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("re-tuning GRAPH_CHUNK_CHARS moves the estimate — the import is load-bearing, not decorative", async () => {
    // A grep for 'no numeric literal' would be satisfied by a dead import; only the estimate MOVING
    // under the projector's own tuning knob proves the coupling (plan-review fix to a vacuous guard).
    vi.stubEnv("GRAPH_CHUNK_CHARS", String(CHUNK_CHARS * 2));
    vi.resetModules();
    const fresh = await import("@/lib/integrations/github-estimate");
    expect(fresh.episodesForBytes(CHUNK_CHARS + 1)).toBe(1); // was 2 at the un-tuned size
  });
});
