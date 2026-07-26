import { describe, expect, it } from "vitest";
import { buildPurgeMeta } from "@/lib/ingest/purge";

/**
 * Spec: a purge's audit row must be able to answer "what did this remove?".
 *
 * The rows are the only record of their own paths, so once the cascade runs the question has no answer
 * anywhere else. This was found the hard way — the first live purge in prod took a Slack thread and
 * nothing on the box could say which one — so the recorded shape is pinned here rather than left to
 * whatever the writer happens to emit.
 *
 * Unit tier because the meta is pure: the truncation and read-failure branches are otherwise only
 * reachable by seeding hundreds of rows or forcing a DB error in the real-DB tier, which is how an
 * off-by-one ships green.
 */

const base = { reason: "deleted at the source (slack)", episodes: 0, readFailed: false };

describe("buildPurgeMeta", () => {
  it("records every path when the list is small, and no truncation marker", () => {
    const meta = buildPurgeMeta({ ...base, items: 2, paths: ["slack/c/1.md", "slack/c/2.md"] });
    expect(meta.paths).toEqual(["slack/c/1.md", "slack/c/2.md"]);
    expect(meta.paths_truncated).toBeUndefined();
    expect(meta.paths_read_failed).toBeUndefined();
  });

  it("caps the list and reports exactly how many it left out", () => {
    const paths = Array.from({ length: 250 }, (_, i) => `slack/c/${String(i).padStart(4, "0")}.md`);
    const meta = buildPurgeMeta({ ...base, items: 250, paths });
    expect((meta.paths as string[]).length).toBe(200);
    expect(meta.paths_truncated).toBe(50); // 250 - 200, not an off-by-one
    expect(meta.items).toBe(250); // the COUNT stays authoritative
  });

  it("emits no truncation marker at exactly the cap (the off-by-one boundary)", () => {
    const paths = Array.from({ length: 200 }, (_, i) => `slack/c/${i}.md`);
    const meta = buildPurgeMeta({ ...base, items: 200, paths });
    expect((meta.paths as string[]).length).toBe(200);
    expect(meta.paths_truncated).toBeUndefined(); // NOT `0` — an absent marker means "nothing omitted"
  });

  it("MARKS a failed path read instead of leaving an empty list to be misread", () => {
    // `paths: []` with no marker is indistinguishable from a build that never recorded paths — which
    // would recreate the exact blind spot this field exists to close.
    const meta = buildPurgeMeta({ ...base, items: 3, paths: [], readFailed: true });
    expect(meta.paths).toEqual([]);
    expect(meta.paths_read_failed).toBe(true);
    expect(meta.items).toBe(3); // we still know how much went
  });

  it("marks a PARTIAL read too — what was read is kept, and the gap is still flagged", () => {
    const meta = buildPurgeMeta({ ...base, items: 5, paths: ["slack/c/1.md"], readFailed: true });
    expect(meta.paths).toEqual(["slack/c/1.md"]);
    expect(meta.paths_read_failed).toBe(true);
  });
});
