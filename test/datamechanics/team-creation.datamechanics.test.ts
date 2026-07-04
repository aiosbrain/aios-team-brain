import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTeam } from "@/lib/admin/teams";
import { db } from "./helpers";

// Spec: createTeam is the no-SQL bootstrap primitive for a fresh instance — an admin runs
// this (via `npm run admin -- create-team`) instead of hand-writing SQL. Verified on real
// Postgres: it must actually persist a row, enforce the same slug shape the schema check
// constraint requires, be idempotent (safe to re-run a bootstrap script), and audit itself.

describe("createTeam (real Postgres)", () => {
  it("persists a new team row with the given slug and name", async () => {
    const slug = `team-${randomUUID().slice(0, 8)}`;
    const team = await createTeam(db(), { slug, name: "Acme Corp" });

    expect(team.slug).toBe(slug);
    expect(team.name).toBe("Acme Corp");
    expect(team.id).toBeTruthy();

    const { data: row } = await db().from("teams").select("id, slug, name").eq("id", team.id).single();
    expect(row).toMatchObject({ id: team.id, slug, name: "Acme Corp" });
  });

  it("is idempotent — re-running with the same slug returns the existing row, not a duplicate", async () => {
    const slug = `team-${randomUUID().slice(0, 8)}`;
    const first = await createTeam(db(), { slug, name: "Original Name" });
    const second = await createTeam(db(), { slug, name: "Ignored On Re-run" });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Original Name"); // the existing row wins, not the re-run's input

    const { data: rows } = await db().from("teams").select("id").eq("slug", slug);
    expect(rows).toHaveLength(1);
  });

  it("rejects a slug that violates the schema's check constraint", async () => {
    await expect(createTeam(db(), { slug: "Not_A_Valid_Slug!", name: "X" })).rejects.toThrow(/invalid slug/);
  });

  it("rejects an empty name", async () => {
    const slug = `team-${randomUUID().slice(0, 8)}`;
    await expect(createTeam(db(), { slug, name: "   " })).rejects.toThrow(/name is required/);
  });

  it("writes an audit_log entry for the new team", async () => {
    const slug = `team-${randomUUID().slice(0, 8)}`;
    const team = await createTeam(db(), { slug, name: "Audited Co" });

    const { data: entries } = await db()
      .from("audit_log")
      .select("action, target_type, target_id, team_id")
      .eq("target_id", team.id)
      .eq("action", "team.created");
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject({
      action: "team.created",
      target_type: "team",
      target_id: team.id,
      team_id: team.id,
    });
  });
});
