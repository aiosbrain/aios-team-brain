import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { db, ingest, seedTeam, placeMemberByTier, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { visibleItemIds } from "@/lib/access/enforce";
import { rowVisibleByProvenance } from "@/lib/access/provenance";
import { newSqlParams, provenanceRowSqlFromIds } from "@/lib/access/provenance-sql";
import { runSql } from "@/lib/db/pg/pool";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";
import { getDecisionWriteback } from "@/lib/sync/decisions";
import { matchingDecisions } from "@/lib/query/structured-extras";
import { getMemberContext } from "@/lib/identity/context";
import { getPulseMetrics } from "@/lib/metrics/pulse";
import { issueApiKey } from "@/lib/admin/keys";
import { GET as tasksGET } from "@/app/api/v1/tasks/route";

// ENFB-2 AC4/AC5 (docs/design/enfb2-title-count-surfaces.md §2.2): the provenance predicate
// compiles IN-QUERY at every capped structured window — the starvation class dies — and the
// SQL owner agrees with the TS owner against FIXTURE-LEVEL EXPECTED TRUTH (round-2 M7: parity
// alone lets both owners be wrong together). Every planted row below carries its expected
// visibility, hand-derived from the access-substrate contract.

async function seedMember(seed: Seed, posture: "team" | "external" = "team"): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: posture, status: "active" })
    .select("id")
    .single();
  await placeMemberByTier(seed.teamId, data!.id as string, posture);
  return data!.id as string;
}

async function restrictInto(seed: Seed, itemId: string, memberInGroup?: string): Promise<string> {
  const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `r-${randomUUID().slice(0, 8)}`, name: "R", kind: "initiative" }).select("id").single();
  const g = await createGroup(db(), seed.teamId, `rg-${randomUUID().slice(0, 8)}`, "RG", seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, proj!.id as string, g.groupId!, seed.memberId);
  if (memberInGroup) await addMemberToGroup(db(), seed.teamId, g.groupId!, memberInGroup, seed.memberId);
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: proj!.id as string, context_unit_id: unit!.id, method: "manual" });
  expect(error, "restrict fixture must insert").toBeNull();
  return proj!.id as string;
}

async function ctxFor(seed: Seed, memberId: string, posture = true) {
  const vis = await visibleItemIds(db(), { teamId: seed.teamId, memberId });
  expect(vis.error, "oracle resolution must not error").toBeFalsy();
  return { visibleItemIds: vis.ids, teamPosture: posture };
}

