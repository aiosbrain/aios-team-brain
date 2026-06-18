import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getDecisionWriteback } from "@/lib/sync/decisions";
import { db, seedTeam, ingest, type Seed } from "./helpers";

// W3 sync invariants on the postgres target (NO RLS — the app-code filter is the SOLE
// enforcement). Spec-first, verified to the observable outcome (rows returned / rows in DB).
// The writeback is what `aios pull` reads to merge dashboard decisions into decision-log.md.

const EPOCH = "1970-01-01T00:00:00Z";

async function makeProject(seed: Seed, slug = "acme"): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug, name: slug })
    .select("id")
    .single();
  if (error || !data) throw new Error(`makeProject: ${error?.message}`);
  return (data as { id: string }).id;
}

async function insertUiDecision(
  seed: Seed,
  projectId: string,
  over: { row_key: string; title?: string; audience?: "team" | "external" }
): Promise<{ id: string }> {
  const { data, error } = await db()
    .from("decisions")
    .insert({
      team_id: seed.teamId,
      project_id: projectId,
      source_item_id: null, // the UI-created discriminator
      row_key: over.row_key,
      title: over.title ?? "ui decision",
      audience: over.audience ?? "team",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insertUiDecision: ${error?.message}`);
  return data as { id: string };
}

/** Ingest a synced decision via the real lib/ingest path; return the row + its source synced_at. */
async function ingestSyncedDecision(seed: Seed, row_key: string, audience: "team" | "external" = "team") {
  await ingest(seed, {
    kind: "decision",
    path: "3-log/decision-log.md",
    body: `| ${row_key} | 2026-06-18 | synced ${row_key} |`,
    access: audience,
    rows: [{ row_key, title: `synced ${row_key}`, audience }],
  } as never);
  const { data } = await db()
    .from("decisions")
    .select("id, updated_at, source_item_id, items:source_item_id(synced_at)")
    .eq("team_id", seed.teamId)
    .eq("row_key", row_key)
    .single();
  return data as unknown as {
    id: string;
    updated_at: string;
    source_item_id: string;
    items: { synced_at: string };
  };
}

function allRowKeys(groups: { rows: { row_key: string }[] }[]): string[] {
  return groups.flatMap((g) => g.rows.map((r) => r.row_key));
}

async function taskWritebackKeys(seed: Seed, since = EPOCH): Promise<string[]> {
  const { data } = await db()
    .from("tasks")
    .select("row_key, origin, updated_at, items:source_item_id(synced_at)")
    .eq("team_id", seed.teamId)
    .gt("updated_at", since)
    .not("row_key", "is", null)
    .order("updated_at", { ascending: true });
  return ((data ?? []) as unknown as {
    row_key: string;
    origin: "sync" | "ui";
    updated_at: string;
    items: { synced_at: string } | null;
  }[])
    .filter((t) => {
      if (t.origin === "ui") return true;
      const synced = t.items?.synced_at;
      return synced ? new Date(t.updated_at) > new Date(synced) : false;
    })
    .map((t) => t.row_key);
}

describe("decision writeback — what aios pull receives (real Postgres, no RLS)", () => {
  it("returns a UI-created decision (source_item_id NULL), grouped by project", async () => {
    const seed = await seedTeam();
    const projectId = await makeProject(seed, "acme");
    await insertUiDecision(seed, projectId, { row_key: "ui-aaaa1111", title: "Adopt Apache-2.0" });

    const groups = await getDecisionWriteback(db(), seed.teamId, "team", EPOCH);
    expect(groups.length).toBe(1);
    expect(groups[0].project).toBe("acme");
    expect(groups[0].rows[0]).toMatchObject({ row_key: "ui-aaaa1111", title: "Adopt Apache-2.0" });
  });

  it("excludes an UNEDITED synced decision but includes one EDITED after sync", async () => {
    const seed = await seedTeam();
    const dec = await ingestSyncedDecision(seed, "D-1");

    // Unedited: pin updated_at == source synced_at → not a dashboard change.
    await db().from("decisions").update({ updated_at: dec.items.synced_at }).eq("id", dec.id);
    let groups = await getDecisionWriteback(db(), seed.teamId, "team", EPOCH);
    expect(allRowKeys(groups)).not.toContain("D-1");

    // Edited in the dashboard: updated_at moves past synced_at → now a writeback row.
    const later = new Date(new Date(dec.items.synced_at).getTime() + 3_600_000).toISOString();
    await db().from("decisions").update({ updated_at: later }).eq("id", dec.id);
    groups = await getDecisionWriteback(db(), seed.teamId, "team", EPOCH);
    expect(allRowKeys(groups)).toContain("D-1");
  });

  it("tier isolation: an external key gets only audience='external'; team gets both", async () => {
    const seed = await seedTeam();
    const projectId = await makeProject(seed, "acme");
    await insertUiDecision(seed, projectId, { row_key: "ui-team0001", audience: "team" });
    await insertUiDecision(seed, projectId, { row_key: "ui-ext00001", audience: "external" });

    const asExternal = await getDecisionWriteback(db(), seed.teamId, "external", EPOCH);
    expect(allRowKeys(asExternal)).toEqual(["ui-ext00001"]); // crown jewel: no team leak

    const asTeam = await getDecisionWriteback(db(), seed.teamId, "team", EPOCH);
    expect(allRowKeys(asTeam).sort()).toEqual(["ui-ext00001", "ui-team0001"]); // non-vacuity
  });

  it("honors the `since` cursor (older changes excluded)", async () => {
    const seed = await seedTeam();
    const projectId = await makeProject(seed, "acme");
    const d = await insertUiDecision(seed, projectId, { row_key: "ui-cursor01" });
    const t = "2026-06-01T00:00:00Z";
    await db().from("decisions").update({ updated_at: t }).eq("id", d.id);

    expect(allRowKeys(await getDecisionWriteback(db(), seed.teamId, "team", "2026-06-02T00:00:00Z"))).not.toContain("ui-cursor01");
    expect(allRowKeys(await getDecisionWriteback(db(), seed.teamId, "team", "2026-05-01T00:00:00Z"))).toContain("ui-cursor01");
  });

  it("a UI decision is NEVER diff-deleted by a later push", async () => {
    const seed = await seedTeam();
    const projectId = await makeProject(seed, "acme");
    await insertUiDecision(seed, projectId, { row_key: "ui-survive01" });

    // Re-push a decision-log that does NOT contain the UI key.
    await ingestSyncedDecision(seed, "D-9");

    const { data } = await db()
      .from("decisions")
      .select("row_key")
      .eq("team_id", seed.teamId)
      .eq("row_key", "ui-survive01");
    expect((data ?? []).length).toBe(1); // survived
  });

  it("stops returning a UI decision after writeback is re-pushed from decision-log.md", async () => {
    const seed = await seedTeam();
    const projectId = await makeProject(seed, "acme");
    await insertUiDecision(seed, projectId, {
      row_key: "ui-roundtrip1",
      title: "Round-trip from dashboard",
      audience: "team",
    });

    expect(allRowKeys(await getDecisionWriteback(db(), seed.teamId, "team", EPOCH))).toContain(
      "ui-roundtrip1"
    );

    await ingest(seed, {
      kind: "decision",
      path: "3-log/decision-log.md",
      body:
        "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n" +
        "| ui-roundtrip1 | 2026-06-18 | Round-trip from dashboard | why | John | impact | | team |\n",
      access: "team",
      rows: [
        {
          row_key: "ui-roundtrip1",
          decided_at: "2026-06-18",
          title: "Round-trip from dashboard",
          rationale: "why",
          decided_by: "John",
          impact: "impact",
          audience: "team",
        },
      ],
    } as never);

    const { data: stored } = await db()
      .from("decisions")
      .select("source_item_id")
      .eq("team_id", seed.teamId)
      .eq("row_key", "ui-roundtrip1")
      .single();
    expect((stored as { source_item_id: string | null }).source_item_id).not.toBeNull();
    expect(allRowKeys(await getDecisionWriteback(db(), seed.teamId, "team", EPOCH))).not.toContain(
      "ui-roundtrip1"
    );
  });
});

describe("UI task persistence — survives a sync push (real Postgres)", () => {
  it("diff-delete removes a vanished SYNC row but spares the origin='ui' row", async () => {
    const seed = await seedTeam();
    // First push: two synced tasks.
    await ingest(seed, {
      kind: "task",
      path: "3-log/tasks.md",
      body: "| T-1 | a |\n| T-2 | b |",
      access: "team",
      rows: [
        { row_key: "T-1", title: "a" },
        { row_key: "T-2", title: "b" },
      ],
    } as never);
    const { data: project } = await db()
      .from("projects")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("slug", "acme")
      .single();
    const projectId = (project as { id: string }).id;

    // A dashboard task (origin='ui') in the same project.
    await db().from("tasks").insert({
      team_id: seed.teamId,
      project_id: projectId,
      row_key: `ui-${randomUUID().slice(0, 8)}`,
      title: "ui task",
      origin: "ui",
    });

    // Second push: T-2 has vanished from tasks.md.
    await ingest(seed, {
      kind: "task",
      path: "3-log/tasks.md",
      body: "| T-1 | a |",
      access: "team",
      rows: [{ row_key: "T-1", title: "a" }],
    } as never);

    const { data: rows } = await db()
      .from("tasks")
      .select("row_key, origin")
      .eq("team_id", seed.teamId);
    const byKey = Object.fromEntries((rows ?? []).map((r: { row_key: string; origin: string }) => [r.row_key, r.origin]));
    expect(byKey["T-1"]).toBe("sync"); // still present
    expect(byKey["T-2"]).toBeUndefined(); // diff-deleted (non-vacuity: the guard fires)
    expect(Object.values(byKey)).toContain("ui"); // the UI task survived
  });

  it("stops returning a UI task after writeback is re-pushed from tasks.md", async () => {
    const seed = await seedTeam();
    const projectId = await makeProject(seed, "acme");
    await db().from("tasks").insert({
      team_id: seed.teamId,
      project_id: projectId,
      row_key: "ui-taskround",
      title: "Round-trip task",
      origin: "ui",
    });

    expect(await taskWritebackKeys(seed)).toContain("ui-taskround");

    await ingest(seed, {
      kind: "task",
      path: "3-log/tasks.md",
      body: "| ID | Task | Assignee | Status | Sprint | Due |\n| ui-taskround | Round-trip task | | backlog | | |",
      access: "team",
      rows: [{ row_key: "ui-taskround", title: "Round-trip task", status: "backlog" }],
    } as never);

    const { data: stored } = await db()
      .from("tasks")
      .select("source_item_id, origin")
      .eq("team_id", seed.teamId)
      .eq("row_key", "ui-taskround")
      .single();
    expect((stored as { source_item_id: string | null; origin: string }).source_item_id).not.toBeNull();
    expect((stored as { source_item_id: string | null; origin: string }).origin).toBe("sync");
    expect(await taskWritebackKeys(seed)).not.toContain("ui-taskround");
  });
});
