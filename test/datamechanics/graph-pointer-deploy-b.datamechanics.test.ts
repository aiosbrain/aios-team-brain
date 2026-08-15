import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectItemsToGraph } from "@/lib/graph/project";
import { episodeGroupId, projectGroupId } from "@/lib/graph/group";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { ensureMeetingTodoProject } from "@/lib/meetings/extract-todos";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam, sha } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

/**
 * PCCC-4 (Deploy B) — the narrow unique drops; `projects.graph_group_id` stored pointers land.
 *
 * Design: docs/design/phase-c-per-project-graphs.md §2.1 step 2 + §2.4 step 2 (spec
 * `docs/specs/project-context-classification-v1.md` ~946-950: pointers are STORED, not inferred;
 * General grandfathers `<slug>_team`, external-shared grandfathers `<slug>_external`; new projects
 * mint `projectGroupId`). Written before the implementation — red on Deploy-A code.
 *
 * Why this tier: every claim is a real-Postgres outcome — what the schema accepts after the drop,
 * what the backfill writes on populated rows, what each creation path durably records.
 */

const MIGRATION_DIR = join(process.cwd(), "postgres", "migrations");

describe("PCCC-4 Deploy B — the narrow unique is gone; the wide arbiter rules alone", () => {
  it("a second row for the same item in a DIFFERENT group is now LEGAL (fan-out's substrate)", async () => {
    const seed = await seedTeam();
    const sourceId = crypto.randomUUID();
    const base = { team_id: seed.teamId, source_table: "items", source_id: sourceId, content_sha256: sha("x") };
    const first = await db()
      .from("graph_episodes")
      .insert({ ...base, group_id: episodeGroupId(seed.teamSlug, "team") });
    expect(first.error).toBeNull();
    const second = await db()
      .from("graph_episodes")
      .insert({ ...base, group_id: `g_${"a".repeat(32)}_p_${"b".repeat(32)}` });
    expect(second.error).toBeNull();
  });

  it("a duplicate (item, group) row is STILL rejected — the wide arbiter is the surviving invariant", async () => {
    const seed = await seedTeam();
    const row = {
      team_id: seed.teamId,
      source_table: "items",
      source_id: crypto.randomUUID(),
      group_id: episodeGroupId(seed.teamSlug, "team"),
      content_sha256: sha("x"),
    };
    expect((await db().from("graph_episodes").insert(row)).error).toBeNull();
    expect((await db().from("graph_episodes").insert(row)).error).not.toBeNull();
  });

  it("a tier flip still MOVES the single ledger row — the design's first 'relax to plain upsert' ruling was a leak (amended §2.1)", async () => {
    // With the narrow unique gone, a plain 4-column upsert on a flip would INSERT a second row and
    // leave the old-group row live with a real sha and no pending flag — and reconcile's sentinel
    // re-queue would then RE-POPULATE the vacated tier group. The move-UPDATE must survive Deploy B.
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    const r = await ingest(seed, { body: "flip across tiers under deploy B", path: "flipb.md", access: "external" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    expect((await db().from("items").update({ access: "team" }).eq("id", r.id)).error).toBeNull();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const rows = await runSql<{ group_id: string; pending_delete_group_id: string | null }>(
      "select group_id, pending_delete_group_id from graph_episodes where team_id = $1 and source_id = $2",
      [seed.teamId, r.id]
    );
    expect(rows.rows).toHaveLength(1); // moved — NOT duplicated, nothing for reconcile to resurrect
    expect(rows.rows[0].group_id).toBe(episodeGroupId(seed.teamSlug, "team"));
    expect(rows.rows[0].pending_delete_group_id).toBe(episodeGroupId(seed.teamSlug, "external"));
  });
});

describe("PCCC-4 — projects.graph_group_id: stored pointers, one writer", () => {
  it("the backfill migration is idempotent on populated rows and writes the spec's grandfathered mapping", async () => {
    const seed = await seedTeam();
    // Pre-migration shape: rows with NULL pointers (the column exists after container creation, so
    // null them explicitly — these simulate rows that predate the migration).
    const mk = async (slug: string, kind: string) => {
      const { data, error } = await db()
        .from("projects")
        .insert({ team_id: seed.teamId, slug, name: slug, kind })
        .select("id")
        .single();
      expect(error).toBeNull();
      const id = (data as { id: string }).id;
      await runSql("update projects set graph_group_id = null where id = $1", [id]);
      return id;
    };
    const generalId = await mk("general", "system");
    const externalId = await mk("external-shared", "system");
    const initiativeId = await mk("initiative-x", "initiative");
    const sourceId = await mk("acme-repo", "source");

    const migration = readFileSync(join(MIGRATION_DIR, "20260815140000_projects_graph_group_id.sql"), "utf8");
    await runSql(migration, []);
    await runSql(migration, []); // replay — must be a no-op, never a re-mint

    const read = async (id: string) =>
      (await runSql<{ g: string | null }>("select graph_group_id as g from projects where id = $1", [id])).rows[0]?.g;
    expect(await read(generalId)).toBe(`${seed.teamSlug}_team`);
    expect(await read(externalId)).toBe(`${seed.teamSlug}_external`);
    expect(await read(initiativeId)).toBe(projectGroupId(seed.teamId, initiativeId));
    expect(await read(sourceId)).toBe(projectGroupId(seed.teamId, sourceId));
  });

  it("ensureProjectGraphPointer mints for ordinary projects, grandfathers built-ins, and never mutates an existing pointer", async () => {
    const seed = await seedTeam();
    const { data } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: "proj-a", name: "A", kind: "initiative" })
      .select("id")
      .single();
    const id = (data as { id: string }).id;
    await runSql("update projects set graph_group_id = null where id = $1", [id]);

    const first = await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId: id });
    expect(first.ok).toBe(true);
    const g1 = (await runSql<{ g: string }>("select graph_group_id as g from projects where id = $1", [id])).rows[0].g;
    expect(g1).toBe(projectGroupId(seed.teamId, id));

    // Immutable: a second call — even one that would mint differently — changes nothing.
    await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId: id });
    const g2 = (await runSql<{ g: string }>("select graph_group_id as g from projects where id = $1", [id])).rows[0].g;
    expect(g2).toBe(g1);
  });

  it("adopting a source project as a §11 built-in CORRECTS a minted pointer to the legacy tier id (the one sanctioned rewrite)", async () => {
    const seed = await seedTeam();
    // A team whose 'general' began life as an ingestion container: minted pointer, then adopted.
    const { data } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: "general", name: "general", kind: "source" })
      .select("id")
      .single();
    const id = (data as { id: string }).id;
    await runSql("update projects set graph_group_id = $1 where id = $2", [projectGroupId(seed.teamId, id), id]);

    // Adoption happens inside the access bootstrap (source → system kind flip).
    const boot = await ensureAccessBootstrap(db(), seed.teamId);
    expect(boot.ok).toBe(true);
    const g = (await runSql<{ g: string }>("select graph_group_id as g from projects where id = $1", [id])).rows[0].g;
    expect(g).toBe(`${seed.teamSlug}_team`); // the partition where an adopted General's content actually lives
  });

  it("every callable creation path records a pointer: bootstrap built-ins, ingest source projects, the meetings project", async () => {
    const seed = await seedTeam();
    const boot = await ensureAccessBootstrap(db(), seed.teamId);
    expect(boot.ok).toBe(true);
    const r = await ingest(seed, { body: "creates its source project", path: "p.md", access: "team", project: "fresh-src" });
    expect(r.id).toBeTruthy();
    const meetingProjectId = await ensureMeetingTodoProject(db(), seed.teamId);

    const rows = await runSql<{ slug: string; kind: string; g: string | null }>(
      "select slug, kind, graph_group_id as g from projects where team_id = $1 order by slug",
      [seed.teamId]
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(4);
    for (const p of rows.rows) expect(p.g, `pointer missing for ${p.slug}`).toBeTruthy();
    const bySlug = Object.fromEntries(rows.rows.map((p) => [p.slug, p]));
    expect(bySlug["general"].g).toBe(`${seed.teamSlug}_team`);
    expect(bySlug["external-shared"].g).toBe(`${seed.teamSlug}_external`);
    expect(bySlug["fresh-src"].g).toMatch(/^g_[0-9a-f]{32}_p_[0-9a-f]{32}$/);
    expect(meetingProjectId).toBeTruthy();
    expect(bySlug["extracted-from-meetings"].g).toMatch(/^g_[0-9a-f]{32}_p_[0-9a-f]{32}$/);
  });

  it("two projects can never share a graph partition (partial unique on graph_group_id)", async () => {
    const seed = await seedTeam();
    const { data } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: "p-one", name: "one", kind: "initiative" })
      .select("id")
      .single();
    const id1 = (data as { id: string }).id;
    await runSql("update projects set graph_group_id = $1 where id = $2", [projectGroupId(seed.teamId, id1), id1]);

    const { data: d2 } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: "p-two", name: "two", kind: "initiative" })
      .select("id")
      .single();
    const id2 = (d2 as { id: string }).id;
    const clash = await runSql(
      "update projects set graph_group_id = $1 where id = $2",
      [projectGroupId(seed.teamId, id1), id2]
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(clash).not.toBeNull(); // the partition space is injective by constraint, not convention
  });
});
