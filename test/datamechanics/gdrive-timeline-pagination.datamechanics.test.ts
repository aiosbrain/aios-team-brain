import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  convergeIdentityAttribution, db, driveFixture, ingest, placeMemberByTier, seedTeam, type Seed,
} from "./helpers";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import type { EvidenceItem, TimelineDay } from "@/lib/dashboard/timeline-group";

/** A second human editor with a Drive permission identity of its own. */
async function driveEditor(seed: Seed, permission: string): Promise<string> {
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Second Editor",
    actor_handle: `ed-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  if (error || !data) throw new Error(`seed editor failed: ${error?.message}`);
  const id = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, id, "team");
  await setMemberIdentity(db(), seed.teamId, id, { provider: "gdrive", externalId: permission });
  return id;
}

/** A Drive document whose title and path cite no issue key unless `title` does. */
async function driveDoc(
  seed: Seed, slug: string, title: string, contributions: Array<{ permission: string; at: string }>,
) {
  // Drive content is written only by the fenced commit (AIO-1167).
  return driveFixture(seed, {
    project: "drive-timeline",
    path: `gdrive/${slug}-${randomUUID()}.md`,
    body: `${title} body`,
    frontmatter: {
      source: "gdrive",
      source_id: `${slug}-doc`,
      source_url: `https://docs.google.com/document/d/${slug}-doc/edit`,
      title,
      source_ts: contributions[0].at,
      authors: contributions.map(({ permission }) => ({ provider: "gdrive", external_id: permission, role: "editor" })),
      contributions: contributions.map(({ permission, at }) => ({ external_id: permission, role: "editor", at })),
    },
  });
}

/** A synced task whose title is visible exactly when its source item is in `visible`. */
async function syncedTask(
  seed: Seed, projectId: string, rowKey: string, title: string, visible: Set<string> | null,
): Promise<string> {
  const source = await ingest(seed, {
    kind: "deliverable", path: `task-docs/${randomUUID()}.md`, access: "team",
    body: `task source ${rowKey}`, frontmatter: { source: "linear" },
  });
  visible?.add(source.id);
  const { data, error } = await db().from("tasks").insert({
    team_id: seed.teamId, project_id: projectId, row_key: rowKey, title, assignee: "Tester",
    status: "in_progress", audience: "team", origin: "sync", source_item_id: source.id,
  }).select("id").single();
  if (error || !data) throw new Error(`seed task failed: ${error?.message}`);
  return (data as { id: string }).id;
}

/** A `task_evidence` row as the LLM doc→task pass persists one: keyed by the canonical item id. */
async function inferredLink(seed: Seed, taskId: string, itemId: string): Promise<void> {
  const { error } = await db().from("task_evidence").insert({
    team_id: seed.teamId, task_id: taskId, item_id: itemId,
    method: "llm", confidence: 0.9, detail: "describes the same subject",
  });
  if (error) throw new Error(`task_evidence insert failed: ${error.message}`);
}

/** Every rendered evidence row with the day, person and task (null = Other) it was placed under. */
function placements(days: TimelineDay[]) {
  return days.flatMap((day) => day.people.flatMap((person) => [
    ...person.tasks.flatMap((task) => task.sources.flatMap((group) => group.items.map((item) => ({
      date: day.date, memberId: person.memberId, task: task.title as string | null, item,
    })))),
    ...person.other.flatMap((group) => group.items.map((item) => ({
      date: day.date, memberId: person.memberId, task: null as string | null, item: item as EvidenceItem,
    }))),
  ]));
}

