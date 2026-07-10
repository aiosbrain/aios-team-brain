import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { BASE_URL, db, seedMemberEmail, seedTeam, type Seed } from "./http-helpers";

// Spec (brain-api v1.2 Phase 4): the tasks dashboard server-renders the hierarchy — epics with their
// children grouped beneath them — and shows each task's primary-provider link + sync status. This is
// the only tier that proves the real Next server component renders over the wire (HTTP 200 + HTML).

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]; // aios_session=<jwt>
  if (!cookie.startsWith("aios_session=")) throw new Error(`no session cookie: ${setCookie}`);
  return cookie;
}

async function seedProject(teamId: string): Promise<string> {
  const { data } = await db()
    .from("projects")
    .insert({ team_id: teamId, slug: `p-${randomUUID().slice(0, 6)}`, name: "Proj" })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function seedTask(teamId: string, projectId: string, rowKey: string, over: Record<string, unknown> = {}): Promise<string> {
  const { data } = await db()
    .from("tasks")
    .insert({ team_id: teamId, project_id: projectId, row_key: rowKey, title: rowKey, status: "backlog", origin: "ui", ...over })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function seedLink(seed: Seed, projectId: string, taskId: string, rowKey: string, over: Record<string, unknown>) {
  const { error } = await db().from("task_pm_links").insert({
    team_id: seed.teamId,
    project_id: projectId,
    task_id: taskId,
    row_key: rowKey,
    provider: "linear",
    provider_external_id: rowKey,
    provider_external_source: "aios-backlog",
    provider_url: "",
    ...over,
  });
  if (error) throw new Error(`seed link failed: ${error.message}`);
}

describe("GET /t/{team}/tasks (HTTP) — hierarchical render", () => {
  it("server-renders epics with their children grouped and shows pm-link + sync status (200)", async () => {
    const seed = await seedTeam();
    const { email, password } = await seedMemberEmail(seed); // a known-email, team-tier member on this team
    const cookie = await login(email, password);

    const project = await seedProject(seed.teamId);
    const epicId = await seedTask(seed.teamId, project, "EPIC-1", { title: "Wave 1 Foundations" });
    const childId = await seedTask(seed.teamId, project, "SUB-1", { title: "Build the projector", parent_row_key: "EPIC-1", priority: "high", labels: ["integration"] });
    await seedLink(seed, project, epicId, "EPIC-1", { provider_resource_id: "li-epic", provider_url: "https://linear.app/issue/EPIC", last_synced_status: "backlog" });
    await seedLink(seed, project, childId, "SUB-1", { provider_resource_id: "li-sub", provider_url: "https://linear.app/issue/SUB", last_synced_status: "backlog" });

    const res = await fetch(`${BASE_URL}/t/${seed.teamSlug}/tasks`, { headers: { cookie }, cache: "no-store" });
    expect(res.status).toBe(200);
    const html = await res.text();

    // Both titles render.
    expect(html).toContain("Wave 1 Foundations");
    expect(html).toContain("Build the projector");
    // The child is grouped under its epic (a server-rendered grouping marker, not a flat list).
    expect(html).toContain('data-parent="EPIC-1"');
    expect(html).toContain('data-epic="EPIC-1"');
    // Each task shows its primary-provider link + sync status.
    expect(html).toContain("https://linear.app/issue/EPIC");
    expect(html).toContain("https://linear.app/issue/SUB");
    expect(html).toMatch(/linear/i);
  });

  it("redirects an unauthenticated request to the sign-in page (no task leak)", async () => {
    const seed = await seedTeam();
    const project = await seedProject(seed.teamId);
    await seedTask(seed.teamId, project, "SECRET-1", { title: "Confidential epic" });

    // No cookie → the /t/* proxy gate redirects to /login (fetch follows it). The protected
    // content must never appear in the response.
    const res = await fetch(`${BASE_URL}/t/${seed.teamSlug}/tasks`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");

    const followed = await fetch(`${BASE_URL}/t/${seed.teamSlug}/tasks`);
    const html = await followed.text();
    expect(html).not.toContain("Confidential epic");
  });
});
