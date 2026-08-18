import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import { getCachedWorkTimeline, purgeTimelineCacheTier, settleTimelineRefreshes, PAYLOAD_VERSION } from "@/lib/dashboard/timeline-cache";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { db, seedTeam, ingest, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { memberEnforcement } from "@/lib/access/enforce";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";

// Phase B slice 4 (spec §5.8/§17-B), post-PRET-6 — the work-timeline read path through the
// oracle, the only path: every leg carries the membership filter (items in-query,
// tasks/decisions/meetings via their source item), served from a work_timeline_cache VISIBILITY
// VARIANT keyed by the sorted effective-project-set hash — never from the legacy full-tier row,
// whose payload (titles + LLM prose) can name restricted work.

const recentIso = new Date(Date.now() - 2 * 86_400_000).toISOString();

const evidenceTitles = (days: TimelineDay[]): string[] =>
  days.flatMap((d) => d.people).flatMap((p) => p.tasks.flatMap((t) => t.sources.flatMap((g) => g.items.map((i) => i.title))));
const taskTitles = (days: TimelineDay[]): string[] =>
  days.flatMap((d) => d.people).flatMap((p) => p.tasks.map((t) => t.title));

async function commit(seed: Seed, body: string) {
  return ingest(seed, {
    kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "team",
    body, frontmatter: { source: "git", committed_at: recentIso },
  });
}
async function insertTask(seed: Seed, projectId: string, over: Record<string, unknown>) {
  const { error } = await db()
    .from("tasks")
    .insert({ team_id: seed.teamId, project_id: projectId, title: "task", assignee: "Tester", status: "in_progress", audience: "team", origin: "sync", ...over });
  expect(error, "task fixture must insert").toBeNull();
}
async function seedMember(seed: Seed): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  const { placeMemberByTier } = await import("./helpers");
  await placeMemberByTier(seed.teamId, data!.id as string, "team");
  return data!.id as string;
}
/** Move an item's context membership into a fresh RESTRICTED project the seed admin can see but
 *  a plain member cannot (no grant to Everyone). Returns the project id. */
async function restrictItem(seed: Seed, itemId: string): Promise<string> {
  const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `r-${randomUUID().slice(0, 8)}`, name: "R", kind: "initiative" }).select("id").single();
  const g = await createGroup(db(), seed.teamId, `rg-${randomUUID().slice(0, 8)}`, "RG", seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, proj!.id as string, g.groupId!, seed.memberId);
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: proj!.id as string, context_unit_id: unit!.id, method: "manual" });
  expect(error, "restrict fixture must insert").toBeNull();
  return proj!.id as string;
}