describe("AIO-1167 Drive Timeline pagination (real Postgres)", () => {
  it("does not let the generic item cap, other sources, or timestamp ties hide older Drive evidence", async () => {
    // The data-mechanics config lowers this production backstop to keep saturation tests cheap.
    const { getWorkTimeline, ITEM_LIMIT } = await import("@/lib/dashboard/work-timeline");
    const seed = await seedTeam();
    await setMemberIdentity(db(), seed.teamId, seed.memberId, {
      provider: "gdrive", externalId: "permission:timeline-person",
    });
    const at = new Date(Date.now() - 86_400_000).toISOString();
    const visible = new Set<string>();
    const driveCount = ITEM_LIMIT + 5;
    for (let index = 0; index < driveCount; index++) {
      const item = await driveFixture(seed, {
        project: "drive-timeline",
        path: `gdrive/page-${index}-${randomUUID()}.md`,
        body: `Drive body ${index}`,
        frontmatter: {
          source: "gdrive",
          source_id: `timeline-doc-${index}`,
          source_url: `https://docs.google.com/document/d/timeline-doc-${index}/edit`,
          title: `Drive evidence ${index}`,
          source_ts: at,
          authors: [{ provider: "gdrive", external_id: "permission:timeline-person", role: "editor" }],
          contributions: [{ external_id: "permission:timeline-person", role: "editor", at }],
        },
      });
      visible.add(item.id);
    }
    // These rows share/newer timestamps and consume the generic leg's tiny limit. Drive evidence is
    // read from its independent required ledger, so all five Drive rows must still survive.
    for (let index = 0; index < ITEM_LIMIT + 2; index++) {
      const item = await ingest(seed, {
        project: "other-timeline",
        path: `notion/noise-${index}-${randomUUID()}.md`,
        access: "team",
        body: `Other body ${index}`,
        frontmatter: {
          source: "notion", title: `Other evidence ${index}`,
          source_ts: new Date(Date.parse(at) + 60_000).toISOString(),
        },
      });
      visible.add(item.id);
    }

    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, {
      visibleItemIds: visible,
    });
    const driveGroups = days.flatMap((day) => day.people)
      .flatMap((person) => [
        ...person.tasks.flatMap((task) => task.sources),
        ...person.other,
      ])
      .filter((source) => source.source === "gdrive");
    expect(driveGroups).toHaveLength(1);
    // The required ledger query crossed its page boundary and counted every row. The existing
    // SourceGroup payload deliberately caps rendered rows, but `count > items.length` is explicit
    // incompleteness and the UI renders "+N more" rather than silently claiming the page is complete.
    expect(driveGroups[0].count).toBe(driveCount);
    expect(driveGroups[0].items).toHaveLength(6);
    expect(new Set(driveGroups[0].items.map((item) => item.title)).size).toBe(6);
  }, 30_000);

  it("does not let newer skipped Drive or uncredited rows exhaust the generic window and evict older valid evidence", async () => {
    const { getWorkTimeline, ITEM_LIMIT } = await import("@/lib/dashboard/work-timeline");
    expect(Number.isInteger(ITEM_LIMIT)).toBe(true);
    const seed = await seedTeam();
    await setMemberIdentity(db(), seed.teamId, seed.memberId, {
      provider: "gdrive", externalId: "permission:saturation-person",
    });
    const { data: connector, error } = await db().from("members").insert({
      team_id: seed.teamId, email: `${randomUUID()}@connector.local`, display_name: "Sync Bot",
      actor_handle: `bot-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
      is_connector: true,
    }).select("id").single();
    if (error || !connector) throw new Error(`seed connector failed: ${error?.message}`);
    const connectorId = (connector as { id: string }).id;
    const visible = new Set<string>();

    // The OLDEST row is valid evidence: its current owner is the human member, so it is credited
    // work and must stay visible however many newer rows the generic lane has to skip past.
    const olderAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const valid = await ingest(seed, {
      project: "generic-timeline",
      path: `notion/older-valid-${randomUUID()}.md`,
      access: "team",
      body: "Older valid generic body",
      frontmatter: { source: "notion", title: "Older valid generic", source_ts: olderAt },
    });
    visible.add(valid.id);

    // Newer than it: more than a whole window of Drive rows (read from their own ledger, skipped by
    // the generic lane)…
    const newerAt = new Date(Date.now() - 86_400_000).toISOString();
    const driveCount = ITEM_LIMIT + 3;
    for (let index = 0; index < driveCount; index++) {
      const item = await driveFixture(seed, {
        project: "drive-timeline",
        path: `gdrive/saturation-${index}-${randomUUID()}.md`,
        body: `Drive saturation ${index}`,
        frontmatter: {
          source: "gdrive",
          source_id: `saturation-doc-${index}`,
          source_url: `https://docs.google.com/document/d/saturation-doc-${index}/edit`,
          title: `Drive saturation ${index}`,
          source_ts: newerAt,
          authors: [{ provider: "gdrive", external_id: "permission:saturation-person", role: "editor" }],
          contributions: [{ external_id: "permission:saturation-person", role: "editor", at: newerAt }],
        },
      });
      visible.add(item.id);
    }
    // …and more than a whole window of generic rows nobody human is credited for.
    const uncredited: string[] = [];
    for (let index = 0; index < ITEM_LIMIT + 3; index++) {
      const item = await ingest(seed, {
        project: "generic-timeline",
        path: `notion/uncredited-${index}-${randomUUID()}.md`,
        access: "team",
        body: `Uncredited body ${index}`,
        frontmatter: {
          source: "notion", title: `Uncredited ${index}`,
          source_ts: new Date(Date.parse(newerAt) + 60_000).toISOString(),
        },
      });
      uncredited.push(item.id);
      visible.add(item.id);
    }
    const owner = await db().from("items").update({ member_id: connectorId }).in("id", uncredited);
    if (owner.error) throw new Error(`reassign uncredited failed: ${owner.error.message}`);
    const versions = await db().from("item_versions").update({ member_id: connectorId }).in("item_id", uncredited);
    if (versions.error) throw new Error(`reassign uncredited versions failed: ${versions.error.message}`);

    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, {
      visibleItemIds: visible,
    });
    const groups = days.flatMap((day) => day.people)
      .flatMap((person) => [
        ...person.tasks.flatMap((task) => task.sources),
        ...person.other,
      ]);
    const titles = groups.flatMap((group) => group.items.map((item) => item.title));

    // The generic window was ranked over admitted evidence: the uncredited rows were read and
    // skipped across a page boundary, and the older valid row is still there.
    expect(titles).toContain("Older valid generic");
    expect(titles.some((title) => title.startsWith("Uncredited"))).toBe(false);
    const notion = groups.filter((group) => group.source === "notion");
    expect(notion).toHaveLength(1);
    expect(notion[0].count).toBe(1);
    // The Drive rows are still all counted, from their own ledger and only once.
    const drive = groups.filter((group) => group.source === "gdrive");
    expect(drive).toHaveLength(1);
    expect(drive[0].count).toBe(driveCount);
  }, 30_000);

  it("links every retained observation of a keyless Drive document to its inferred task through the canonical item id", async () => {
    const { getWorkTimeline } = await import("@/lib/dashboard/work-timeline");
    const seed = await seedTeam();
    await setMemberIdentity(db(), seed.teamId, seed.memberId, {
      provider: "gdrive", externalId: "permission:first-editor",
    });
    const second = await driveEditor(seed, "permission:second-editor");
    await convergeIdentityAttribution(seed);
    const visible = new Set<string>();
    const firstAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const secondAt = new Date(Date.now() - 3 * 86_400_000).toISOString();

    // One keyless document, edited by two people on two days: two observations of one item.
    const keyless = await driveDoc(seed, "keyless", "Rollout plan", [
      { permission: "permission:first-editor", at: firstAt },
      { permission: "permission:second-editor", at: secondAt },
    ]);
    // Controls: a document whose own title cites a task, and one inferred onto a task this reader
    // cannot see.
    const cited = await driveDoc(seed, "cited", "Plan for AIO-1302", [
      { permission: "permission:first-editor", at: firstAt },
    ]);
    const hiddenLinked = await driveDoc(seed, "hidden-linked", "Unlisted design", [
      { permission: "permission:second-editor", at: secondAt },
    ]);
    for (const item of [keyless, cited, hiddenLinked]) visible.add(item.id);
    const projectId = keyless.projectId!;
    const inferredTask = await syncedTask(seed, projectId, "AIO-1301", "Inferred rollout task", visible);
    await syncedTask(seed, projectId, "AIO-1302", "Cited task", visible);
    const hiddenTask = await syncedTask(seed, projectId, "AIO-1309", "Hidden task", null);
    // `task_evidence` names the item, never an observation of it.
    await inferredLink(seed, inferredTask, keyless.id);
    await inferredLink(seed, inferredTask, cited.id);
    await inferredLink(seed, hiddenTask, hiddenLinked.id);

    const rows = placements(await getWorkTimeline(db(), seed.teamId, "team", undefined, {
      visibleItemIds: visible,
    }));
    const placed = (title: string) => rows.filter((row) => row.item.title === title)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((row) => [row.date, row.memberId, row.task, row.item.linkVia ?? null]);

    // Both observations are under the inferred task, each with its own person and day — exactly two
    // rows, so neither was also placed in Other.
    expect(placed("Rollout plan")).toEqual([
      [firstAt.slice(0, 10), seed.memberId, "Inferred rollout task", "inferred"],
      [secondAt.slice(0, 10), second, "Inferred rollout task", "inferred"],
    ]);
    // Each keeps its own observation identity, distinct from the item id the link was keyed by.
    const ids = rows.filter((row) => row.item.title === "Rollout plan").map((row) => row.item.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(keyless.id);

    // The document's own cited key outranks an inference onto another task.
    expect(placed("Plan for AIO-1302")).toEqual([
      [firstAt.slice(0, 10), seed.memberId, "Cited task", "commit-text"],
    ]);
    // An inference onto a task the reader cannot see links nothing: the work stays, in Other.
    expect(placed("Unlisted design")).toEqual([[secondAt.slice(0, 10), second, null, null]]);
    expect(rows.some((row) => row.task === "Hidden task")).toBe(false);
  }, 30_000);
});
