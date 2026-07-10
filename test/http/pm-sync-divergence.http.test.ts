import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminSetPassword } from "@/lib/auth/pg-login";
import { BASE_URL, db, seedTeam, type Seed } from "./http-helpers";

// Spec (brain-api v1.2 Phase 5): the admin PM-sync page server-renders the inbound-divergence list —
// tasks whose state in the PM tool has drifted from the brain's last_projected_status. Proven over a
// real socket (HTTP 200) with an admin session. Divergence is read from stored provider_seen_status
// (a prior reconcile pass populated it) — no live PM call on render.

async function seedAdmin(seed: Seed): Promise<{ email: string; password: string }> {
  const email = `admin-${randomUUID().slice(0, 8)}@test.local`;
  const password = `test-password-${randomUUID().slice(0, 12)}`;
  const { error } = await db().from("members").insert({
    team_id: seed.teamId,
    email,
    display_name: "Admin",
    actor_handle: `admin-${randomUUID().slice(0, 8)}`,
    role: "admin",
    tier: "team",
    status: "active",
  });
  if (error) throw new Error(`admin seed failed: ${error.message}`);
  await adminSetPassword(email, password);
  return { email, password };
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie.startsWith("aios_session=")) throw new Error("no session cookie");
  return cookie;
}

async function seedDivergedLink(seed: Seed) {
  const { data: project } = await db().from("projects").insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 6)}`, name: "Proj" }).select("id").single();
  const projectId = (project as { id: string }).id;
  const { data: task } = await db()
    .from("tasks")
    .insert({ team_id: seed.teamId, project_id: projectId, row_key: "DIV-1", title: "Diverged task", status: "backlog", origin: "ui" })
    .select("id")
    .single();
  await db().from("task_pm_links").insert({
    team_id: seed.teamId,
    project_id: projectId,
    task_id: (task as { id: string }).id,
    row_key: "DIV-1",
    provider: "linear",
    provider_external_id: "DIV-1",
    provider_external_source: "aios-backlog",
    provider_resource_id: "li-div",
    provider_url: "https://linear.app/issue/DIV",
    last_projected_status: "Backlog", // brain projected Backlog…
    provider_seen_status: "Done", // …but the reconcile pass saw Done → divergence
  });
}

describe("GET /t/{team}/admin/pm-sync (HTTP) — inbound divergence list", () => {
  it("server-renders the divergence row (brain vs tool) for an admin (200)", async () => {
    const seed = await seedTeam();
    const { email, password } = await seedAdmin(seed);
    const cookie = await login(email, password);
    await seedDivergedLink(seed);

    const res = await fetch(`${BASE_URL}/t/${seed.teamSlug}/admin/pm-sync`, { headers: { cookie }, cache: "no-store" });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("Inbound divergence");
    expect(html).toContain('data-divergence="DIV-1"');
    // Both sides of the drift are rendered: what the brain projected vs what the tool now shows.
    expect(html).toContain("Backlog");
    expect(html).toContain("Done");
    expect(html).toContain("Check for divergence");
  });

  it("shows the empty state when nothing has diverged", async () => {
    const seed = await seedTeam();
    const { email, password } = await seedAdmin(seed);
    const cookie = await login(email, password);

    const res = await fetch(`${BASE_URL}/t/${seed.teamSlug}/admin/pm-sync`, { headers: { cookie }, cache: "no-store" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No divergence detected");
  });
});
