import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { canSeeItem, visibleItemIds } from "@/lib/access/enforce";
import { advanceAuthorizationEpoch, authorizationEpoch } from "@/lib/access/authorization-epoch";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import { readArcCache, writeArcCache } from "@/lib/graph/arc-cache";
import { commitArcs, getArcs, memCacheSet, settleArcRefreshes, type NarrativeArc } from "@/lib/graph/arcs";
import {
  ArcFusionAuthorizationChangedError,
  getAuthorizationBoundFusedArcs,
  getFusedArcs,
} from "@/lib/graph/arc-fusion";
import {
  ArcInputAuthorizationUnavailableError,
  authorizedArcFacts,
} from "@/lib/graph/arc-input-authorization";
import { filterArcsByVisibleItems } from "@/lib/graph/arc-visibility";
import { readTimelineCache, writeTimelineCache } from "@/lib/dashboard/timeline-cache";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import {
  drainGdriveCleanupObligations,
  reconcileGdriveItems,
  stageGdriveReconciliation,
} from "@/lib/ingest/source-reconcile";
import { upsertIntegration } from "@/lib/integrations/manage";
import { retrieve } from "@/lib/query/retrieve";
import { runSql } from "@/lib/db/pg/pool";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { listAuthorizedArcCorrections, recordArcCorrections } from "@/lib/graph/arc-corrections";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { db, ingest, seedTeam, visOf, type Seed } from "./helpers";

afterEach(async () => {
  await settleArcRefreshes();
});

async function privateAudience(seed: Seed, memberId: string, slug: string): Promise<string> {
  const { data: existingGroup } = await db().from("groups").select("id")
    .eq("team_id", seed.teamId).eq("person_member_id", memberId).maybeSingle();
  const group = existingGroup ?? (await db().from("groups").insert({
    team_id: seed.teamId, slug: `person-${randomUUID()}`, name: slug, person_member_id: memberId,
  }).select("id").single()).data;
  if (!existingGroup) {
    await db().from("group_members").insert({
      team_id: seed.teamId, group_id: (group as { id: string }).id, member_id: memberId,
    });
  }
  const { data: project } = await db().from("projects").insert({
    team_id: seed.teamId, slug, name: slug, kind: "initiative",
  }).select("id").single();
  await db().from("project_groups").insert({
    team_id: seed.teamId, project_id: (project as { id: string }).id,
    group_id: (group as { id: string }).id,
  });
  const pointer = await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId: (project as { id: string }).id });
  if (!pointer.ok) throw new Error(pointer.error);
  return (project as { id: string }).id;
}

async function connection(seed: Seed, name: string, audienceProjectId: string): Promise<string> {
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: ["shared-doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account",
      audienceProjectIds: [audienceProjectId],
    },
  });
  return row.id;
}

