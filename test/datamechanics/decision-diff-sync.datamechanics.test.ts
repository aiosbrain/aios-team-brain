import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam } from "./helpers";

/**
 * Spec: a decision removed at the SOURCE must stop being served as current. Sync rows are diff-deleted
 * exactly like tasks — the contract the docs already described — while a UI-created decision
 * (`source_item_id` null) and other items' rows are untouched. Real Postgres: the observable outcome
 * is which rows survive.
 */
describe("decision diff-sync (real Postgres)", () => {
  it("deletes a sync row dropped from a later push, keeps the surviving one", async () => {
    const seed = await seedTeam();
    const path = `decisions/${randomUUID()}.md`;
    const push = (rows: { row_key: string; title: string }[], body: string) =>
      ingest(seed, { path, project: "acme", kind: "decision", access: "team", body, rows });

    await push(
      [
        { row_key: "D-1", title: "adopt postgres" },
        { row_key: "D-2", title: "retracted later" },
      ],
      "v1"
    );
    let { data } = await db().from("decisions").select("row_key").eq("team_id", seed.teamId);
    expect((data ?? []).map((r) => (r as { row_key: string }).row_key).sort()).toEqual(["D-1", "D-2"]);

    // D-2 is gone at the source → it must not keep being cited as a current decision.
    await push([{ row_key: "D-1", title: "adopt postgres" }], "v2");
    ({ data } = await db().from("decisions").select("row_key").eq("team_id", seed.teamId));
    expect((data ?? []).map((r) => (r as { row_key: string }).row_key)).toEqual(["D-1"]);
  });

  it("never deletes a UI-created decision (source_item_id null)", async () => {
    const seed = await seedTeam();
    const path = `decisions/${randomUUID()}.md`;
    await ingest(seed, {
      path, project: "acme", kind: "decision", access: "team", body: "v1",
      rows: [{ row_key: "D-9", title: "synced" }],
    });
    const { data: proj } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", "acme").maybeSingle();
    await db().from("decisions").insert({
      team_id: seed.teamId, project_id: (proj as { id: string }).id, source_item_id: null,
      row_key: "UI-1", title: "hand-written", rationale: "", decided_by: "me", impact: "", audience: "team",
    });

    // A later push that drops every sync row must leave the UI row alone.
    await ingest(seed, { path, project: "acme", kind: "decision", access: "team", body: "v2", rows: [] });
    const { data } = await db().from("decisions").select("row_key").eq("team_id", seed.teamId);
    expect((data ?? []).map((r) => (r as { row_key: string }).row_key)).toEqual(["UI-1"]);
  });
});
