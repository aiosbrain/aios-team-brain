import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { arcIneligibleItemIds } from "@/lib/graph/arc-eligibility";
import { db, seedTeam, ingest, type Seed } from "./helpers";

/**
 * Spec: `arcIneligibleItemIds` returns the facts to exclude from arc synthesis — Linear issues NOT in
 * active work (In Progress / In Review) AND the GitHub issues-backlog aggregate (author-less connector
 * doc) — and leaves other content (repo files, docs) arc-eligible. Real Postgres (reads items).
 */

async function seedItem(seed: Seed, source: string, state: string | null, stateType?: string): Promise<string> {
  const path = `${source}/${randomUUID()}.md`;
  const fm: Record<string, unknown> = { source };
  if (state !== null) fm.state = state;
  if (stateType !== undefined) fm.state_type = stateType;
  const { id } = await ingest(seed, { body: `b ${path}`, path, access: "team", frontmatter: fm });
  return id;
}

describe("arc eligibility (real Postgres)", () => {
  it("gates Linear by canonical state_type ('started'), falls back to state name, keeps non-Linear", async () => {
    const seed = await seedTeam();
    const startedType = await seedItem(seed, "linear", "Blocked", "started"); // canonical active (name regex would miss)
    const completedType = await seedItem(seed, "linear", "Reviewed", "completed"); // name regex would keep — type drops it
    const activeName = await seedItem(seed, "linear", "In Progress"); // no type → name fallback → active
    const backlogName = await seedItem(seed, "linear", "Backlog"); // no type → name fallback → not active
    const boardMirror = await seedItem(seed, "linear", null); // kind-agnostic: source=linear, no state/type → not active (the issues.md board mirror)
    const notion = await seedItem(seed, "notion", null); // non-Linear → never gated

    const ids = [startedType, completedType, activeName, backlogName, boardMirror, notion];
    const ineligible = await arcIneligibleItemIds(seed.teamId, ids);

    expect(ineligible.has(completedType)).toBe(true);
    expect(ineligible.has(backlogName)).toBe(true);
    expect(ineligible.has(boardMirror)).toBe(true);
    expect(ineligible.has(startedType)).toBe(false); // started type kept despite "Blocked" name
    expect(ineligible.has(activeName)).toBe(false);
    expect(ineligible.has(notion)).toBe(false);
    expect(ineligible.size).toBe(3);
  });

  it("returns an empty set for no items", async () => {
    const seed = await seedTeam();
    expect((await arcIneligibleItemIds(seed.teamId, [])).size).toBe(0);
  });

  it("excludes the GitHub issues-backlog aggregate (author-less connector doc), keeps other github content", async () => {
    const seed = await seedTeam();
    // The single connector-owned issues digest — this is what a "no person assigned" arc traces to.
    const issuesBacklog = (
      await ingest(seed, {
        body: "# GitHub issues — acme/repo\n\n| GH-1 | Adopt the AIO-<n> naming convention |",
        path: "github/acme-repo/issues.md",
        access: "team",
        kind: "task",
        frontmatter: { source: "github" },
      })
    ).id;
    // A real GitHub repo-file deliverable (has a human author) — must stay arc-eligible.
    const repoFile = (
      await ingest(seed, {
        body: "# Readme\n\nhow to build",
        path: "github/acme-repo/README.md",
        access: "team",
        kind: "deliverable",
        frontmatter: { source: "github" },
      })
    ).id;

    const ineligible = await arcIneligibleItemIds(seed.teamId, [issuesBacklog, repoFile]);
    expect(ineligible.has(issuesBacklog)).toBe(true);
    expect(ineligible.has(repoFile)).toBe(false);
    expect(ineligible.size).toBe(1);
  });

  it("tracks a live Linear status change on an unchanged-body re-push (frontmatter heal)", async () => {
    // A Linear issue's state isn't in its body, so a Backlog→In Progress transition is an UNCHANGED
    // re-push (same content_sha256). The fast-path must refresh frontmatter so eligibility isn't frozen
    // at first ingest — else active work stays suppressed from arcs forever.
    const seed = await seedTeam();
    const body = `issue prose ${randomUUID()}`;
    const path = `linear/${randomUUID()}.md`;
    const fm = (state: string, type: string) => ({ source: "linear", identifier: "AIO-1", state, state_type: type });

    const r1 = await ingest(seed, { body, path, access: "team", frontmatter: fm("Backlog", "backlog") });
    expect((await arcIneligibleItemIds(seed.teamId, [r1.id])).has(r1.id)).toBe(true); // Backlog → ineligible

    const r2 = await ingest(seed, { body, path, access: "team", frontmatter: fm("In Progress", "started") });
    expect(r2.status).toBe("unchanged"); // same body → unchanged re-push
    expect(r2.id).toBe(r1.id);
    expect((await arcIneligibleItemIds(seed.teamId, [r1.id])).has(r1.id)).toBe(false); // healed → now eligible
  });
});