describe("AIO-1167 Drive audience claims (real Postgres)", () => {
  async function claimedItem(seed: Seed, providerId: string, connections: string[], projectId: string) {
    const item = await ingest(seed, {
      project: "drive-claims", path: `gdrive/${providerId}.md`, body: `Drive ${providerId}`,
      access: "external", frontmatter: { source: "gdrive", source_id: providerId },
    });
    for (const integrationId of connections) {
      await recordGdriveItemClaim(db(), {
        teamId: seed.teamId, integrationId, providerId, itemId: item.id,
        generation: 1, audienceProjectIds: [projectId],
      });
    }
    return item;
  }

  it.each([["a", "b"], ["b", "a"]] as const)(
    "keeps one canonical item and unions claims in %s→%s order",
    async (first, second) => {
      const seed = await seedTeam();
      await setMemberIdentity(db(), seed.teamId, seed.memberId, {
        provider: "gdrive", externalId: "permission:audience-author",
      });
      const { data: other } = await db().from("members").insert({
        team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Other",
        actor_handle: `other-${randomUUID()}`, role: "member", tier: "team", status: "active",
      }).select("id").single();
      const otherId = (other as { id: string }).id;
      const projectA = await privateAudience(seed, seed.memberId, "drive-a");
      const projectB = await privateAudience(seed, otherId, "drive-b");
      const connectionA = await connection(seed, "connection-a", projectA);
      const connectionB = await connection(seed, "connection-b", projectB);
      const sourceAt = new Date(Date.now() - 86_400_000).toISOString();
      const item = await ingest(seed, {
        project: "drive-storage", path: "gdrive/shared-doc.md",
        body: "one canonical waffleberry body for AIO-1167", access: "external",
        frontmatter: {
          source: "gdrive", source_id: "shared-doc", title: "Shared Drive evidence AIO-1167",
          source_ts: sourceAt,
          authors: [{ provider: "gdrive", external_id: "permission:audience-author", role: "editor" }],
          contributions: [{ external_id: "permission:audience-author", role: "editor", at: sourceAt }],
        },
      });
      await db().from("items").update({ member_id: seed.memberId }).eq("id", item.id);
      await db().from("tasks").insert({
        team_id: seed.teamId, project_id: item.projectId, row_key: "AIO-1167",
        title: "Drive audience task", status: "in_progress", assignee: "Tester",
        audience: "team", origin: "sync", source_item_id: item.id,
      });
      const claims = {
        a: { integrationId: connectionA, audienceProjectIds: [projectA] },
        b: { integrationId: connectionB, audienceProjectIds: [projectB] },
      };
      for (const key of [first, second]) {
        await recordGdriveItemClaim(db(), {
          teamId: seed.teamId, providerId: "shared-doc", itemId: item.id, generation: 1,
          ...claims[key],
        });
      }
      expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, item.id)).toBe(true);
      expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: otherId }, item.id)).toBe(true);

      const viewA = await visibleItemIds(db(), { teamId: seed.teamId, memberId: seed.memberId });
      const viewB = await visibleItemIds(db(), { teamId: seed.teamId, memberId: otherId });
      for (const view of [viewA, viewB]) {
        expect(view.ids.has(item.id)).toBe(true);
        const answerContext = await retrieve(db(), seed.teamId, "team", "waffleberry", null, {
          visibleItemIds: view.ids, principal: "member",
        });
        expect(answerContext.sources.map((source) => source.item_id)).toContain(item.id);
        expect(filterArcsByVisibleItems([{
          id: "drive-arc", title: "Drive arc", summary: "Grounded", confidence: "high",
          participants: [], supporting_sources: [], derived_at: new Date().toISOString(),
          evidence: [{ fact: "Drive fact", itemId: item.id, source: "gdrive" }],
        }], view.ids)).toHaveLength(1);
        expect(JSON.stringify(await getWorkTimeline(db(), seed.teamId, "team", undefined, {
          visibleItemIds: view.ids,
        }))).toContain("Shared Drive evidence AIO-1167");
      }
      const { data: contextUnit } = await db().from("project_context_units").select("id")
        .eq("team_id", seed.teamId).eq("source_item_id", item.id).single();
      const { data: contextProjects } = await db().from("project_context_memberships")
        .select("project_id, method").eq("team_id", seed.teamId)
        .eq("context_unit_id", (contextUnit as { id: string }).id).is("valid_to", null);
      expect((contextProjects ?? []).map((row) => row.project_id).sort())
        .toEqual([projectA, projectB].sort());
      expect(contextProjects).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "gdrive_claim" }),
      ]));

      const beforeEpoch = await authorizationEpoch(db(), seed.teamId);
      const removed = await reconcileGdriveItems(db(), seed.teamId, {
        connectionId: connectionA, removedProviderIds: ["shared-doc"], reason: "connection A revoked",
      });
      expect(removed.items).toBe(0);
      expect(await authorizationEpoch(db(), seed.teamId)).toBeGreaterThan(beforeEpoch);
      expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, item.id)).toBe(false);
      expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: otherId }, item.id)).toBe(true);
      const afterA = await visibleItemIds(db(), { teamId: seed.teamId, memberId: seed.memberId });
      const afterB = await visibleItemIds(db(), { teamId: seed.teamId, memberId: otherId });
      expect((await retrieve(db(), seed.teamId, "team", "waffleberry", null, {
        visibleItemIds: afterA.ids, principal: "member",
      })).sources.map((source) => source.item_id)).not.toContain(item.id);
      expect((await retrieve(db(), seed.teamId, "team", "waffleberry", null, {
        visibleItemIds: afterB.ids, principal: "member",
      })).sources.map((source) => source.item_id)).toContain(item.id);
      expect(filterArcsByVisibleItems([{
        id: "drive-arc", title: "Drive arc", summary: "Grounded", confidence: "high",
        participants: [], supporting_sources: [], derived_at: new Date().toISOString(),
        evidence: [{ fact: "Drive fact", itemId: item.id }],
      }], afterA.ids)).toEqual([]);
      expect(JSON.stringify(await getWorkTimeline(db(), seed.teamId, "team", undefined, {
        visibleItemIds: afterA.ids,
      }))).not.toContain("Shared Drive evidence AIO-1167");
      expect(JSON.stringify(await getWorkTimeline(db(), seed.teamId, "team", undefined, {
        visibleItemIds: afterB.ids,
      }))).toContain("Shared Drive evidence AIO-1167");

      await recordGdriveItemClaim(db(), {
        teamId: seed.teamId, integrationId: connectionA, providerId: "shared-doc",
        itemId: item.id, generation: 1, audienceProjectIds: [projectA],
      });
      expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, item.id)).toBe(true);
    },
  );

  it("never adopts an unrelated exact path and deterministically allocates a safe Drive path", async () => {
    const seed = await seedTeam();
    const original = await ingest(seed, {
      project: "docs", path: "gdrive/Quarterly Plan.md", body: "local content", access: "team",
      frontmatter: { source: "local" },
    });
    const drive = await ingest(seed, {
      project: "docs", path: "gdrive/Quarterly Plan.md", body: "Drive content", access: "external",
      frontmatter: { source: "gdrive", source_id: "Case/Sanitized:ID" },
    });
    const { data: canonicalBefore } = await db().from("items").select("path,project_id")
      .eq("id", drive.id).single();
    const canonicalPath = (canonicalBefore as { path: string; project_id: string }).path;
    const canonicalProject = (canonicalBefore as { path: string; project_id: string }).project_id;

    // Neither an unchanged metadata replay nor a changed/renamed source implicitly moves the canonical
    // row back onto the colliding requested path (or into a newly requested project).
    const unchanged = await ingest(seed, {
      project: "renamed-project", path: "gdrive/Renamed Plan.md", body: "Drive content", access: "external",
      frontmatter: { source: "gdrive", source_id: "Case/Sanitized:ID", title: "Renamed" },
    });
    expect(unchanged).toEqual(expect.objectContaining({ status: "unchanged", id: drive.id, projectId: canonicalProject }));
    const changed = await ingest(seed, {
      project: "renamed-project", path: "gdrive/Renamed Plan.md", body: "Drive content changed", access: "external",
      frontmatter: { source: "gdrive", source_id: "Case/Sanitized:ID", title: "Renamed again" },
    });
    expect(changed).toEqual(expect.objectContaining({ status: "updated", id: drive.id, projectId: canonicalProject }));
    const { data: canonicalAfter } = await db().from("items").select("path,project_id,body")
      .eq("id", drive.id).single();
    expect(canonicalAfter).toEqual(expect.objectContaining({
      path: canonicalPath, project_id: canonicalProject, body: "Drive content changed",
    }));
    const { data: versions } = await db().from("item_versions").select("id").eq("item_id", drive.id);
    expect(versions).toHaveLength(2);

    const caseCollision = await ingest(seed, {
      project: "docs", path: "gdrive/Quarterly Plan.md", body: "Other Drive content", access: "external",
      frontmatter: { source: "gdrive", source_id: "case/sanitized:id" },
    });
    expect(drive.id).not.toBe(original.id);
    expect(caseCollision.id).not.toBe(original.id);
    expect(caseCollision.id).not.toBe(drive.id);
    const { data: rows } = await db().from("items").select("id,path,body")
      .eq("team_id", seed.teamId).eq("project_id", drive.projectId!);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: original.id, path: "gdrive/Quarterly Plan.md", body: "local content" }),
      expect.objectContaining({ id: drive.id, path: expect.stringContaining("--drive-"), body: "Drive content changed" }),
      expect.objectContaining({
        id: caseCollision.id, path: expect.stringContaining("--drive-"), body: "Other Drive content",
      }),
    ]));
    expect(new Set((rows ?? []).map((row) => row.path)).size).toBe(3);

    // The mapping is also a tombstone. A physical cleanup followed by reconnect reuses the same UUID
    // and collision-safe path rather than overwriting the unrelated normalized-path item.
    const { data: mapping } = await db().from("source_item_mappings").select("canonical_path,project_id")
      .eq("team_id", seed.teamId).eq("source", "gdrive").eq("provider_id", "Case/Sanitized:ID").single();
    expect(mapping).toEqual(expect.objectContaining({ canonical_path: canonicalPath, project_id: canonicalProject }));
    await db().from("items").delete().eq("id", drive.id);
    const reconnected = await ingest(seed, {
      project: "renamed-project", path: "gdrive/Renamed Plan.md", body: "Drive content restored", access: "external",
      frontmatter: { source: "gdrive", source_id: "Case/Sanitized:ID", title: "Restored" },
    });
    expect(reconnected).toEqual(expect.objectContaining({ id: drive.id, projectId: canonicalProject }));
    expect((await db().from("items").select("path,body").eq("id", drive.id).single()).data)
      .toEqual(expect.objectContaining({ path: canonicalPath, body: "Drive content restored" }));
    expect((await db().from("items").select("body").eq("id", original.id).single()).data)
      .toEqual(expect.objectContaining({ body: "local content" }));
  });

  it("rejects warm rows and pre-revocation rebuild publication across the durable epoch", async () => {
    const seed = await seedTeam();
    const vis = await visOf(seed);
    const timelineKey = `vis:team:${vis.visibilityHash}`;
    const epoch = await authorizationEpoch(db(), seed.teamId);
    await writeArcCache(db(), seed.teamId, "g:test", [], null, { authorizationEpoch: epoch });
    expect((await writeTimelineCache(db(), seed.teamId, "team", [], false, vis, epoch)).status).toBe("published");
    expect(await readArcCache(db(), seed.teamId, "g:test")).not.toBeNull();
    expect((await db().from("work_timeline_cache").select("group_key")
      .eq("team_id", seed.teamId).eq("group_key", timelineKey).maybeSingle()).data).not.toBeNull();

    const next = await advanceAuthorizationEpoch(seed.teamId);
    expect(next).toBe(epoch + 1);
    await writeArcCache(db(), seed.teamId, "g:test", [], null, { authorizationEpoch: epoch });
    expect((await writeTimelineCache(db(), seed.teamId, "team", [], false, vis, epoch)).status).toBe("epoch_rejected");
    expect(await readArcCache(db(), seed.teamId, "g:test")).toBeNull();
    // Physical cleanup may retry later; the epoch makes old bytes immediately unservable.
    expect((await db().from("work_timeline_cache").select("group_key")
      .eq("team_id", seed.teamId).eq("group_key", timelineKey).maybeSingle()).data).not.toBeNull();
    expect(await readTimelineCache(db(), seed.teamId, "team", vis)).toBeNull();
    await db().from("work_timeline_cache").upsert({
      team_id: seed.teamId, group_key: timelineKey, payload: { v: 14, days: [] }, authorization_epoch: epoch,
    });
    expect(await readTimelineCache(db(), seed.teamId, "team", vis)).toBeNull();
    expect(await authorizationEpoch(db(), seed.teamId)).toBe(next);
  });

  it("rejects old-epoch arc fallback, process memory, and fusion after async revocation", async () => {
    const seed = await seedTeam();
    const oldArc: NarrativeArc = {
      id: "old", title: "OLD AUTHORIZED ARC", summary: "must disappear", confidence: "high",
      participants: [], supporting_sources: [], evidence: [], derived_at: new Date().toISOString(),
    };
    const epoch = await authorizationEpoch(db(), seed.teamId);
    await writeArcCache(db(), seed.teamId, "g:prior", [oldArc], "old", { authorizationEpoch: epoch });
    memCacheSet("g:memory", {
      arcs: [oldArc], at: Date.now(), factsHash: "old", degraded: false, authorizationEpoch: epoch,
    });
    await advanceAuthorizationEpoch(seed.teamId);

    const fallback = await commitArcs(db(), seed.teamId, "g:prior", [], "failed-build", {
      authorizationEpoch: epoch,
    });
    expect(fallback.arcs).toEqual([]);
    const memory = await getArcs(db(), seed.teamId, seed.teamSlug, ["memory"], {
      anthropicApiKey: null, openaiApiKey: null,
    } as never, { scopeKey: "g:memory" });
    expect(JSON.stringify(memory.arcs)).not.toContain("OLD AUTHORIZED ARC");

    const fusionEpoch = await authorizationEpoch(db(), seed.teamId);
    await writeArcCache(db(), seed.teamId, "g:fusion-a", [oldArc], "a", {
      authorizationEpoch: fusionEpoch,
    });
    await writeArcCache(db(), seed.teamId, "g:fusion-b", [oldArc], "b", {
      authorizationEpoch: fusionEpoch,
    });
    const fused = await getFusedArcs(
      db(), seed.teamId, seed.teamSlug, ["fusion-a", "fusion-b"],
      { anthropicApiKey: null, openaiApiKey: null } as never,
      { beforeFinalEpochCheck: async (attempt) => {
        if (attempt === 0) await advanceAuthorizationEpoch(seed.teamId);
      } },
    );
    expect(JSON.stringify(fused.arcs)).not.toContain("OLD AUTHORIZED ARC");
    await settleArcRefreshes();
  });

  it("re-resolves visible ids and partition scope when authorization changes during route synthesis", async () => {
    const seed = await seedTeam();
    const oldArc: NarrativeArc = {
      id: "old-scope", title: "Old scope", summary: "OLD-SCOPE-MARKER", confidence: "high",
      participants: [], supporting_sources: [], derived_at: new Date().toISOString(),
      evidence: [{ fact: "old", itemId: "item-old" }],
    };
    const newArc: NarrativeArc = {
      id: "new-scope", title: "New scope", summary: "NEW-SCOPE-MARKER", confidence: "high",
      participants: [], supporting_sources: [], derived_at: new Date().toISOString(),
      evidence: [{ fact: "new", itemId: "item-new" }],
    };
    const epoch = await authorizationEpoch(db(), seed.teamId);
    await writeArcCache(db(), seed.teamId, "g:old-scope", [oldArc], "old", { authorizationEpoch: epoch });
    let resolutions = 0;
    const panel = await getAuthorizationBoundFusedArcs(
      db(), seed.teamId, seed.teamSlug, { anthropicApiKey: null, openaiApiKey: null } as never,
      async () => {
        resolutions += 1;
        return resolutions === 1
          ? { groups: ["old-scope"], visibleItemIds: new Set(["item-old"]) }
          : { groups: ["new-scope"], visibleItemIds: new Set(["item-new"]) };
      },
      {
        beforeFinalAuthorizationCheck: async (attempt) => {
          if (attempt !== 0) return;
          const next = await advanceAuthorizationEpoch(seed.teamId);
          await writeArcCache(db(), seed.teamId, "g:new-scope", [newArc], "new", { authorizationEpoch: next });
        },
      },
    );
    expect(resolutions).toBe(2);
    expect(JSON.stringify(panel.arcs)).toContain("NEW-SCOPE-MARKER");
    expect(JSON.stringify(panel.arcs)).not.toContain("OLD-SCOPE-MARKER");
  });

  it("bounds whole-scope authorization retries when every synthesis attempt is revoked", async () => {
    const seed = await seedTeam();
    let resolutions = 0;
    await expect(getAuthorizationBoundFusedArcs(
      db(), seed.teamId, seed.teamSlug, { anthropicApiKey: null, openaiApiKey: null } as never,
      async () => {
        resolutions += 1;
        return { groups: [], visibleItemIds: new Set<string>() };
      },
      { beforeFinalAuthorizationCheck: async () => { await advanceAuthorizationEpoch(seed.teamId); } },
    )).rejects.toBeInstanceOf(ArcFusionAuthorizationChangedError);
    expect(resolutions).toBe(2);
  });

  it("filters lingering graph facts after final-claim suppression even when physical cleanup fails", async () => {
    const seed = await seedTeam();
    const projectId = await privateAudience(seed, seed.memberId, "arc-suppression");
    const integrationId = await connection(seed, "arc-suppression", projectId);
    const providerId = "arc-suppression-provider";
    const item = await claimedItem(seed, providerId, [integrationId], projectId);
    const { data: project } = await db().from("projects").select("graph_group_id").eq("id", projectId).single();
    const partitionGroup = (project as { graph_group_id: string }).graph_group_id;
    const markerFact = {
      id: "marker", fact: "RETIRED-GRAPH-MARKER", at: new Date().toISOString(),
      subjectType: "work", subject: "drive", object: "marker", episodeUuids: ["ep-marker"],
    };
    const episodeItems = new Map([["ep-marker", { itemId: item.id, source: "gdrive" }]]);
    const before = await authorizationEpoch(db(), seed.teamId);
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [{
      arc_id: "retired-correction", arc_title: "Retired", corrected_text: "RETIRED-CORRECTION-MARKER",
      provenance_state: "complete", source_item_ids: [item.id], captured_authorization_epoch: before,
    }], `g:${partitionGroup}`);
    expect((await listAuthorizedArcCorrections(db(), seed.teamId, {
      groupKey: `g:${partitionGroup}`, partitionGroup, expectedAuthorizationEpoch: before,
    })).corrections.map((correction) => correction.corrected_text)).toContain("RETIRED-CORRECTION-MARKER");
    expect(await authorizedArcFacts(db(), {
      teamId: seed.teamId, partitionGroup, expectedAuthorizationEpoch: before,
      facts: [markerFact], episodeItems,
    })).toEqual([markerFact]);

    await stageGdriveReconciliation(db(), seed.teamId, {
      connectionId: integrationId, removedProviderIds: [providerId], reason: "last claim retired",
    });
    const failed = await drainGdriveCleanupObligations(db(), seed.teamId, 100, {
      purgeItemIds: async () => { throw new Error("graph cleanup remains pending"); },
    });
    expect(failed.failed).toBe(1);
    expect((await db().from("items").select("id").eq("id", item.id).maybeSingle()).data).not.toBeNull();
    const after = await authorizationEpoch(db(), seed.teamId);
    expect(after).toBeGreaterThan(before);
    expect(await authorizedArcFacts(db(), {
      teamId: seed.teamId, partitionGroup, expectedAuthorizationEpoch: after,
      facts: [markerFact], episodeItems,
    })).toEqual([]);
    const correctionAfter = await listAuthorizedArcCorrections(db(), seed.teamId, {
      groupKey: `g:${partitionGroup}`, partitionGroup, expectedAuthorizationEpoch: after,
    });
    expect(correctionAfter).toEqual({ corrections: [], ok: true });
  });

  it("keeps overlapping claims partition-exact and fails closed on unresolved/read-error provenance", async () => {
    const seed = await seedTeam();
    const projectA = await privateAudience(seed, seed.memberId, "arc-overlap-a");
    const projectB = await privateAudience(seed, seed.memberId, "arc-overlap-b");
    const connectionA = await connection(seed, "arc-overlap-a", projectA);
    const connectionB = await connection(seed, "arc-overlap-b", projectB);
    const item = await claimedItem(seed, "arc-overlap-provider", [connectionA, connectionB], projectA);
    const onlyA = await claimedItem(seed, "arc-only-a-provider", [connectionA], projectA);
    await recordGdriveItemClaim(db(), {
      teamId: seed.teamId, integrationId: connectionB, providerId: "arc-overlap-provider",
      itemId: item.id, generation: 1, audienceProjectIds: [projectB],
    });
    const { data: projects } = await db().from("projects").select("id,graph_group_id")
      .in("id", [projectA, projectB]);
    const groups = new Map((projects ?? []).map((row) => [row.id, row.graph_group_id]));
    const before = await authorizationEpoch(db(), seed.teamId);
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [{
      arc_id: "overlap-a", arc_title: "Overlap A", corrected_text: "OVERLAP-A-CORRECTION",
      provenance_state: "complete", source_item_ids: [item.id], captured_authorization_epoch: before,
    }, {
      arc_id: "mixed-a", arc_title: "Mixed A+B", corrected_text: "MIXED-A-B-CORRECTION",
      provenance_state: "complete", source_item_ids: [item.id, onlyA.id], captured_authorization_epoch: before,
    }], `g:${groups.get(projectA)!}`);
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [{
      arc_id: "overlap-b", arc_title: "Overlap B", corrected_text: "OVERLAP-B-CORRECTION",
      provenance_state: "complete", source_item_ids: [item.id], captured_authorization_epoch: before,
    }], `g:${groups.get(projectB)!}`);
    const markerFact = {
      id: "overlap", fact: "OVERLAP-AUDIENCE-MARKER", at: new Date().toISOString(),
      subjectType: "work", subject: "drive", object: "overlap", episodeUuids: ["ep-overlap"],
    };
    const episodeItems = new Map([["ep-overlap", { itemId: item.id, source: "gdrive" }]]);
    await stageGdriveReconciliation(db(), seed.teamId, {
      connectionId: connectionA,
      removedProviderIds: ["arc-overlap-provider", "arc-only-a-provider"],
      reason: "audience A removed",
    });
    const epoch = await authorizationEpoch(db(), seed.teamId);
    expect(await authorizedArcFacts(db(), {
      teamId: seed.teamId, partitionGroup: groups.get(projectA)!, expectedAuthorizationEpoch: epoch,
      facts: [markerFact], episodeItems,
    })).toEqual([]);
    expect(await authorizedArcFacts(db(), {
      teamId: seed.teamId, partitionGroup: groups.get(projectB)!, expectedAuthorizationEpoch: epoch,
      facts: [markerFact], episodeItems,
    })).toEqual([markerFact]);
    expect((await listAuthorizedArcCorrections(db(), seed.teamId, {
      groupKey: `g:${groups.get(projectA)!}`, partitionGroup: groups.get(projectA)!, expectedAuthorizationEpoch: epoch,
    })).corrections).toEqual([]);
    expect((await listAuthorizedArcCorrections(db(), seed.teamId, {
      groupKey: `g:${groups.get(projectB)!}`, partitionGroup: groups.get(projectB)!, expectedAuthorizationEpoch: epoch,
    })).corrections.map((correction) => correction.corrected_text)).toEqual(["OVERLAP-B-CORRECTION"]);
    expect(await authorizedArcFacts(db(), {
      teamId: seed.teamId, partitionGroup: groups.get(projectB)!, expectedAuthorizationEpoch: epoch,
      facts: [{ ...markerFact, episodeUuids: ["unresolved"] }], episodeItems,
    })).toEqual([]);

    const real = db();
    const failingDb = {
      ...real,
      from(table: string) {
        if (table !== "project_context_memberships") return real.from(table);
        const query: Record<string, unknown> = {};
        query.eq = () => query;
        query.is = () => query;
        query.in = async () => ({ data: null, error: { message: "injected visibility failure" } });
        return { select: () => query };
      },
    } as unknown as ReturnType<typeof db>;
    await expect(authorizedArcFacts(failingDb, {
      teamId: seed.teamId, partitionGroup: groups.get(projectB)!, expectedAuthorizationEpoch: epoch,
      facts: [markerFact], episodeItems,
    })).rejects.toBeInstanceOf(ArcInputAuthorizationUnavailableError);
    expect(await listAuthorizedArcCorrections(failingDb, seed.teamId, {
      groupKey: `g:${groups.get(projectB)!}`, partitionGroup: groups.get(projectB)!, expectedAuthorizationEpoch: epoch,
    })).toEqual({ corrections: [], ok: false });
  });

  it("keeps correction history but excludes legacy, incomplete, and deleted dependencies across reads", async () => {
    const seed = await seedTeam();
    const projectId = await privateAudience(seed, seed.memberId, "correction-provenance");
    const integrationId = await connection(seed, "correction-provenance", projectId);
    const live = await claimedItem(seed, "correction-live", [integrationId], projectId);
    const deleted = await claimedItem(seed, "correction-deleted", [integrationId], projectId);
    const { data: project } = await db().from("projects").select("graph_group_id").eq("id", projectId).single();
    const partitionGroup = (project as { graph_group_id: string }).graph_group_id;
    const epoch = await authorizationEpoch(db(), seed.teamId);

    await recordArcCorrections(db(), seed.teamId, seed.memberId, [{
      arc_id: "authorized", arc_title: "Authorized", corrected_text: "AUTHORIZED-CORRECTION",
      provenance_state: "complete", source_item_ids: [live.id], captured_authorization_epoch: epoch,
    }, {
      arc_id: "incomplete", arc_title: "Incomplete", corrected_text: "INCOMPLETE-CORRECTION",
      provenance_state: "incomplete", source_item_ids: [live.id], captured_authorization_epoch: epoch,
    }, {
      arc_id: "deleted", arc_title: "Deleted", corrected_text: "DELETED-CORRECTION",
      provenance_state: "complete", source_item_ids: [deleted.id], captured_authorization_epoch: epoch,
    }], `g:${partitionGroup}`);
    await db().from("arc_corrections").insert({
      team_id: seed.teamId, arc_id: "legacy", arc_title: "Legacy",
      corrected_text: "LEGACY-UNPROVEN-CORRECTION", group_key: `g:${partitionGroup}`,
    });
    await db().from("items").delete().eq("team_id", seed.teamId).eq("id", deleted.id);

    const first = await listAuthorizedArcCorrections(db(), seed.teamId, {
      groupKey: `g:${partitionGroup}`, partitionGroup, expectedAuthorizationEpoch: epoch,
    });
    const afterRestart = await listAuthorizedArcCorrections(db(), seed.teamId, {
      groupKey: `g:${partitionGroup}`, partitionGroup, expectedAuthorizationEpoch: epoch,
    });
    expect(first.ok).toBe(true);
    expect(first.corrections.map((correction) => correction.corrected_text)).toEqual(["AUTHORIZED-CORRECTION"]);
    expect(afterRestart.corrections.map((correction) => correction.corrected_text)).toEqual(["AUTHORIZED-CORRECTION"]);
    expect((await db().from("arc_corrections").select("id").eq("team_id", seed.teamId)).data).toHaveLength(4);
    expect((await db().from("arc_correction_revision_dependencies").select("source_item_id")
      .eq("team_id", seed.teamId).eq("source_item_id", deleted.id)).data).toHaveLength(1);
  });

  it("serializes two final-claim retirements and suppresses before retryable physical cleanup", async () => {
    const seed = await seedTeam();
    const project = await privateAudience(seed, seed.memberId, "retire-race");
    const a = await connection(seed, "retire-race-a", project);
    const b = await connection(seed, "retire-race-b", project);
    const item = await claimedItem(seed, "retire-race-provider", [a, b], project);

    await Promise.all([
      stageGdriveReconciliation(db(), seed.teamId, {
        connectionId: a, removedProviderIds: ["retire-race-provider"], reason: "retire a",
      }),
      stageGdriveReconciliation(db(), seed.teamId, {
        connectionId: b, removedProviderIds: ["retire-race-provider"], reason: "retire b",
      }),
    ]);

    const { data: obligation } = await db().from("gdrive_cleanup_obligations").select("item_id")
      .eq("team_id", seed.teamId).eq("provider_id", "retire-race-provider").single();
    expect((obligation as { item_id: string }).item_id).toBe(item.id);
    expect((await db().from("items").select("id").eq("id", item.id).maybeSingle()).data).not.toBeNull();
    expect((await db().from("project_context_units").select("state")
      .eq("team_id", seed.teamId).eq("source_item_id", item.id).single()).data)
      .toEqual(expect.objectContaining({ state: "retracted" }));

    const cleanup = await drainGdriveCleanupObligations(db(), seed.teamId);
    expect(cleanup).toEqual(expect.objectContaining({ items: 1, failed: 0, pending: 0 }));
    expect((await db().from("items").select("id").eq("id", item.id).maybeSingle()).data).toBeNull();
  });

  it("keeps cleanup durable across layer failures and cancels it when a claim is restored", async () => {
    const seed = await seedTeam();
    const project = await privateAudience(seed, seed.memberId, "cleanup-retry");
    const integrationId = await connection(seed, "cleanup-retry", project);
    const providerId = "cleanup-retry-provider";
    const item = await claimedItem(seed, providerId, [integrationId], project);
    await stageGdriveReconciliation(db(), seed.teamId, {
      connectionId: integrationId, removedProviderIds: [providerId], reason: "retry cleanup",
    });

    for (const layer of ["cache", "item", "graph"]) {
      const failed = await drainGdriveCleanupObligations(db(), seed.teamId, 100, {
        purgeItemIds: async () => { throw new Error(`${layer} cleanup failed`); },
      });
      expect(failed).toEqual(expect.objectContaining({ failed: 1, pending: 1 }));
      expect((await db().from("items").select("id").eq("id", item.id).maybeSingle()).data).not.toBeNull();
    }
    const { data: retried } = await db().from("gdrive_cleanup_obligations")
      .select("attempt_count,last_error").eq("team_id", seed.teamId).eq("provider_id", providerId).single();
    expect(retried).toEqual(expect.objectContaining({ attempt_count: 3, last_error: "graph cleanup failed" }));

    // A later process can restore the exact provider claim before retry; the same canonical lock makes
    // the obligation disappear and reactivates context instead of deleting the restored item.
    await recordGdriveItemClaim(db(), {
      teamId: seed.teamId, integrationId, providerId, itemId: item.id,
      generation: 1, audienceProjectIds: [project],
    });
    expect((await drainGdriveCleanupObligations(db(), seed.teamId)).pending).toBe(0);
    expect((await db().from("items").select("id").eq("id", item.id).maybeSingle()).data).not.toBeNull();
    expect((await db().from("project_context_units").select("state")
      .eq("team_id", seed.teamId).eq("source_item_id", item.id).single()).data)
      .toEqual(expect.objectContaining({ state: "active" }));
  });

  it("keeps retire versus audience restore coherent under the canonical provider lock", async () => {
    const seed = await seedTeam();
    const projectA = await privateAudience(seed, seed.memberId, "audience-race-a");
    const projectB = await privateAudience(seed, seed.memberId, "audience-race-b");
    const integrationId = await connection(seed, "audience-race", projectA);
    const providerId = "audience-race-provider";
    const item = await claimedItem(seed, providerId, [integrationId], projectA);

    await Promise.all([
      stageGdriveReconciliation(db(), seed.teamId, {
        connectionId: integrationId, removedProviderIds: [providerId], reason: "race retire",
      }),
      recordGdriveItemClaim(db(), {
        teamId: seed.teamId, integrationId, providerId, itemId: item.id,
        generation: 1, audienceProjectIds: [projectB],
      }),
    ]);
    const { data: claim } = await db().from("gdrive_item_claims").select("active")
      .eq("team_id", seed.teamId).eq("integration_id", integrationId).eq("provider_id", providerId).single();
    const { data: obligation } = await db().from("gdrive_cleanup_obligations").select("item_id")
      .eq("team_id", seed.teamId).eq("provider_id", providerId).maybeSingle();
    const { data: unit } = await db().from("project_context_units").select("state")
      .eq("team_id", seed.teamId).eq("source_item_id", item.id).single();
    if ((claim as { active: boolean }).active) {
      expect(obligation).toBeNull();
      expect(unit).toEqual(expect.objectContaining({ state: "active" }));
    } else {
      expect(obligation).not.toBeNull();
      expect(unit).toEqual(expect.objectContaining({ state: "retracted" }));
    }
  });

  it("migration suppresses unresolved, adopted, and mixed legacy Drive teams and is replay-safe", async () => {
    const unresolved = await seedTeam();
    const adopted = await seedTeam();
    const mixed = await seedTeam();
    const noDrive = await seedTeam();

    const legacy = async (seed: Seed, providerId: string, adopt: boolean) => {
      const item = await ingest(seed, {
        project: `legacy-${providerId}`, path: `gdrive/${providerId}.md`, body: providerId,
        access: "external", frontmatter: { source: "gdrive", source_id: providerId },
      });
      await db().from("project_context_units").insert({
        team_id: seed.teamId, source_item_id: item.id, unit_key: `legacy:${providerId}`,
        audience: "external", content_sha256: "a".repeat(64), state: "active",
      });
      if (adopt) {
        const projectId = await privateAudience(seed, seed.memberId, `legacy-audience-${providerId}`);
        const integrationId = await connection(seed, `legacy-${providerId}`, projectId);
        await db().from("source_item_mappings").update({ connection_id: integrationId })
          .eq("team_id", seed.teamId).eq("source", "gdrive").eq("provider_id", providerId);
      }
      return item.id;
    };
    await legacy(unresolved, "unresolved-only", false);
    const adoptedItem = await legacy(adopted, "adopted-only", true);
    await legacy(mixed, "mixed-adopted", true);
    await legacy(mixed, "mixed-unresolved", false);
    const local = await ingest(noDrive, {
      project: "local-only", path: "local.md", body: "local", access: "team",
      frontmatter: { source: "local" },
    });
    await db().from("project_context_units").insert({
      team_id: noDrive.teamId, source_item_id: local.id, unit_key: "legacy:local",
      audience: "team", content_sha256: "b".repeat(64), state: "active",
    });
    for (const seed of [unresolved, adopted, mixed, noDrive]) {
      await db().from("arc_cache").insert({
        team_id: seed.teamId, group_key: "g:legacy", arcs: JSON.stringify([]), authorization_epoch: 1,
      });
      await db().from("work_timeline_cache").insert({
        team_id: seed.teamId, group_key: "vis:team:legacy",
        payload: JSON.stringify({ v: 14, days: [] }), authorization_epoch: 1,
      });
    }
    const before = new Map<string, number>();
    for (const seed of [unresolved, adopted, mixed, noDrive]) {
      before.set(seed.teamId, await authorizationEpoch(db(), seed.teamId));
    }

    const migration = readFileSync("postgres/migrations/20260922130000_gdrive_audience_claims.sql", "utf8");
    await runSql(migration, []);
    for (const seed of [unresolved, adopted, mixed]) {
      expect(await authorizationEpoch(db(), seed.teamId)).toBe((before.get(seed.teamId) ?? 0) + 1);
      expect((await db().from("arc_cache").select("team_id").eq("team_id", seed.teamId)).data).toEqual([]);
      expect((await db().from("work_timeline_cache").select("team_id").eq("team_id", seed.teamId)).data).toEqual([]);
    }
    expect(await authorizationEpoch(db(), noDrive.teamId)).toBe(before.get(noDrive.teamId));
    expect((await db().from("arc_cache").select("team_id").eq("team_id", noDrive.teamId)).data).toHaveLength(1);
    expect((await db().from("work_timeline_cache").select("team_id").eq("team_id", noDrive.teamId)).data).toHaveLength(1);
    expect((await db().from("gdrive_item_claims").select("item_id")
      .eq("team_id", adopted.teamId).eq("item_id", adoptedItem)).data).toHaveLength(1);
    for (const seed of [unresolved, adopted, mixed]) {
      expect((await db().from("project_context_units").select("id").eq("team_id", seed.teamId)).data).toEqual([]);
    }

    const epochs = new Map<string, number>();
    for (const seed of [unresolved, adopted, mixed, noDrive]) {
      epochs.set(seed.teamId, await authorizationEpoch(db(), seed.teamId));
    }
    await runSql(migration, []);
    for (const seed of [unresolved, adopted, mixed, noDrive]) {
      expect(await authorizationEpoch(db(), seed.teamId)).toBe(epochs.get(seed.teamId));
    }
  });

  it("one-time arc input authorization migration advances the epoch and cannot replay", async () => {
    const seed = await seedTeam();
    await db().from("migration_markers").delete().eq("name", "aio1167_arc_input_authorization_v1");
    const before = await authorizationEpoch(db(), seed.teamId);
    await writeArcCache(db(), seed.teamId, "g:pre-policy", [], "unsafe", { authorizationEpoch: before });
    const migration = readFileSync(
      "postgres/migrations/20260922150000_arc_input_authorization_barrier.sql",
      "utf8",
    );
    await runSql(migration, []);
    expect(await authorizationEpoch(db(), seed.teamId)).toBe(before + 1);
    expect(await readArcCache(db(), seed.teamId, "g:pre-policy")).toBeNull();
    const advanced = await authorizationEpoch(db(), seed.teamId);
    await runSql(migration, []);
    expect(await authorizationEpoch(db(), seed.teamId)).toBe(advanced);
  });
});
