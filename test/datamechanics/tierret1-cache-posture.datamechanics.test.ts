import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db, placeMemberByTier, seedTeam, type Seed } from "./helpers";
import { createMember } from "@/lib/admin/members";
import { resolveContentAdmission, contentReaderFor, type ContentAdmission } from "@/lib/access/admission";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import {
  getCachedWorkTimeline,
  settleTimelineRefreshes,
  bustTeamTimeline,
  timelineViewKey,
  resolveTimelineVariant,
  readTimelineCache,
  writeTimelineCache,
} from "@/lib/dashboard/timeline-cache";

/**
 * TIERRET-1 final review HIGH (astra-final.decisions.md) — ONE captured posture governs the whole
 * cached timeline view: key, lookup, cold build, read/write helpers, refresh scheduling and the
 * background build.
 *
 * The race: API auth reads posture once (`auth.memberTier`), then the cache resolves admission and
 * reads posture again. A LEGAL membership write can land between the two — `createMember`'s
 * tier-changing upsert reconciles a connector/offroster row into (or out of) builtin Everyone. Calling
 * the cache with the old tier AFTER that write is the race's deterministic end state (no sleeps, no
 * timing luck). Spec rule (SPEC line 71): the cache key separates readers whose payloads differ, so a
 * payload assembled under one authority must never be served under another reader class's key.
 *
 * The sentinel is a HAND-ENTERED (no source item, `created_by` set) decision with an EXTERNAL
 * audience, attributed to a roster human so it genuinely renders in the Context lane. External
 * audience means no label filter can hide it: whether a legacy reader sees it is decided ONLY by the
 * unsourced-admission arm (legacy+team → all, legacy+external → closed).
 *
 * Every test asserts on rendered output / persisted payloads, never on internal object shape.
 * Model-free: the dm tier blanks every LLM transport; background passes are settled, never awaited
 * on a timer.
 */

const STALE_GUARD = "a stale caller posture must not choose the key";

afterEach(async () => {
  // Fixture teardown: let background passes land before the next test's TRUNCATE.
  await settleTimelineRefreshes();
});

interface LegacyRow {
  id: string;
  email: string;
  displayName: string;
  actorHandle: string;
}