describe("ENFB-2 §2.2 — the SQL owner and the TS owner agree with fixture-level EXPECTED TRUTH", () => {
  it("all arms incl. the four inverse conjuncts (exclude / expired / retracted / non-item)", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: "px", name: "P", kind: "source" }).select("id").single();
    const projectId = proj!.id as string;

    // Items with distinct membership shapes.
    const granted = await ingest(seed, { path: "g.md", body: "g", access: "team", project: "px" });
    const restricted = await ingest(seed, { path: "u.md", body: "u", access: "team", project: "px" });
    const excluded = await ingest(seed, { path: "e.md", body: "e", access: "team", project: "px" });
    const expired = await ingest(seed, { path: "x.md", body: "x", access: "team", project: "px" });
    const retracted = await ingest(seed, { path: "t.md", body: "t", access: "team", project: "px" });
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, restricted.id, insider);
    // exclude: the general membership flips to decision='exclude'.
    const { data: exUnit } = await db().from("project_context_units").select("id").eq("source_item_id", excluded.id).single();
    await db().from("project_context_memberships").update({ decision: "exclude" }).eq("context_unit_id", exUnit!.id).is("valid_to", null);
    // expired: valid_to set.
    const { data: xpUnit } = await db().from("project_context_units").select("id").eq("source_item_id", expired.id).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", xpUnit!.id).is("valid_to", null);
    // retracted: the unit state flips.
    await db().from("project_context_units").update({ state: "retracted" }).eq("source_item_id", retracted.id);

    // Structured rows over those sources + the hand-typed / no-provenance arms.
    const mk = async (key: string, over: Record<string, unknown>) => {
      const { error } = await db().from("tasks").insert({ team_id: seed.teamId, project_id: projectId, row_key: key, title: key, status: "backlog", origin: "sync", ...over });
      expect(error, `fixture task ${key}`).toBeNull();
    };
    await mk("SRC-GRANTED", { source_item_id: granted.id });
    await mk("SRC-RESTRICTED", { source_item_id: restricted.id });
    await mk("SRC-EXCLUDED", { source_item_id: excluded.id });
    await mk("SRC-EXPIRED", { source_item_id: expired.id });
    await mk("SRC-RETRACTED", { source_item_id: retracted.id });
    await mk("HAND-TYPED", { origin: "ui", created_by: insider, source_item_id: null });
    await mk("NO-PROV", { origin: "ui", source_item_id: null });

    // Fixture-level EXPECTED truth per (viewer, row) — the third artifact.
    const expectFor = (viewer: "insider" | "outsider" | "external"): Record<string, boolean> => ({
      "SRC-GRANTED": true, // general-granted item — every everyone-member sees it (external: via external-shared? NO → false)
      "SRC-RESTRICTED": viewer === "insider",
      "SRC-EXCLUDED": false,
      "SRC-EXPIRED": false,
      "SRC-RETRACTED": false,
      "HAND-TYPED": viewer !== "external", // created_by ∧ team posture
      "NO-PROV": false,
    });

    for (const [name, memberId, posture] of [
      ["insider", insider, true],
      ["outsider", outsider, true],
    ] as const) {
      const ctx = await ctxFor(seed, memberId, posture);
      const expected = expectFor(name);
      if (name === "external") expected["SRC-GRANTED"] = false;

      // OWNER 1 — the SQL window.
      const p = newSqlParams();
      const res = await runSql<{ row_key: string }>(
        `select t.row_key from tasks t where t.team_id = ${p.add(seed.teamId)} and ${provenanceRowSqlFromIds("t", p, ctx)}`,
        p.values
      );
      const sqlVisible = new Set(res.rows.map((r) => r.row_key));
      // OWNER 2 — the TS rule over the same materialized set.
      const { data: allRows } = await db().from("tasks").select("row_key, source_item_id, created_by").eq("team_id", seed.teamId);
      for (const [key, want] of Object.entries(expected)) {
        expect(sqlVisible.has(key), `SQL owner: viewer=${name} row=${key}`).toBe(want);
        const row = (allRows ?? []).find((r) => r.row_key === key)!;
        expect(
          rowVisibleByProvenance(row as { source_item_id: string | null; created_by: string | null }, ctx.visibleItemIds, posture ? "team" : "external"),
          `TS owner: viewer=${name} row=${key}`
        ).toBe(want);
      }
    }

    // External-posture arm: hand-typed closes; nothing else opens.
    const external = await seedMember(seed, "external");
    const extCtx = await ctxFor(seed, external, false);
    const p2 = newSqlParams();
    const extRes = await runSql<{ row_key: string }>(
      `select t.row_key from tasks t where t.team_id = ${p2.add(seed.teamId)} and ${provenanceRowSqlFromIds("t", p2, extCtx)}`,
      p2.values
    );
    expect(extRes.rows.map((r) => r.row_key), "external: no hand-typed, no team-granted sources").toEqual([]);
  });
});

