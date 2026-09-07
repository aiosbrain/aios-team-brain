// AIO-1109 companion: test-only IPC provisioning for the workspace-owned wire assertions.
import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "pg";
import { db, seedTeam, ingest, externalMember } from "../datamechanics/helpers";
import { BASE_URL, convergeTeam } from "./http-helpers";
import { issueApiKey } from "@/lib/admin/keys";
import { createGroup, addMemberToGroup, removeMemberFromGroup, grantProjectToGroup, revokeProjectFromGroup } from "@/lib/access/groups";

it("runs the actual workspace MCP process against disposable Brain fixtures", async () => {
  const workspace = process.env.MCP_WORKSPACE_DIR;
  if (!workspace) throw new Error("MCP_WORKSPACE_DIR is required");
  const seed = await seedTeam();
  try {
    const admin = db();
    const promoted = await admin.from("members").update({ role: "admin" }).eq("id", seed.memberId);
    expect(promoted.error).toBeNull();
    const external = await externalMember(seed);
    const boardMember = await externalMember(seed);
    const { data: everyone } = await admin.from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").single();
    expect((await addMemberToGroup(admin, seed.teamId, everyone!.id, boardMember, seed.memberId)).ok).toBe(true);
    const visible = "4-shared/mcp-visible.md";
    const granted = "2-work/mcp-grant-only.md";
    await ingest(seed, { path: visible, body: "Synthetic public lighthouse", access: "external" });
    const x = await ingest(seed, { path: granted, body: "Synthetic granted juniper", access: "team" });
    await ingest(seed, { path: "2-work/mcp-hidden.md", body: "Synthetic hidden obsidian", access: "team" });
    await convergeTeam(seed);
    // Same fixture topology as the Brain's membership leak suite: an ingested item
    // is assigned to a restricted initiative, not its General backfill membership.
    const { data: project, error } = await admin.from("projects").insert({
      team_id: seed.teamId, slug: `mcp-${randomUUID().slice(0, 8)}`, name: "MCP grant fixture", kind: "initiative",
    }).select("id").single();
    expect(error).toBeNull();
    const { data: unit } = await admin.from("project_context_units").select("id").eq("source_item_id", x.id).single();
    expect(unit).toBeTruthy();
    expect((await admin.from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id)).error).toBeNull();
    expect((await admin.from("project_context_memberships").insert({ team_id: seed.teamId, project_id: project!.id, context_unit_id: unit!.id, method: "manual" })).error).toBeNull();
    const group = await createGroup(admin, seed.teamId, "mcp-grantees", "MCP grantees", seed.memberId);
    expect(group.ok, group.error).toBe(true);
    expect((await addMemberToGroup(admin, seed.teamId, group.groupId!, external, seed.memberId)).ok).toBe(true);
    const { key: teamKey } = await issueApiKey(admin, seed.teamId, boardMember, "MCP stale-list test");
    const { key: externalKey } = await issueApiKey(admin, seed.teamId, external, "MCP external test");
    const child = spawn(process.execPath, [resolve(workspace, "test/brain-mcp-tier-safety.test.mjs")], {
      cwd: workspace,
      env: { PATH: process.env.PATH, MCP_SAFETY_FIXTURE: JSON.stringify({ url: BASE_URL, team: seed.teamSlug, teamKey, externalKey, visible, granted }) },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let chain = Promise.resolve();
    child.on("message", (message: { id: number; command: string }) => {
      chain = chain.then(async () => {
        try {
          let result;
          if (message.command === "demote") result = await removeMemberFromGroup(admin, seed.teamId, everyone!.id, boardMember, seed.memberId);
          else if (message.command === "grant") result = await grantProjectToGroup(admin, seed.teamId, project!.id, group.groupId!, seed.memberId);
          else if (message.command === "revoke") result = await revokeProjectFromGroup(admin, seed.teamId, project!.id, group.groupId!, { kind: "member", memberId: seed.memberId });
          else throw new Error("unknown fixture command");
          if (!result.ok) throw new Error(result.error);
          if (child.connected) child.send({ id: message.id, result });
        } catch (error) {
          if (child.connected) child.send({ id: message.id, error: String(error) });
        }
      });
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 150000);
    try {
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      await chain;
      expect(code, "workspace MCP outcome suite failed").toBe(0);
    } finally { clearTimeout(timer); }
  } finally {
    // Explicit principal/key/fixture cleanup, in addition to outer container removal.
    const client = new Client({ connectionString: process.env.DATABASE_TEST_URL });
    await client.connect();
    try {
      await client.query("DELETE FROM teams WHERE id = $1", [seed.teamId]);
      for (const table of ["teams", "members", "api_keys", "items", "projects"]) {
        const column = table === "teams" ? "id" : "team_id";
        const result = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [seed.teamId]);
        expect(result.rows[0].n, `cleanup ${table}`).toBe(0);
      }
      console.log("MCP_FIXTURE_CLEANUP_OK");
    } finally { await client.end(); }
  }
}, 180000);