/** An ACTIVE legacy (non-principal) row with its builtin posture row, the way production holds one. */
async function legacyMember(seed: Seed, over: { is_connector?: boolean; kind?: string; tier: "team" | "external" }): Promise<LegacyRow> {
  const email = `${randomUUID()}@test.local`;
  const displayName = `Legacy-${randomUUID().slice(0, 6)}`;
  const actorHandle = `lg-${randomUUID().slice(0, 10)}`;
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email,
      display_name: displayName,
      actor_handle: actorHandle,
      role: "member",
      tier: over.tier,
      status: "active",
      is_connector: over.is_connector ?? false,
      kind: over.kind ?? "human",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed legacy member failed: ${error?.message}`);
  const id = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, id, over.tier);
  return { id, email, displayName, actorHandle };
}

/** The EXISTING legal transition: a tier-changing `createMember` upsert reconciles the builtin row. */
async function moveTierViaUpsert(seed: Seed, m: LegacyRow, tier: "team" | "external"): Promise<void> {
  await createMember(
    db(),
    seed.teamId,
    { email: m.email, displayName: m.displayName, actorHandle: m.actorHandle, role: "member", tier },
    { upsert: true }
  );
}

async function sentinelDecision(seed: Seed): Promise<string> {
  const { data: p, error: pErr } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `hand-${randomUUID().slice(0, 6)}`, name: "hand", kind: "initiative" })
    .select("id")
    .single();
  if (pErr || !p) throw new Error(`seed project failed: ${pErr?.message}`);
  const title = `SENTINEL-hand-entered-${randomUUID().slice(0, 8)}`;
  const { error } = await db().from("decisions").insert({
    team_id: seed.teamId,
    project_id: (p as { id: string }).id,
    row_key: `HD-${randomUUID().slice(0, 6)}`,
    title,
    decided_by: "Tester", // the seed human — resolves to exactly one roster person, so it renders
    decided_at: new Date().toISOString().slice(0, 10),
    still_valid: true,
    audience: "external",
    source_item_id: null,
    created_by: seed.memberId,
  });
  if (error) throw new Error(`seed decision failed: ${error.message}`);
  return title;
}

/** Uncached builder output for an admission — the sentinel's render control (touches no cache). */
async function directRender(seed: Seed, admission: ContentAdmission): Promise<string> {
  const days = await getWorkTimeline(db(), seed.teamId, admission.posture, undefined, {
    visibleItemIds: new Set<string>(),
    reader: contentReaderFor(admission),
  });
  return JSON.stringify(days);
}

/** Every persisted payload under a prefix, concatenated — "absent" and "rebuilt clean" both pass. */
async function persistedUnder(teamId: string, prefix: string): Promise<{ keys: string[]; text: string }> {
  const { data, error } = await db()
    .from("work_timeline_cache")
    .select("group_key, payload")
    .eq("team_id", teamId)
    .like("group_key", `${prefix}%`);
  if (error) throw new Error(`cache row read failed: ${error.message}`);
  const rows = (data ?? []) as { group_key: string; payload: unknown }[];
  return { keys: rows.map((r) => r.group_key), text: JSON.stringify(rows.map((r) => r.payload)) };
}

/** Evict this process's memory copies, then re-stamp the rows FRESH: the next read is a persisted HIT. */
async function forcePersistedHit(teamId: string): Promise<void> {
  await bustTeamTimeline(db(), teamId);
  await db().from("work_timeline_cache").update({ computed_at: new Date().toISOString() }).eq("team_id", teamId);
}

const LG_EXTERNAL = "adm:lg:external:";

describe("TIERRET-1 HIGH — timeline cache posture is the resolved admission's, never the caller's stale tier", () => {
  it("stale EXTERNAL caller, current TEAM legacy connector: the broader payload never reaches a second external legacy reader (memory, persisted row, persisted hit)", async () => {
    const seed = await seedTeam();
    const title = await sentinelDecision(seed);
    const connector = await legacyMember(seed, { is_connector: true, tier: "external" });
    const offroster = await legacyMember(seed, { kind: "offroster", tier: "external" });

    // Preconditions: both are legacy at external posture; the external legacy arm is CLOSED for the sentinel.
    const before = await resolveContentAdmission(db(), seed.teamId, connector.id);
    expect(before).toMatchObject({ kind: "legacy", posture: "external" });
    expect(await directRender(seed, before), "external legacy arm must not render the hand-entered sentinel").not.toContain(title);
    const reader2 = await resolveContentAdmission(db(), seed.teamId, offroster.id);
    expect(reader2).toMatchObject({ kind: "legacy", posture: "external" });

    // Auth captured "external" … then the legal createMember upsert moves the connector into Everyone.
    await moveTierViaUpsert(seed, connector, "team");
    const after = await resolveContentAdmission(db(), seed.teamId, connector.id);
    expect(after, "still the legacy arm — only the posture moved").toMatchObject({ kind: "legacy", posture: "team" });
    // Sentinel-renders control: under the connector's CURRENT authority the title genuinely renders.
    expect(await directRender(seed, after), "positive control: team legacy arm renders the sentinel").toContain(title);

    // The racing request: stale caller tier, cold key.
    const first = await getCachedWorkTimeline(db(), seed.teamId, "external", connector.id);
    expect(JSON.stringify(first.days), "positive control: the first (broader) request itself serves the sentinel").toContain(title);
    await settleTimelineRefreshes(); // the cold miss's background build + its write, both landed

    // Canonical key: the exported helper must key by resolved admission, not its tier argument.
    expect.soft(
      await timelineViewKey(db(), seed.teamId, "external", connector.id),
      `${STALE_GUARD} (timelineViewKey)`
    ).toBe(await timelineViewKey(db(), seed.teamId, "team", connector.id));

    // Persisted: no external-legacy row carries the team-authority payload (cold write + background write).
    const persisted = await persistedUnder(seed.teamId, LG_EXTERNAL);
    expect.soft(persisted.text, `persisted ${persisted.keys.join(",")} must not hold the team-legacy payload`).not.toContain(title);

    // Memory: a second, genuinely external legacy reader on the shared external-legacy key.
    const second = await getCachedWorkTimeline(db(), seed.teamId, "external", offroster.id);
    expect.soft(JSON.stringify(second.days), "second external legacy reader (memory path) must not see the sentinel").not.toContain(title);
    await settleTimelineRefreshes();

    // Persisted HIT: memory evicted, rows fresh — the second reader reads its row from Postgres.
    await forcePersistedHit(seed.teamId);
    const third = await getCachedWorkTimeline(db(), seed.teamId, "external", offroster.id);
    expect.soft(JSON.stringify(third.days), "second external legacy reader (persisted hit) must not see the sentinel").not.toContain(title);
  });

  it("stale TEAM caller, current EXTERNAL legacy connector: the old wider team variant is not retrieved (memory or persisted hit)", async () => {
    const seed = await seedTeam();
    const title = await sentinelDecision(seed);
    const connector = await legacyMember(seed, { is_connector: true, tier: "team" });

    const before = await resolveContentAdmission(db(), seed.teamId, connector.id);
    expect(before).toMatchObject({ kind: "legacy", posture: "team" });
    // Legit wider variant: populated while the connector really was team posture.
    const legit = await getCachedWorkTimeline(db(), seed.teamId, "team", connector.id);
    expect(JSON.stringify(legit.days), "positive control: the team legacy variant serves the sentinel").toContain(title);
    await settleTimelineRefreshes();

    // Legal narrowing (Everyone → External) after auth captured "team".
    await moveTierViaUpsert(seed, connector, "external");
    const after = await resolveContentAdmission(db(), seed.teamId, connector.id);
    expect(after).toMatchObject({ kind: "legacy", posture: "external" });
    expect(await directRender(seed, after), "current authority does not render the sentinel").not.toContain(title);

    expect.soft(
      await timelineViewKey(db(), seed.teamId, "team", connector.id),
      `${STALE_GUARD} (timelineViewKey, reverse)`
    ).toBe(await timelineViewKey(db(), seed.teamId, "external", connector.id));

    const memory = await getCachedWorkTimeline(db(), seed.teamId, "team", connector.id);
    expect.soft(JSON.stringify(memory.days), "stale team tier must not retrieve the wider variant (memory)").not.toContain(title);
    await settleTimelineRefreshes();

    await forcePersistedHit(seed.teamId);
    const persisted = await getCachedWorkTimeline(db(), seed.teamId, "team", connector.id);
    expect.soft(JSON.stringify(persisted.days), "stale team tier must not retrieve the wider variant (persisted hit)").not.toContain(title);
  });

  it("stale-row refresh path: a stale EXTERNAL caller's scheduled background build does not publish team-authority content under the external legacy key", async () => {
    const seed = await seedTeam();
    const title = await sentinelDecision(seed);
    const connector = await legacyMember(seed, { is_connector: true, tier: "external" });
    const offroster = await legacyMember(seed, { kind: "offroster", tier: "external" });

    // The external legacy row exists legitimately (built under external authority) and is then stale.
    const legit = await getCachedWorkTimeline(db(), seed.teamId, "external", offroster.id);
    expect(JSON.stringify(legit.days)).not.toContain(title);
    await settleTimelineRefreshes();
    await bustTeamTimeline(db(), seed.teamId);

    await moveTierViaUpsert(seed, connector, "team");
    const after = await resolveContentAdmission(db(), seed.teamId, connector.id);
    expect(after).toMatchObject({ kind: "legacy", posture: "team" });
    expect(await directRender(seed, after), "positive control: current authority renders the sentinel").toContain(title);

    await getCachedWorkTimeline(db(), seed.teamId, "external", connector.id); // stale caller tier
    await settleTimelineRefreshes(); // whatever it scheduled has now built and written

    const persisted = await persistedUnder(seed.teamId, LG_EXTERNAL);
    expect.soft(persisted.text, `background write under ${persisted.keys.join(",")} must not hold team-authority content`).not.toContain(title);
    const second = await getCachedWorkTimeline(db(), seed.teamId, "external", offroster.id);
    expect.soft(JSON.stringify(second.days), "second external legacy reader must not see the background-built sentinel").not.toContain(title);
  });

  it("exported read/write helpers: a tier argument that disagrees with the supplied resolved variant cannot address another reader class's row", async () => {
    const seed = await seedTeam();
    const title = await sentinelDecision(seed);
    const connector = await legacyMember(seed, { is_connector: true, tier: "team" });
    const offroster = await legacyMember(seed, { kind: "offroster", tier: "external" });

    const teamVariant = await resolveTimelineVariant(db(), seed.teamId, connector.id);
    expect(teamVariant.admission).toMatchObject({ kind: "legacy", posture: "team" });
    const extVariant = await resolveTimelineVariant(db(), seed.teamId, offroster.id);
    expect(extVariant.admission).toMatchObject({ kind: "legacy", posture: "external" });
    const teamDays = await getWorkTimeline(db(), seed.teamId, "team", undefined, {
      visibleItemIds: new Set<string>(),
      reader: contentReaderFor(teamVariant.admission),
    });
    expect(JSON.stringify(teamDays), "positive control: the team legacy payload carries the sentinel").toContain(title);

    // WRITE with a stale "external" argument and a team-authority variant: it must not land on the
    // external legacy key (canonical placement or refusal both pass).
    await writeTimelineCache(db(), seed.teamId, "external", teamDays, false, teamVariant);
    const afterWrite = await persistedUnder(seed.teamId, LG_EXTERNAL);
    expect.soft(afterWrite.text, `write helper landed team payload under ${afterWrite.keys.join(",")}`).not.toContain(title);

    // READ with a stale "team" argument and an external-authority variant: it must not return the
    // team legacy row. Seed that row with CONSISTENT arguments first.
    await writeTimelineCache(db(), seed.teamId, "team", teamDays, false, teamVariant);
    const read = await readTimelineCache(db(), seed.teamId, "team", extVariant);
    expect.soft(JSON.stringify(read?.days ?? null), "read helper returned the team legacy row to an external variant").not.toContain(title);
  });
});