describe("ENFB-2 AC4 — starvation dies at the capped windows", () => {
  async function starvationFixture(seed: Seed, insider: string) {
    // ONE visible source (general) + ONE restricted source only the insider holds.
    const openItem = await ingest(seed, { path: "open.md", body: "o", access: "team", project: "sv" });
    const secretItem = await ingest(seed, { path: "secret.md", body: "s", access: "team", project: "sv" });
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, secretItem.id, insider);
    const { data: proj } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", "sv").single();
    return { openItem, secretItem, projectId: proj!.id as string };
  }

  it("tasks API table window: 500 NEWER invisible rows cannot starve the one older visible row; unknown_keys stays honest", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const { openItem, secretItem, projectId } = await starvationFixture(seed, insider);

    const old = new Date(Date.now() - 86_400_000).toISOString();
    await db().from("tasks").insert({ team_id: seed.teamId, project_id: projectId, row_key: "VIS-1", title: "visible", status: "backlog", origin: "sync", source_item_id: openItem.id, updated_at: old });
    // 500 newer INVISIBLE rows (restricted source) — the full window size.
    const bulk = Array.from({ length: 500 }, (_, i) => ({
      team_id: seed.teamId, project_id: projectId, row_key: `INV-${i}`, title: `inv ${i}`, status: "backlog", origin: "sync", source_item_id: secretItem.id,
    }));
    const { error } = await db().from("tasks").insert(bulk);
    expect(error, "bulk fixture insert").toBeNull();

    const { key } = await issueApiKey(db(), seed.teamId, outsider, "k");
    const req = (q: string) => new Request(`http://test/api/v1/tasks?${q}`, { headers: { authorization: `Bearer ${key}` } }) as unknown as NextRequest;

    const res = await tasksGET(req("all=1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { project: string; rows: { row_key: string }[] }[] };
    const served = body.tasks.flatMap((g) => g.rows.map((r) => r.row_key));
    expect(served, "the visible row survives 500 newer invisible rows").toContain("VIS-1");
    expect(served.some((k2) => k2.startsWith("INV-")), "no invisible row serves").toBe(false);

    // unknown_keys: a membership-hidden key reports unknown, truncated:false (§5.7 for keys).
    const keyRes = await tasksGET(req("mode=table&keys=VIS-1,INV-3,NOPE-1"));
    const keyBody = (await keyRes.json()) as { unknown_keys: string[] | null };
    expect(keyBody.unknown_keys, "hidden and absent keys are indistinguishable").toEqual(["INV-3", "NOPE-1"]);

    // The insider sees the restricted rows (non-vacuity of the wall).
    const { key: insiderKey } = await issueApiKey(db(), seed.teamId, insider, "k2");
    const inRes = await tasksGET(new Request(`http://test/api/v1/tasks?all=1`, { headers: { authorization: `Bearer ${insiderKey}` } }) as unknown as NextRequest);
    const inBody = (await inRes.json()) as { tasks: { rows: { row_key: string }[] }[] };
    expect(inBody.tasks.flatMap((g) => g.rows.map((r) => r.row_key)).filter((k3) => k3.startsWith("INV-")).length).toBeGreaterThan(0);
  });

  it("decisions writeback window: visible-but-NOT-writeback rows cannot starve a writeback row (round-1 F3), and invisible rows cannot starve visible ones", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const { openItem, secretItem, projectId } = await starvationFixture(seed, insider);

    // The one WRITEBACK row: hand-typed (null source, created_by) — oldest updated_at.
    const old = new Date(Date.now() - 86_400_000).toISOString();
    await db().from("decisions").insert({ team_id: seed.teamId, project_id: projectId, row_key: "WB-1", title: "writeback", rationale: "r", decided_by: "x", impact: "m", source_item_id: null, created_by: insider, updated_at: old });
    // 500 newer VISIBLE-but-not-writeback rows: sourced from the open item, NOT edited after
    // its sync (items.synced_at in the future of updated_at).
    await db().from("items").update({ synced_at: new Date(Date.now() + 3_600_000).toISOString() }).eq("id", openItem.id);
    const bulkVisible = Array.from({ length: 500 }, (_, i) => ({
      team_id: seed.teamId, project_id: projectId, row_key: `NV-${i}`, title: `nv ${i}`, rationale: "r", decided_by: "x", impact: "m", source_item_id: openItem.id,
    }));
    expect((await db().from("decisions").insert(bulkVisible)).error).toBeNull();
    // And 200 newer INVISIBLE rows (restricted source, "edited after sync" so they'd be
    // writeback if visible).
    await db().from("items").update({ synced_at: old }).eq("id", secretItem.id);
    const bulkInvisible = Array.from({ length: 200 }, (_, i) => ({
      team_id: seed.teamId, project_id: projectId, row_key: `ID-${i}`, title: `id ${i}`, rationale: "r", decided_by: "x", impact: "m", source_item_id: secretItem.id,
    }));
    expect((await db().from("decisions").insert(bulkInvisible)).error).toBeNull();

    const groups = await getDecisionWriteback(db(), seed.teamId, "team", "1970-01-01T00:00:00Z", await ctxFor(seed, outsider));
    const keys = groups.flatMap((g) => g.rows.map((r) => r.row_key));
    expect(keys, "the writeback row survives 700 newer non-serving rows").toContain("WB-1");
    expect(keys.some((k) => k.startsWith("NV-")), "unchanged synced rows are not writeback").toBe(false);
    expect(keys.some((k) => k.startsWith("ID-")), "invisible rows never serve").toBe(false);
  });

  it("decisionsCardWindow + boardTaskWindow (M4 pins): the Pulse card serves 8 VISIBLE rows behind 8+ invisible newer; the board window fills with visible rows", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const { openItem, secretItem, projectId } = await starvationFixture(seed, insider);

    const old = (i: number) => new Date(Date.now() - (i + 1) * 3_600_000).toISOString();
    // 9 older VISIBLE decisions + 10 newer INVISIBLE ones.
    const visRows = Array.from({ length: 9 }, (_, i) => ({
      team_id: seed.teamId, project_id: projectId, row_key: `CV-${i}`, title: `vis ${i}`, rationale: "r", decided_by: "x", impact: "m", source_item_id: openItem.id, decided_at: old(i).slice(0, 10),
    }));
    const invRows = Array.from({ length: 10 }, (_, i) => ({
      team_id: seed.teamId, project_id: projectId, row_key: `CI-${i}`, title: `inv ${i}`, rationale: "r", decided_by: "x", impact: "m", source_item_id: secretItem.id, decided_at: new Date().toISOString().slice(0, 10),
    }));
    expect((await db().from("decisions").insert([...visRows, ...invRows])).error).toBeNull();

    const { decisionsCardWindow, boardTaskWindow } = await import("@/lib/access/structured-windows");
    const card = await decisionsCardWindow(seed.teamId, await ctxFor(seed, outsider), false);
    expect(card.length, "a full 8 VISIBLE rows serve (a post-filter would have starved to 0)").toBe(8);
    expect(card.every((d) => d.source_item_id === openItem.id), "no invisible row reaches the card").toBe(true);

    // The board window: 30 newer invisible tasks cannot displace the one visible row.
    await db().from("tasks").insert({ team_id: seed.teamId, project_id: projectId, row_key: "B-VIS", title: "b", status: "backlog", origin: "sync", source_item_id: openItem.id, updated_at: old(50) });
    const bulk = Array.from({ length: 30 }, (_, i) => ({
      team_id: seed.teamId, project_id: projectId, row_key: `B-INV-${i}`, title: `bi ${i}`, status: "backlog", origin: "sync", source_item_id: secretItem.id,
    }));
    expect((await db().from("tasks").insert(bulk)).error).toBeNull();
    const board = await boardTaskWindow<{ row_key: string | null }>(seed.teamId, await ctxFor(seed, outsider), false);
    expect(board.map((t) => t.row_key), "the visible board row survives").toContain("B-VIS");
    expect(board.some((t) => (t.row_key ?? "").startsWith("B-INV-")), "no invisible board row serves").toBe(false);
  });

  it("matchingDecisions keyword window: invisible keyword hits cannot starve the visible one", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const { openItem, secretItem, projectId } = await starvationFixture(seed, insider);

    await db().from("decisions").insert({ team_id: seed.teamId, project_id: projectId, row_key: "KW-VIS", title: "zebra widget adoption", rationale: "zebra", decided_by: "x", impact: "m", source_item_id: openItem.id });
    const bulk = Array.from({ length: 15 }, (_, i) => ({
      team_id: seed.teamId, project_id: projectId, row_key: `KW-INV-${i}`, title: `zebra secret ${i}`, rationale: "zebra", decided_by: "x", impact: "m", source_item_id: secretItem.id,
    }));
    expect((await db().from("decisions").insert(bulk)).error).toBeNull();

    const outsiderHits = await matchingDecisions(seed.teamId, "team", "zebra", 10, await ctxFor(seed, outsider));
    expect(outsiderHits.map((d) => d.row_key), "the visible hit survives 15 invisible keyword matches").toContain("KW-VIS");
    expect(outsiderHits.some((d) => d.row_key.startsWith("KW-INV-"))).toBe(false);
    const insiderHits = await matchingDecisions(seed.teamId, "team", "zebra", 10, await ctxFor(seed, insider));
    expect(insiderHits.some((d) => d.row_key.startsWith("KW-INV-")), "the insider grounds on the restricted decisions").toBe(true);
  });
});