describe("enforced work-timeline builder (Phase B slice 4)", () => {
  it("enforcing: restricted evidence AND its task header never reach an outsider's ledger; General work still does", async () => {
    const seed = await seedTeam();
    const openItem = await commit(seed, "feat: open thing (AIO-10)");
    const secretItem = await commit(seed, "feat: secret launch codes (AIO-20)");
    await insertTask(seed, openItem.projectId!, { row_key: "AIO-10", title: "Open work", source_item_id: openItem.id });
    await insertTask(seed, secretItem.projectId!, { row_key: "AIO-20", title: "Secret work", source_item_id: secretItem.id });
    const outsider = await seedMember(seed); // BEFORE the backfill sweep, which converges builtin membership
    await backfillTeamContext(db(), seed.teamId);
    await restrictItem(seed, secretItem.id);

    const enforce = await memberEnforcement(db(), { teamId: seed.teamId, memberId: outsider });
    expect(enforce, "enforcing team must yield an enforcement view").not.toBeNull();
    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, enforce);

    expect(evidenceTitles(days), "General evidence still flows").toContain("feat: open thing (AIO-10)");
    expect(taskTitles(days)).toContain("Open work");
    expect(JSON.stringify(days), "restricted evidence title must NEVER appear anywhere in the payload").not.toContain("secret launch codes");
    expect(JSON.stringify(days), "the restricted task's title is itself a leak channel").not.toContain("Secret work");
  });

  it("enforcing: a task with a VISIBLE citing commit but a RESTRICTED source item is dropped (title leak); a decision on a restricted item too", async () => {
    const seed = await seedTeam();
    const openItem = await commit(seed, "feat: visible work citing (AIO-30)");
    const secretItem = await commit(seed, "internal: hidden basis (AIO-99)");
    // The task's own definition doc is restricted, but the citing commit is General — the header
    // must still be dropped, else the task TITLE names the restricted work.
    await insertTask(seed, openItem.projectId!, { row_key: "AIO-30", title: "Codename Zephyr rollout", source_item_id: secretItem.id });
    const decErr = (await db().from("decisions").insert({ team_id: seed.teamId, project_id: openItem.projectId!, row_key: "DEC-77", title: "Sunset the Zephyr contract", decided_by: "chetan", decided_at: recentIso.slice(0, 10), still_valid: true, source_item_id: secretItem.id })).error;
    expect(decErr, "decision fixture must insert").toBeNull();
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictItem(seed, secretItem.id);

    const enforce = await memberEnforcement(db(), { teamId: seed.teamId, memberId: outsider });
    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, enforce);

    expect(JSON.stringify(days)).not.toContain("Codename Zephyr rollout");
    expect(JSON.stringify(days)).not.toContain("Sunset the Zephyr contract");
    void openItem;
  });

  it("enforcing: a meeting whose source transcript is restricted vanishes; a General meeting keeps its attendee rows", async () => {
    const seed = await seedTeam();
    const openT = await ingest(seed, { kind: "transcript", path: `meetings/${randomUUID()}.md`, access: "team", body: "open standup", frontmatter: { source: "granola", source_ts: recentIso, title: "Open standup" } });
    const secretT = await ingest(seed, { kind: "transcript", path: `meetings/${randomUUID()}.md`, access: "team", body: "board prep", frontmatter: { source: "granola", source_ts: recentIso, title: "Confidential board prep" } });
    const mk = async (itemId: string, title: string) => {
      const { data, error } = await db().from("meeting_notes").insert({ team_id: seed.teamId, source_item_id: itemId, title, occurred_at: recentIso.slice(0, 10) }).select("id").single();
      expect(error, "meeting note fixture must insert").toBeNull();
      const attErr = (await db().from("meeting_note_attendees").insert({ meeting_note_id: data!.id, member_id: seed.memberId })).error;
      expect(attErr, "attendee fixture must insert").toBeNull();
    };
    await mk(openT.id, "Open standup");
    await mk(secretT.id, "Confidential board prep");
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictItem(seed, secretT.id);

    const enforce = await memberEnforcement(db(), { teamId: seed.teamId, memberId: outsider });
    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, enforce);
    expect(JSON.stringify(days), "General meeting attendance still flows").toContain("Open standup");
    expect(JSON.stringify(days), "a restricted meeting must not surface via its note").not.toContain("Confidential board prep");
  });

  it("enforcing: a hand-created task (created_by set, null source) still heads its group — a null-source drop would erase every dashboard task for everyone (Fable B4 Medium)", async () => {
    const seed = await seedTeam();
    // The citing commit is General; the task is dashboard-created (created_by set, no source item)
    // in a General-visible project. Under a naive null-source-drop the header vanishes for everyone.
    const commitItem = await commit(seed, "feat: do the UI thing (UI-1)");
    const generalProj = commitItem.projectId!;
    await insertTask(seed, generalProj, { row_key: "UI-1", title: "Dashboard-made task", status: "in_progress", origin: "ui", source_item_id: null, created_by: seed.memberId });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);

    const enforce = await memberEnforcement(db(), { teamId: seed.teamId, memberId: outsider });
    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, enforce);
    expect(taskTitles(days), "a hand-created task in a visible project must survive enforcing").toContain("Dashboard-made task");
    expect(evidenceTitles(days)).toContain("feat: do the UI thing (UI-1)");
  });

  it("enforcing: a SYNCED task whose restricted source was PURGED (source→null) does NOT resurface — created_by null ⇒ dropped", async () => {
    const seed = await seedTeam();
    const commitItem = await commit(seed, "feat: cite the secret (SEC-1)");
    const secretItem = await commit(seed, "internal: secret basis (SEC-1)");
    // A SYNCED task tied to a restricted item (created_by null, like every synced row), then the item
    // is deleted → source_item_id goes null.
    await insertTask(seed, commitItem.projectId!, { row_key: "SEC-1", title: "Purged-basis task", status: "in_progress", origin: "sync", source_item_id: secretItem.id, created_by: null });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictItem(seed, secretItem.id);
    await db().from("items").delete().eq("id", secretItem.id); // FK on delete set null → task.source_item_id = null

    const enforce = await memberEnforcement(db(), { teamId: seed.teamId, memberId: outsider });
    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, enforce);
    expect(JSON.stringify(days), "a synced task with a purged restricted basis must not resurface").not.toContain("Purged-basis task");
  });

  it("enforcing: an ADOPTED task (origin='ui' but created_by null) whose restricted source was purged does NOT leak — origin is durability, not access provenance (Codex B4 High)", async () => {
    const seed = await seedTeam();
    const commitItem = await commit(seed, "feat: cite adopted (ADO-1)");
    const secretItem = await commit(seed, "internal: adopted secret basis (ADO-1)");
    // lib/pm-sync/inbound.ts flips an ADOPTED synced issue to origin='ui' while it still carries an
    // imported source and NO created_by. Gating on origin='ui' would have let this leak once purged.
    await insertTask(seed, commitItem.projectId!, { row_key: "ADO-1", title: "Adopted restricted title", status: "in_progress", origin: "ui", source_item_id: secretItem.id, created_by: null });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictItem(seed, secretItem.id);
    await db().from("items").delete().eq("id", secretItem.id); // source → null; origin stays 'ui'

    const enforce = await memberEnforcement(db(), { teamId: seed.teamId, memberId: outsider });
    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, enforce);
    expect(JSON.stringify(days), "an adopted (origin='ui', created_by null) task must not resurface via a purged source").not.toContain("Adopted restricted title");
  });

  // Deleted WITH its subject (PRET-6): "permissive: the enforce view is null and the ledger is
  // byte-identical to today" — memberEnforcement now always resolves a view for a live principal,
  // and the null-view builder arm survives only for no-principal internal callers.
});

