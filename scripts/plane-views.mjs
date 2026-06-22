#!/usr/bin/env node
/**
 * Idempotent applier for Plane.so **saved views** (a.k.a. project Views).
 *
 * WHY THIS EXISTS — the Plane MCP server cannot create views (nor initiatives when the
 * workspace feature is off). Those operations only exist on the REST API. This script is the
 * REST fallback, mirroring scripts/plane-backlog.mjs: a declarative config + an idempotent
 * applier that ensures each view exists with the intended filters/grouping. Re-runs are safe —
 * a view is matched by name and only PATCHed when its managed fields actually drift.
 *
 * GENERIC ENGINE + CONFIG. The engine (resolve → build payload → ensure) is project-agnostic.
 * The default config is the AIOS pillar/layer/drift view set. Point PLANE_VIEWS_CONFIG at a JSON
 * file ([{name, description?, filters?, display?}]) to apply a different set to any project.
 *
 * Auth/config from env (read at runtime — never hard-coded):
 *   PLANE_API_KEY        (required)  → header X-API-Key (your own PAT; never commit it)
 *   PLANE_WORKSPACE_SLUG (default "aios-alpha")
 *   PLANE_BASE_URL       (default "https://api.plane.so")
 *   PLANE_PROJECT_ID     (optional; otherwise discovered by matching project identifier "AIOS")
 *   PLANE_VIEWS_CONFIG   (optional; path to a JSON file of view definitions — overrides the default)
 *
 * A view definition:
 *   {
 *     name: "Pillar: Team Ops",              // identity key (ensure-by-name)
 *     description: "…",
 *     filters: { labels: ["pillar:team-ops"], state: ["Todo"] },  // names, resolved to UUIDs
 *     display: { layout: "kanban", group_by: "state", order_by: "sort_order",
 *                sub_issue: true, show_empty_groups: false }
 *   }
 * `filters` keys map to Plane filter fields (labels|state|priority|assignees|module|cycle…).
 * Values are human names; the engine resolves them to UUIDs and builds the `query` mirror Plane
 * stores alongside `filters` (e.g. labels → {labels__in:[…], label_issue__deleted_at__isnull:true}).
 *
 * Run (decrypts the dotenvx-encrypted key from the workspace .env):
 *   dotenvx run -f ../aios-workspace/.env -- node scripts/plane-views.mjs
 *   # or: npm run plane:views
 *
 * Flags: --dry-run (no writes; print plan)   --verbose   --prune (delete managed views not in config)
 */

import { readFileSync } from "node:fs";

const API_KEY = process.env.PLANE_API_KEY;
const SLUG = process.env.PLANE_WORKSPACE_SLUG || "aios-alpha";
const BASE = (process.env.PLANE_BASE_URL || "https://api.plane.so").replace(/\/$/, "");
const DRY = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");
const PRUNE = process.argv.includes("--prune");

if (!API_KEY) {
  console.error("PLANE_API_KEY is not set. Run via: dotenvx run -f ../aios-workspace/.env -- node scripts/plane-views.mjs");
  process.exit(1);
}