describe("ENFB-2 AC5 — counts compute over the visible sets", () => {
  it("deriveProjects (member context) and the Pulse funnel: non-grantee vs grantee", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const secretItem = await ingest(seed, { path: "s2.md", body: "s", access: "team", project: "cv" });
    const openItem = await ingest(seed, { path: "o2.md", body: "o", access: "team", project: "cv" });
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, secretItem.id, insider);
    const { data: proj } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId).eq("slug", "cv").single();
    const projectId = proj!.id as string;

    // The profiled person is assigned one open visible task and two restricted ones.
    const { data: person } = await db().from("members").insert({ team_id: seed.teamId, email: `${randomUUID()}@t.local`, display_name: "Pat Doe", actor_handle: "patdoe", role: "member", tier: "team", status: "active" }).select("id").single();
    await db().from("tasks").insert([
      { team_id: seed.teamId, project_id: projectId, row_key: "CV-1", title: "open", status: "backlog", origin: "sync", assignee: "Pat Doe", source_item_id: openItem.id },
      { team_id: seed.teamId, project_id: projectId, row_key: "CV-2", title: "sec", status: "backlog", origin: "sync", assignee: "Pat Doe", source_item_id: secretItem.id },
      { team_id: seed.teamId, project_id: projectId, row_key: "CV-3", title: "sec2", status: "done", origin: "sync", assignee: "Pat Doe", source_item_id: secretItem.id },
    ]);

    const outsiderCtx = await ctxFor(seed, outsider);
    const insiderCtx = await ctxFor(seed, insider);
    const outsiderView = await getMemberContext(db(), seed.teamId, person!.id as string, "team", outsiderCtx);
    const insiderView = await getMemberContext(db(), seed.teamId, person!.id as string, "team", insiderCtx);
    const outsiderProj = outsiderView!.projects.find((pr) => pr.slug === "cv");
    const insiderProj = insiderView!.projects.find((pr) => pr.slug === "cv");
    expect(outsiderProj, "the container still surfaces (it holds a visible task)").toBeTruthy();
    expect({ open: outsiderProj!.open, total: outsiderProj!.total }, "non-grantee counts = visible tasks only").toEqual({ open: 1, total: 1 });
    expect({ open: insiderProj!.open, total: insiderProj!.total }, "grantee counts include the restricted tasks").toEqual({ open: 2, total: 3 });
    // Fail closed: no ctx → no derived projects (never the ungated team-wide read).
    const noCtx = await getMemberContext(db(), seed.teamId, person!.id as string, "team");
    expect(noCtx!.projects).toEqual([]);

    // Pulse funnel: task-status counts are visible-only.
    const outsiderPulse = await getPulseMetrics(db(), seed.teamId, "7d", { isAdmin: false, memberId: outsider, tier: "team", provCtx: outsiderCtx });
    const insiderPulse = await getPulseMetrics(db(), seed.teamId, "7d", { isAdmin: false, memberId: insider, tier: "team", provCtx: insiderCtx });
    const total = (m: Awaited<ReturnType<typeof getPulseMetrics>>) => m.funnel.reduce((a, r) => a + r.count, 0);
    expect(total(outsiderPulse), "non-grantee funnel counts only the visible task").toBe(1);
    expect(total(insiderPulse), "grantee funnel counts all three").toBe(3);
  });
});
