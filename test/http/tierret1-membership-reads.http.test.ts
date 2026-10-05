import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueApiKey } from "@/lib/admin/keys";
import { createMember } from "@/lib/admin/members";
import { createGroup, addMemberToGroup, grantProjectToGroup } from "@/lib/access/groups";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { ingest } from "../datamechanics/helpers";
import { BASE_URL, convergeTeam, db, keyHeaders, seedTeam, type Seed } from "./http-helpers";

/**
 * TIERRET-1 (AC-01/AC-02/AC-03/AC-05/AC-08) over a REAL socket (`next start` + the shared test
 * Postgres): the wire contract of the membership-only member read rule. A granted external-posture
 * human's ordinary key receives the granted project's team-labelled items (list AND by id), its
 * sourced + granted hand-entered tasks and decisions, and its OKF nodes with invisible link targets
 * redacted; ungranted content stays indistinguishable from absent and unknown keys are reported as
 * unknown. A legacy connector key (with a planted Everyone row) and an offroster key gain NO sourced
 * content and no OKF nodes while keeping their baseline hand-entered arm. Invalid, cross-team and
 * inactive credentials are refused.
 *
 * NOT covered here, deliberately: `/api/v1/query`'s positive answer path. It streams a MODEL answer,
 * and this tier makes no model calls. Its deterministic inputs (structured digest, grounding corpus,
 * legacy org-structure legs, graph scope = oracle set / none for legacy) are proven in the dm tier
 * (`tierret1-member-reads`, `tierret1-admission`) and its wiring by the guards
 * (`enforce-retrieve-callsites`, `graph-cutover-callsites`, `provenance-principal-callsites`). Only
 * its pre-model credential refusal is exercised over the wire below.
 */

interface Fx {
  seed: Seed;
  itemId: string;
  hiddenId: string;
  externalId: string;
  externalKey: string;
  connectorKey: string;
  offrosterKey: string;
}

async function rawMember(seed: Seed, over: Partial<{ kind: string; tier: string; is_connector: boolean }>): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "Legacy",
      actor_handle: `l-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: over.tier ?? "team",
      status: "active",
      is_connector: over.is_connector ?? false,
      kind: over.kind ?? "human",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`member seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