// ── Default config: the AIOS PRD-v0.3 view set (pillars · layers · drift/gap cross-cuts) ──────
// Mirrors the label taxonomy seeded alongside the F1–F11 epics. Edit here (or supply your own via
// PLANE_VIEWS_CONFIG) — this file is the source of truth so the board's views are reproducible.
const DEFAULT_VIEWS = [
  // Pillars (PRD §10) — grouped by status.
  { name: "Pillar: Team Ops", description: "PRD Pillar 2 — the deep spine (F1,F2,F3,F5,F6,F7,F8). Grouped by status.", filters: { labels: ["pillar:team-ops"] } },
  { name: "Pillar: Company Graph", description: "PRD Pillar 1 / Sense (F4). The most defensible moat.", filters: { labels: ["pillar:company-graph"] } },
  { name: "Pillar: Learning Journeys", description: "PRD Pillar 3 / Grow (F9). Closes the flywheel.", filters: { labels: ["pillar:learning-journeys"] } },
  { name: "Pillar: Cross-cutting Moats", description: "Governance + Intelligence Engine + verification + sovereignty (F10,F11).", filters: { labels: ["pillar:cross-cutting"] } },
  // Layers (PRD §6.1) — the architectural seam each piece sits in.
  { name: "Layer: Workstation", description: "Layer 1 — workstation reporting adapters + harness bundles.", filters: { labels: ["layer:workstation"] } },
  { name: "Layer: Pipeline", description: "Layer 2 — SaaS ingestion + meeting notes + governance gate.", filters: { labels: ["layer:pipeline"] } },
  { name: "Layer: Brain", description: "Layer 3 — federated brain, signal-verify, retrieval.", filters: { labels: ["layer:brain"] } },
  { name: "Layer: Dashboard", description: "Dashboard surfaces — kanban, cost, non-technical surface.", filters: { labels: ["layer:dashboard"] } },
  { name: "Layer: Engine", description: "Intelligence Engine — context management, retrieval, condensation.", filters: { labels: ["layer:engine"] } },
  // Cross-cut / status.
  { name: "PRD MVP — H1 roadmap", description: "Everything tagged prd-mvp (F1–F11 + stories). Grouped by module.", filters: { labels: ["prd-mvp"] }, display: { group_by: "module" } },
  { name: "Gaps — unstarted moats", description: "PRD moats not yet started (F4, F9, F10, F11).", filters: { labels: ["status:gap"] } },
  { name: "Drift — not in PRD MVP", description: "Built/queued but outside PRD MVP scope.", filters: { labels: ["drift:not-in-prd"] } },
];

const DEFAULT_DISPLAY = {
  layout: "kanban",
  group_by: "state",
  order_by: "sort_order",
  sub_issue: true,            // surface epics' child stories inside the view
  show_empty_groups: false,
};

// Map a filter field → the `query` keys Plane stores. Add cases as new filter fields are used.
function queryForFilter(field, ids) {
  switch (field) {
    case "labels": return { labels__in: ids, label_issue__deleted_at__isnull: true };
    case "state": return { state__in: ids };
    case "priority": return { priority__in: ids };
    case "assignees": return { assignees__in: ids };
    case "module": return { issue_module__module__in: ids };
    case "cycle": return { issue_cycle__cycle__in: ids };
    default: return { [`${field}__in`]: ids };
  }
}

