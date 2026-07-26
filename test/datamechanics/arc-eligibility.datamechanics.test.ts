import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { arcIneligibleItemIds } from "@/lib/graph/arc-eligibility";
import { db, seedTeam, ingest, type Seed } from "./helpers";

/**
 * Spec: `arcIneligibleItemIds` returns the facts to exclude from arc synthesis — Linear issues NOT in
 * active work (In Progress / In Review) AND the GitHub issues-backlog aggregate (author-less connector
 * doc) — and leaves other content (repo files, docs) arc-eligible. Real Postgres (reads items).
 */

async function seedItem(
  seed: Seed,
  source: string,
  state: string | null,
  stateType?: string,
  status?: string
): Promise<string> {
  const path = `${source}/${randomUUID()}.md`;
  const fm: Record<string, unknown> = { source };
  if (state !== null) fm.state = state;
  if (stateType !== undefined) fm.state_type = stateType;
  if (status !== undefined) fm.status = status;
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

  it("gates PLANE by the same rule as Linear — a Done Plane ticket does not shape arcs (H6)", async () => {
    // The bypass: eligibility was gated on LINEAR's state vocabulary, and the query only fetched
    // `source='linear'`. Plane's issue frontmatter carried no state at all, so a Plane ticket could
    // never be judged ineligible — Done and Backlog Plane issues shaped arcs, the exact noise class
    // #363/#331 removed for Linear, still live for the other provider. Both connectors now emit the
    // BRAIN-normalized `status` and the gate reads that one field for every provider.
    const seed = await seedTeam();
    const planeDone = await seedItem(seed, "plane", null, undefined, "done");
    const planeBacklog = await seedItem(seed, "plane", null, undefined, "backlog");
    const planeReady = await seedItem(seed, "plane", null, undefined, "ready"); // queued ≠ being worked
    const planeActive = await seedItem(seed, "plane", null, undefined, "in_progress");
    const planeBlocked = await seedItem(seed, "plane", null, undefined, "blocked"); // underway + stuck
    // Linear reads the same canonical field now, so the two providers can't diverge again.
    const linearDone = await seedItem(seed, "linear", "Done", "completed", "done");

    const ineligible = await arcIneligibleItemIds(seed.teamId, [
      planeDone,
      planeBacklog,
      planeReady,
      planeActive,
      planeBlocked,
      linearDone,
    ]);

    expect(ineligible.has(planeDone)).toBe(true);
    expect(ineligible.has(planeBacklog)).toBe(true);
    expect(ineligible.has(planeReady)).toBe(true);
    expect(ineligible.has(linearDone)).toBe(true);
    expect(ineligible.has(planeActive)).toBe(false);
    expect(ineligible.has(planeBlocked)).toBe(false);
  });

  it("prefers the canonical status over the provider's own state names", async () => {
    // A team can name a workflow state anything. `status` is the mapped value, so it wins — otherwise a
    // state called "In Progress" that the provider groups as completed would still count as active.
    const seed = await seedTeam();
    const namedActiveButDone = await seedItem(seed, "linear", "In Progress", "completed", "done");
    const namedDoneButActive = await seedItem(seed, "linear", "Done-ish", "completed", "in_progress");

    const ineligible = await arcIneligibleItemIds(seed.teamId, [namedActiveButDone, namedDoneButActive]);
    expect(ineligible.has(namedActiveButDone)).toBe(true);
    expect(ineligible.has(namedDoneButActive)).toBe(false);
  });

  it("FAILS CLOSED when the lookup errors — never 'nothing is ineligible'", async () => {
    // It used to swallow the error and return an empty set, which reads as "every item is eligible": one
    // transient DB blip flooded the arc pool with exactly the backlog/done noise this gate removes, and
    // the result was then committed as a fresh 4h arc set. Throwing is the safe direction — the
    // background refresh doesn't commit on error, so the previous arcs stand.
    const seed = await seedTeam();
    const id = await seedItem(seed, "plane", null, undefined, "done");

    const raw = new Client({ connectionString: process.env.DATABASE_URL });
    await raw.connect();
    await raw.query(
      `create or replace function _fail_items_select() returns trigger as $$ begin raise exception 'simulated lookup failure'; end $$ language plpgsql;
       create trigger _t_fail_items before update on items for each row execute function _fail_items_select();`
    );
    try {
      // The gate reads `items`; break it by making the read path fail via a broken generated dependency.
      await raw.query(`drop view if exists _nope`);
      await raw.query(`alter table items rename column frontmatter to frontmatter_moved`);
      await expect(arcIneligibleItemIds(seed.teamId, [id])).rejects.toThrow(/arc-eligibility/);
    } finally {
      await raw.query(`alter table items rename column frontmatter_moved to frontmatter`).catch(() => {});
      await raw
        .query(`drop trigger if exists _t_fail_items on items; drop function if exists _fail_items_select();`)
        .catch(() => {});
      await raw.end().catch(() => {});
    }
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