describe("visibility-keyed timeline cache (§5.8)", () => {
  it("enforcing: the read NEVER serves the full-tier row — it builds and persists a vis:<hash> variant", async () => {
    const seed = await seedTeam();
    const item = await commit(seed, "feat: general note (AIO-50)");
    await insertTask(seed, item.projectId!, { row_key: "AIO-50", title: "General note task", source_item_id: item.id });
    const member = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    // Poison the tier row: a payload naming restricted work, fresh enough to be served on a hit.
    await db().from("work_timeline_cache").upsert({
      team_id: seed.teamId,
      group_key: "team",
      payload: JSON.stringify({ v: PAYLOAD_VERSION, days: [{ date: "2026-08-12", people: [{ memberId: seed.memberId, name: "X", summary: "POISON restricted prose", tasks: [], unlinked: 0, total: 0, signals: [] }] }] }),
      computed_at: new Date().toISOString(),
    }, { onConflict: "team_id,group_key" });

    const { days } = await getCachedWorkTimeline(db(), seed.teamId, "team", member);
    await settleTimelineRefreshes();
    expect(JSON.stringify(days), "the tier row's payload must not be served to an enforcing read").not.toContain("POISON");

    const { data: rows } = await db().from("work_timeline_cache").select("group_key").eq("team_id", seed.teamId);
    const keys = ((rows ?? []) as { group_key: string }[]).map((r) => r.group_key);
    expect(keys.some((k) => k.startsWith("vis:team:")), `expected a vis:team:<hash> row, got ${keys.join()}`).toBe(true);
  });

  it("two members with the SAME group signature share one variant row; a third with different groups gets another", async () => {
    const seed = await seedTeam();
    await commit(seed, "feat: shared corpus (AIO-60)");
    const a = await seedMember(seed);
    const b = await seedMember(seed);
    const c = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await getCachedWorkTimeline(db(), seed.teamId, "team", a);
    await getCachedWorkTimeline(db(), seed.teamId, "team", b);
    await settleTimelineRefreshes();
    const visRows = async () => {
      const { data } = await db().from("work_timeline_cache").select("group_key").eq("team_id", seed.teamId).like("group_key", "vis:%");
      return ((data ?? []) as { group_key: string }[]).map((r) => r.group_key);
    };
    const afterTwo = await visRows();
    expect(new Set(afterTwo).size, "identical group signatures must SHARE a cache row").toBe(1);

    // Third member with an extra group+grant → different hash → second row.
    const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 8)}` }).select("id").single();
    const g = await createGroup(db(), seed.teamId, `cg-${randomUUID().slice(0, 8)}`, "CG", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, c, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, proj!.id as string, g.groupId!, seed.memberId);
    await getCachedWorkTimeline(db(), seed.teamId, "team", c);
    await settleTimelineRefreshes();
    expect(new Set(await visRows()).size, "a different effective set must get its own row").toBe(2);
  });

  it("the tier row's LLM prose is never salvaged into a variant build (same-key salvage only)", async () => {
    const seed = await seedTeam();
    const item = await commit(seed, "feat: salvage probe (AIO-70)");
    await insertTask(seed, item.projectId!, { row_key: "AIO-70", title: "Salvage probe", source_item_id: item.id });
    const member = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    // A tier row whose per-person prose names restricted work, at an OLD version (salvage ignores version).
    await db().from("work_timeline_cache").upsert({
      team_id: seed.teamId,
      group_key: "team",
      payload: JSON.stringify({ v: PAYLOAD_VERSION - 1, days: [{ date: recentIso.slice(0, 10), people: [{ memberId: seed.memberId, name: "X", summary: "SALVAGE-POISON secret prose", tasks: [], unlinked: 0, total: 0, signals: [] }] }] }),
      computed_at: new Date().toISOString(),
    }, { onConflict: "team_id,group_key" });
    const { days } = await getCachedWorkTimeline(db(), seed.teamId, "team", member);
    await settleTimelineRefreshes();
    expect(JSON.stringify(days), "cross-key salvage would leak tier prose into an enforced payload").not.toContain("SALVAGE-POISON");
  });

  it("purgeTimelineCacheTier removes the tier row AND every vis variant of that tier", async () => {
    const seed = await seedTeam();
    await commit(seed, "feat: purge probe (AIO-80)");
    const member = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await getCachedWorkTimeline(db(), seed.teamId, "team", member); // writes a vis:team:<hash> variant
    await settleTimelineRefreshes();
    // Seed the plain tier row DIRECTLY (an enforcing read never writes it, so the "removes the tier
    // row" half would be vacuous otherwise — Fable B4 Low): both halves must now discriminate.
    await db().from("work_timeline_cache").upsert({
      team_id: seed.teamId, group_key: "team",
      payload: JSON.stringify({ v: PAYLOAD_VERSION, days: [] }), computed_at: new Date().toISOString(),
    }, { onConflict: "team_id,group_key" });
    const before = ((await db().from("work_timeline_cache").select("group_key").eq("team_id", seed.teamId)).data ?? []) as { group_key: string }[];
    expect(before.some((r) => r.group_key === "team"), "tier row must exist before purge").toBe(true);
    expect(before.some((r) => r.group_key.startsWith("vis:team:")), "a variant must exist before purge").toBe(true);
    await purgeTimelineCacheTier(db(), seed.teamId, "team");
    const { data } = await db().from("work_timeline_cache").select("group_key").eq("team_id", seed.teamId);
    const keys = ((data ?? []) as { group_key: string }[]).map((r) => r.group_key);
    expect(keys.filter((k) => k === "team" || k.startsWith("vis:team:")), `tier purge must sweep variants, got ${keys.join()}`).toEqual([]);
  });

  it("fail closed: a substrate read error while resolving enforcement THROWS and caches nothing (Codex B4 Medium — an error-empty must not become a fresh shared variant)", async () => {
    const seed = await seedTeam();
    await commit(seed, "feat: probe (ERR-1)");
    const member = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    const { resolveTimelineEnforcement, memberVisibility } = await import("@/lib/access/enforce");
    const vis = await memberVisibility(db(), { teamId: seed.teamId, memberId: member });
    expect(vis, "enforcing team yields a visibility").not.toBeNull();
    // A DB whose membership read errors: resolveTimelineEnforcement must throw, not return empty.
    const brokenDb = {
      from() {
        return {
          select() { return this; }, eq() { return this; }, is() { return this; }, in() { return this; },
          then(resolve: (v: unknown) => void) { resolve({ data: null, error: { message: "connection reset" } }); },
        };
      },
    } as unknown as ReturnType<typeof db>;
    await expect(resolveTimelineEnforcement(brokenDb, seed.teamId, vis!)).rejects.toThrow();
    // And no timeline row was written as a side effect of the failed resolution.
    const rows = ((await db().from("work_timeline_cache").select("group_key").eq("team_id", seed.teamId)).data ?? []) as { group_key: string }[];
    expect(rows.some((r) => r.group_key.startsWith("vis:")), "no variant row may be persisted from a failed resolution").toBe(false);
  });

  it("fail closed: a timeline read with NO principal throws — the memberId==null arm is always-throw (PRET-6), never the tier row", async () => {
    const seed = await seedTeam();
    await expect(getCachedWorkTimeline(db(), seed.teamId, "team", null)).rejects.toThrow();
  });

  // Deleted WITH its subject (PRET-6): "permissive: a member read writes the plain tier row and
  // NO variant" — the tier-row write arm is gone; a member read only ever writes vis:<hash>
  // variants, which the first test of this describe pins positively.
});