// ── HTTP + throttle (≤60 req/min → ~1.05s/request), shared shape with plane-backlog.mjs ───────
let lastReq = 0;
async function api(method, path, body) {
  const wait = Math.max(0, 1050 - (Date.now() - lastReq));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  const res = await fetch(`${BASE}/api/v1/workspaces/${SLUG}${path}`, {
    method,
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get("Retry-After") || 5) * 1000;
    console.warn(`  rate-limited; backing off ${retry}ms`);
    await new Promise((r) => setTimeout(r, retry));
    return api(method, path, body);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  if (VERBOSE) console.log(`  ${method} ${path} → ${res.status}`);
  return json;
}

async function fetchAll(path) {
  const out = [];
  let cursor = `100:0:0`;
  for (let i = 0; i < 100; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await api("GET", `${path}${sep}per_page=100&cursor=${encodeURIComponent(cursor)}`);
    if (Array.isArray(page)) { out.push(...page); break; }
    out.push(...(page.results || []));
    if (!page.next_page_results || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out;
}

function loadConfig() {
  const p = process.env.PLANE_VIEWS_CONFIG;
  if (!p) return DEFAULT_VIEWS;
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`PLANE_VIEWS_CONFIG must be a JSON array of view defs (${p})`);
  return parsed;
}

// Resolve a view def's human-named filters into {filters, query} with UUIDs.
function resolveView(def, { labelByName, stateByName }) {
  const filters = {};
  const query = {};
  const resolvers = { labels: labelByName, state: stateByName };
  for (const [field, names] of Object.entries(def.filters || {})) {
    const map = resolvers[field];
    const ids = (names || [])
      .map((n) => (map ? map.get(n) ?? map.get(n.toLowerCase()) : n))
      .filter(Boolean);
    const missing = (names || []).length - ids.length;
    if (missing > 0) console.warn(`  ⚠ ${def.name}: ${missing} unresolved ${field} value(s) — is the label/state created yet?`);
    if (!ids.length) continue;
    filters[field] = ids;
    Object.assign(query, queryForFilter(field, ids));
  }
  const display_filters = { ...DEFAULT_DISPLAY, ...(def.display || {}) };
  return { filters, query, display_filters };
}

// Only compare the fields we manage, so a human tweak elsewhere doesn't trigger churn.
function managedEqual(existing, desired, description) {
  const j = (x) => JSON.stringify(x ?? {});
  return (
    (existing.description || "") === (description || "") &&
    j(existing.filters) === j(desired.filters) &&
    j(existing.query) === j(desired.query) &&
    j(existing.display_filters) === j(desired.display_filters)
  );
}

async function main() {
  const views = loadConfig();

  // 1. resolve project
  const projects = await fetchAll(`/projects/`);
  const project = process.env.PLANE_PROJECT_ID
    ? projects.find((p) => p.id === process.env.PLANE_PROJECT_ID)
    : projects.find((p) => p.identifier === "AIOS" || /(^|\b)AIOS\b/.test(p.name));
  if (!project) throw new Error(`AIOS project not found in workspace ${SLUG}`);
  const PID = project.id;
  const proj = (p) => `/projects/${PID}${p}`;
  console.log(`Project: ${project.name} (${project.identifier}) ${PID}`);

  // 2. resolve label + state names → UUIDs
  const labelByName = new Map((await fetchAll(proj(`/labels/`))).map((l) => [l.name, l.id]));
  const stateByName = new Map((await fetchAll(proj(`/states/`))).flatMap((s) => [[s.name, s.id], [s.name.toLowerCase(), s.id]]));

  // 3. existing views by name
  const existingViews = await fetchAll(proj(`/views/`));
  const byName = new Map(existingViews.map((v) => [v.name, v]));

  console.log(`Views in config: ${views.length}${DRY ? "  (--dry-run: no writes)" : ""}\n`);
  const stats = { created: 0, updated: 0, skipped: 0, pruned: 0 };

  for (const def of views) {
    const desired = resolveView(def, { labelByName, stateByName });
    const body = { name: def.name, description: def.description || "", access: 0, ...desired };
    const existing = byName.get(def.name);
    if (existing) {
      if (managedEqual(existing, desired, body.description)) {
        stats.skipped++;
        if (VERBOSE) console.log(`skip   ${def.name}`);
        continue;
      }
      if (DRY) { console.log(`update ${def.name} (drift)`); stats.updated++; continue; }
      await api("PATCH", proj(`/views/${existing.id}/`), body);
      console.log(`update ${def.name}`);
      stats.updated++;
    } else {
      if (DRY) { console.log(`create ${def.name}`); stats.created++; continue; }
      await api("POST", proj(`/views/`), body);
      console.log(`create ${def.name}`);
      stats.created++;
    }
  }

  // 4. optional prune: delete views whose names start with a managed prefix but are no longer in config.
  // Conservative: only touches "Pillar: ", "Layer: " and the named cross-cuts this script owns.
  if (PRUNE) {
    const managedNames = new Set(views.map((v) => v.name));
    const ownedPrefixes = ["Pillar: ", "Layer: "];
    const ownedExtras = new Set(["PRD MVP — H1 roadmap", "Gaps — unstarted moats", "Drift — not in PRD MVP"]);
    for (const v of existingViews) {
      const owned = ownedPrefixes.some((p) => v.name.startsWith(p)) || ownedExtras.has(v.name);
      if (owned && !managedNames.has(v.name)) {
        if (DRY) { console.log(`prune  ${v.name}`); stats.pruned++; continue; }
        await api("DELETE", proj(`/views/${v.id}/`));
        console.log(`prune  ${v.name}`);
        stats.pruned++;
      }
    }
  }

  console.log(`\nDone. created=${stats.created} updated=${stats.updated} skipped=${stats.skipped} pruned=${stats.pruned} (config ${views.length}).`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