async function mkInitiative(seed: Seed, slug: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, kind: "initiative" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`project seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

/** Fixture-only custom placement (the spec's AC-01 shape: no product curation endpoint exists). */
async function place(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", (unit as { id: string }).id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: (unit as { id: string }).id, method: "manual" });
  if (error) throw new Error(`placement failed: ${error.message}`);
}

/** One row per statement: the pg adapter takes a multi-row insert's columns from the FIRST row, so
 *  rows with differing shapes (sourced vs hand-entered) must not share an insert. */
async function insertRows(table: "tasks" | "decisions", rows: Record<string, unknown>[]): Promise<void> {
  for (const row of rows) {
    const { error } = await db().from(table).insert(row);
    if (error) throw new Error(`${table} seed failed: ${error.message}`);
  }
}

async function fixture(): Promise<Fx> {
  const seed = await seedTeam();
  await convergeTeam(seed);
  const item = await ingest(seed, {
    path: "granted.md",
    body: "granted wire body — see [two](granted-2.md), [secret](hidden.md) and [gone](missing.md)",
    access: "team",
    project: "src",
  });
  const item2 = await ingest(seed, { path: "granted-2.md", body: "second granted wire body", access: "team", project: "src" });
  const hidden = await ingest(seed, { path: "hidden.md", body: "hidden wire body", access: "team", project: "src" });
  await convergeTeam(seed);
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  const X = await mkInitiative(seed, "x");
  const Y = await mkInitiative(seed, "y");
  await place(seed, item.id, X);
  await place(seed, item2.id, X);
  await place(seed, hidden.id, Y);
  const src = item.projectId!;

  // Sourced rows live in the ingest container (src), like real materialization; hand-entered rows
  // carry created_by proof — one in the granted project X, one in the ungranted container.
  await insertRows("tasks", [
    { team_id: seed.teamId, project_id: src, row_key: "WX-1", title: "wire sourced task", assignee: "T", status: "in_progress", audience: "team", origin: "sync", source_item_id: item.id },
    { team_id: seed.teamId, project_id: src, row_key: "WY-1", title: "wire hidden task", assignee: "T", status: "in_progress", audience: "team", origin: "sync", source_item_id: hidden.id },
    { team_id: seed.teamId, project_id: X, row_key: "WH-1", title: "wire hand task", assignee: "T", status: "ready", audience: "team", origin: "ui", source_item_id: null, created_by: seed.memberId },
    { team_id: seed.teamId, project_id: src, row_key: "WS-1", title: "wire src hand task", assignee: "T", status: "ready", audience: "team", origin: "ui", source_item_id: null, created_by: seed.memberId },
  ]);
  const today = new Date().toISOString().slice(0, 10);
  // The decisions writeback feed serves a SOURCED row only when it changed after its item synced
  // (lib/sync/decisions.ts) — so the sourced rows are dated deterministically past the ingest.
  const afterSync = new Date(Date.now() + 60_000).toISOString();
  await insertRows("decisions", [
    { team_id: seed.teamId, project_id: src, row_key: "DX-1", title: "wire decision", decided_by: "t", decided_at: today, still_valid: true, audience: "team", source_item_id: item.id, updated_at: afterSync },
    { team_id: seed.teamId, project_id: src, row_key: "DY-1", title: "wire hidden decision", decided_by: "t", decided_at: today, still_valid: true, audience: "team", source_item_id: hidden.id, updated_at: afterSync },
    { team_id: seed.teamId, project_id: X, row_key: "DH-1", title: "wire hand decision", decided_by: "t", decided_at: today, still_valid: true, audience: "team", source_item_id: null, created_by: seed.memberId },
  ]);

  // The external collaborator: production creation path (builtin External only) + a deliberate grant.
  const ext = await createMember(db(), seed.teamId, { email: `${randomUUID()}@test.local`, displayName: "Ext", actorHandle: `e-${randomUUID().slice(0, 8)}`, role: "member", tier: "external" });
  await db().from("members").update({ status: "active" }).eq("id", ext.id);
  const g = await createGroup(db(), seed.teamId, `wx-${randomUUID().slice(0, 6)}`, "WX", seed.memberId);
  expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, ext.id, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, X, g.groupId!, seed.memberId)).ok).toBe(true);
  // Y is a real, granted, restricted project — just not to this collaborator.
  const gy = await createGroup(db(), seed.teamId, `wy-${randomUUID().slice(0, 6)}`, "WY", seed.memberId);
  expect((await grantProjectToGroup(db(), seed.teamId, Y, gy.groupId!, seed.memberId)).ok).toBe(true);

  const connector = await rawMember(seed, { is_connector: true });
  const { data: everyone } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").eq("is_builtin", true).single();
  await db().from("group_members").insert({ team_id: seed.teamId, group_id: (everyone as { id: string }).id, member_id: connector });
  const offroster = await rawMember(seed, { kind: "offroster", tier: "external" });

  return {
    seed,
    itemId: item.id,
    hiddenId: hidden.id,
    externalId: ext.id,
    externalKey: (await issueApiKey(db(), seed.teamId, ext.id, "ext")).key,
    connectorKey: (await issueApiKey(db(), seed.teamId, connector, "connector")).key,
    offrosterKey: (await issueApiKey(db(), seed.teamId, offroster, "offroster")).key,
  };
}

// Every request in this file is confined to the loopback test server (server-url.ts stays the
// authority for the address both server and client use). The URL is resolved and checked BEFORE
// fetch: only a relative /api/v1/ path, never an absolute, protocol-relative or backslash form.
const SERVER = new URL(BASE_URL);
if (SERVER.protocol !== "http:" || SERVER.hostname !== "127.0.0.1" || !/^\d+$/.test(SERVER.port)) {
  throw new Error(`HTTP tier base is not a numeric loopback origin: ${BASE_URL}`);
}
function serverUrl(path: string): URL {
  if (!/^\/api\/v1\/[^\\]*$/.test(path)) throw new Error(`test request path outside /api/v1/: ${path}`);
  const url = new URL(path, SERVER);
  if (url.origin !== SERVER.origin || url.protocol !== SERVER.protocol || url.hostname !== SERVER.hostname) {
    throw new Error(`test request escaped the loopback server: ${path}`);
  }
  return url;
}
const request = (path: string, init?: RequestInit) => fetch(serverUrl(path), init);
const get = (F: Fx, path: string, key: string, teamSlug = F.seed.teamSlug) =>
  request(path, { headers: keyHeaders(key, teamSlug) });

async function taskKeys(F: Fx, key: string): Promise<string[]> {
  const res = await get(F, "/api/v1/tasks?mode=table", key);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tasks: { rows: { row_key: string }[] }[] };
  return body.tasks.flatMap((p) => p.rows.map((r) => r.row_key)).sort();
}

async function decisionKeys(F: Fx, key: string): Promise<string[]> {
  const res = await get(F, `/api/v1/decisions?since=${encodeURIComponent("1970-01-01T00:00:00Z")}`, key);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { decisions: { rows: { row_key: string }[] }[] };
  return body.decisions.flatMap((p) => p.rows.map((r) => r.row_key)).sort();
}

async function itemPaths(F: Fx, key: string): Promise<string[]> {
  const res = await get(F, "/api/v1/items", key);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: { path: string }[] }).items.map((i) => i.path).sort();
}

async function okfNodes(F: Fx, key: string, query = ""): Promise<{ path: string; links: string[] }[]> {
  const res = await get(F, `/api/v1/okf-bundle${query}`, key);
  expect(res.status).toBe(200);
  return ((await res.json()) as { bundle: { nodes: { path: string; links: string[] }[] } }).bundle.nodes;
}

describe("TIERRET-1 over HTTP — the membership-only member read rule", () => {
  it("a granted external-posture key reads the granted team item by id, its sourced + granted hand-entered tasks, and its OKF node", async () => {
    const F = await fixture();
    const byId = await get(F, `/api/v1/items/${F.itemId}`, F.externalKey);
    expect(byId.status).toBe(200);
    expect(((await byId.json()) as { access: string }).access, "a TEAM-labelled item, served to an external-posture member").toBe("team");
    expect(await taskKeys(F, F.externalKey)).toEqual(["WH-1", "WX-1"]);
    const nodes = (await okfNodes(F, F.externalKey)).map((n) => n.path);
    expect(nodes).toContain("granted.md");
    const narrowed = (await okfNodes(F, F.externalKey, "?tier=external")).map((n) => n.path);
    expect(narrowed, "explicit external export still narrows").not.toContain("granted.md");
  });

  it("item list and by-id agree for granted content; ungranted and nonexistent ids are indistinguishable 404s (AC-02/AC-05)", async () => {
    const F = await fixture();
    expect(await itemPaths(F, F.externalKey), "list = exactly the granted items").toEqual(["granted-2.md", "granted.md"]);
    const hidden = await get(F, `/api/v1/items/${F.hiddenId}`, F.externalKey);
    const absent = await get(F, `/api/v1/items/${randomUUID()}`, F.externalKey);
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    // Every error carries its own per-request trace id (`errorResponse` mints a fresh UUID), so the
    // bodies are compared field by field: same shape, code and message; distinct, valid trace ids.
    type ErrBody = { error: { code: string; message: string; request_id: string } };
    const h = (await hidden.json()) as ErrBody;
    const a = (await absent.json()) as ErrBody;
    expect(Object.keys(h).sort(), "no extra top-level fields on the hidden 404").toEqual(Object.keys(a).sort());
    expect(Object.keys(h.error).sort(), "no extra error fields on the hidden 404").toEqual(Object.keys(a.error).sort());
    expect(h.error.code, "an ungranted item reads exactly like a missing one").toBe(a.error.code);
    expect(h.error.message, "an ungranted item reads exactly like a missing one").toBe(a.error.message);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(h.error.request_id).toMatch(UUID);
    expect(a.error.request_id).toMatch(UUID);
    expect(h.error.request_id, "each response has its own trace id").not.toBe(a.error.request_id);
  });

  it("the decisions feed serves the granted sourced + granted hand-entered decisions only (AC-01/AC-04)", async () => {
    const F = await fixture();
    expect(await decisionKeys(F, F.externalKey)).toEqual(["DH-1", "DX-1"]);
  });

  it("by-key task lookup: a granted team-audience key is known; ungranted and nonexistent keys are unknown (AC-05)", async () => {
    const F = await fixture();
    const res = await get(F, "/api/v1/tasks?mode=table&keys=WX-1,WY-1,WS-1,NOPE-1", F.externalKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { rows: { row_key: string }[] }[]; unknown_keys: string[] | null };
    expect(body.tasks.flatMap((p) => p.rows.map((r) => r.row_key))).toEqual(["WX-1"]);
    expect(body.unknown_keys?.slice().sort(), "unknown_keys describes the SERVED set").toEqual(["NOPE-1", "WS-1", "WY-1"]);
  });

  it("OKF default export keeps granted link targets, redacts the invisible present target, keeps dangling semantics (AC-08)", async () => {
    const F = await fixture();
    const nodes = await okfNodes(F, F.externalKey);
    const paths = nodes.map((n) => n.path);
    expect(paths).toEqual(expect.arrayContaining(["granted-2.md", "granted.md"]));
    expect(paths, "the ungranted node itself is absent").not.toContain("hidden.md");
    const granted = nodes.find((n) => n.path === "granted.md")!;
    expect(granted.links, "a granted present target is preserved").toContain("granted-2.md");
    expect(granted.links, "an invisible present target is redacted").not.toContain("hidden.md");
    expect(granted.links, "a dangling target keeps existing semantics").toContain("missing.md");
  });

  it("legacy connector (with an Everyone row) and offroster keys gain no sourced content and no OKF nodes", async () => {
    const F = await fixture();
    for (const key of [F.connectorKey, F.offrosterKey]) {
      const byId = await get(F, `/api/v1/items/${F.itemId}`, key);
      expect(byId.status).toBe(404);
      expect(await itemPaths(F, key), "no items for a non-principal").toEqual([]);
      const tasks = await taskKeys(F, key);
      expect(tasks, "no sourced task").not.toContain("WX-1");
      expect(tasks).not.toContain("WY-1");
      const decisions = await decisionKeys(F, key);
      expect(decisions, "no sourced decision").not.toContain("DX-1");
      expect(decisions).not.toContain("DY-1");
      expect(await okfNodes(F, key)).toEqual([]);
    }
    // Baseline PRESERVED, not revoked (AC-03 forbids gain, not existing access): the connector's
    // Everyone row still opens the legacy hand-entered arm it had before this change — in BOTH
    // containers, as before (the legacy arm is the old posture rule, not the new grant rule).
    expect(await taskKeys(F, F.connectorKey)).toEqual(["WH-1", "WS-1"]);
    expect(await decisionKeys(F, F.connectorKey)).toEqual(["DH-1"]);
    expect(await taskKeys(F, F.offrosterKey), "an external-posture legacy key had and keeps nothing").toEqual([]);
    expect(await decisionKeys(F, F.offrosterKey)).toEqual([]);
  });

  it("invalid, cross-team and inactive credentials are refused on every read surface (AC-02/AC-08)", async () => {
    const F = await fixture();
    const other = await seedTeam();
    const surfaces = [
      "/api/v1/items",
      `/api/v1/items/${F.itemId}`,
      "/api/v1/tasks?mode=table",
      "/api/v1/decisions",
      "/api/v1/okf-bundle",
      "/api/v1/timeline",
    ];
    for (const path of surfaces) {
      expect((await get(F, path, "aios_not_a_real_key")).status, `${path}: invalid key`).toBe(401);
      expect((await request(path)).status, `${path}: no credentials`).toBe(401);
      expect((await get(F, path, F.externalKey, other.teamSlug)).status, `${path}: a valid key presented for another team`).toBe(401);
    }
    // The query route refuses BEFORE any retrieval or model work — no answer is ever requested here.
    const q = await request("/api/v1/query", { method: "POST", headers: keyHeaders("aios_not_a_real_key", F.seed.teamSlug), body: JSON.stringify({ question: "anything" }) });
    expect(q.status).toBe(401);

    // A key whose member is no longer active reads nothing — it is refused, never demoted to a
    // legacy reader (TIERRET-1 correction: inactive rows enter neither admission arm).
    expect((await get(F, `/api/v1/items/${F.itemId}`, F.externalKey)).status, "precondition: the key works while active").toBe(200);
    await db().from("members").update({ status: "disabled" }).eq("id", F.externalId);
    for (const path of surfaces) {
      expect((await get(F, path, F.externalKey)).status, `${path}: inactive member's key`).toBe(401);
    }
  });

  it("the request helper refuses any path that could leave the loopback server, before fetching", () => {
    for (const path of ["//evil.example/api/v1/items", "http://evil.example/api/v1/items", "/\\evil.example/api/v1/items", "/api/v1/\\..\\x", "api/v1/items", "/api/v2/items"]) {
      expect(() => serverUrl(path), path).toThrow();
    }
    expect(serverUrl("/api/v1/items").origin).toBe(SERVER.origin);
  });
});
