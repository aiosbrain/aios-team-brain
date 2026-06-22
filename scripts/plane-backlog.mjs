#!/usr/bin/env node
/**
 * Idempotent seed of the AIOS remaining-work backlog into Plane.so.
 *
 * Creates one EPIC (parent work item) per feature and a SUB-ISSUE (child work item) per chunk,
 * grouped into "Wave 1 — MVP" / "Wave 2 — Later" Modules, under the AIOS project. Every item
 * carries a stable `external_id` (+ external_source="aios-backlog"); re-runs skip anything that
 * already exists, so this is safe to run repeatedly as the plan evolves.
 *
 * Auth/config from env (read at runtime — never hard-coded):
 *   PLANE_API_KEY        (required)  → header X-API-Key
 *   PLANE_WORKSPACE_SLUG (default "aios-alpha")
 *   PLANE_BASE_URL       (default "https://api.plane.so")
 *   PLANE_PROJECT_ID     (optional; otherwise discovered by matching project identifier "AIOS")
 *   PLANE_ASSIGNEE_ID    (optional; preferred default assignee for created/seeded items)
 *   PLANE_ASSIGNEE_EMAIL (optional; resolve default assignee by project-member email)
 *   PLANE_ASSIGNEE_NAME  (optional; resolve default assignee by display/full name)
 *
 * If no assignee env is set, the script assigns the API-key owner (`/api/v1/users/me/`) when that
 * user belongs to the project. If that cannot be resolved, it falls back to the sole non-bot
 * project member. If there are still multiple humans, set one of the PLANE_ASSIGNEE_* vars.
 *
 * Run (decrypts the dotenvx-encrypted key from the workspace .env):
 *   dotenvx run -f /Users/iamjohndass/Projects/aios/aios-workspace/.env -- node scripts/plane-backlog.mjs
 *   # or: npm run plane:backlog   (wrapper does the same)
 *
 * Flags: --dry-run (no writes; print plan)   --verbose
 */

// Backlog is the single source of truth shared with scripts/linear-backlog.mjs.
import { BACKLOG, WAVE1, WAVE2, LABELS } from "./aios-backlog.mjs";

const API_KEY = process.env.PLANE_API_KEY;
const SLUG = process.env.PLANE_WORKSPACE_SLUG || "aios-alpha";
const BASE = (process.env.PLANE_BASE_URL || "https://api.plane.so").replace(/\/$/, "");
const EXTERNAL_SOURCE = "aios-backlog";
const DRY = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");
const RESTATE = process.argv.includes("--restate"); // move all backlog items into the target state
const ASSIGNEE_ID = process.env.PLANE_ASSIGNEE_ID || "";
const ASSIGNEE_EMAIL = (process.env.PLANE_ASSIGNEE_EMAIL || "").toLowerCase();
const ASSIGNEE_NAME = (process.env.PLANE_ASSIGNEE_NAME || "").toLowerCase();

if (!API_KEY) {
  console.error("PLANE_API_KEY is not set. Run via: dotenvx run -f <workspace>/.env -- node scripts/plane-backlog.mjs");
  process.exit(1);
}

// ── HTTP + throttle (≤60 req/min → ~1.05s/request) ────────────────────────────
let lastReq = 0;
async function api(method, path, body) {
  const now = Date.now();
  const wait = Math.max(0, 1050 - (now - lastReq));
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

async function baseApi(method, path, body) {
  const now = Date.now();
  const wait = Math.max(0, 1050 - (now - lastReq));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  if (VERBOSE) console.log(`  ${method} ${path} → ${res.status}`);
  return json;
}

async function fetchAll(path) {
  // cursor pagination: ?cursor=value&per_page=100
  const out = [];
  let cursor = `100:0:0`;
  for (let i = 0; i < 100; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await api("GET", `${path}${sep}per_page=100&cursor=${encodeURIComponent(cursor)}`);
    if (Array.isArray(page)) {
      out.push(...page);
      break;
    }
    out.push(...(page.results || []));
    if (!page.next_page_results || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out;
}

function memberName(member) {
  return [member.first_name, member.last_name].filter(Boolean).join(" ").trim();
}

function isBotMember(member) {
  return member.email?.startsWith("bot_user_") || member.display_name?.toLowerCase() === "plane";
}

async function resolveDefaultAssignee(proj) {
  const projectMembers = await fetchAll(proj(`/members/`));
  const matchers = [];
  if (ASSIGNEE_ID) matchers.push((m) => m.id === ASSIGNEE_ID);
  if (ASSIGNEE_EMAIL) matchers.push((m) => m.email?.toLowerCase() === ASSIGNEE_EMAIL);
  if (ASSIGNEE_NAME) {
    matchers.push((m) => {
      const names = [m.display_name, memberName(m), m.first_name, m.email].filter(Boolean);
      return names.some((name) => name.toLowerCase() === ASSIGNEE_NAME);
    });
  }

  for (const matches of matchers) {
    const member = projectMembers.find(matches);
    if (member) return member;
  }

  if (ASSIGNEE_ID || ASSIGNEE_EMAIL || ASSIGNEE_NAME) {
    throw new Error("Configured Plane assignee is not a member of the AIOS project");
  }

  try {
    const currentUser = await baseApi("GET", "/api/v1/users/me/");
    const projectMember = projectMembers.find((m) => m.id === currentUser.id);
    if (projectMember) return projectMember;
    console.warn(`Plane API user ${currentUser.email || currentUser.id} is not a member of the AIOS project.`);
  } catch (err) {
    console.warn(`Could not resolve Plane API user: ${err.message}`);
  }

  const humans = projectMembers.filter((m) => !isBotMember(m));
  if (humans.length === 1) return humans[0];

  console.warn("No default assignee set; set PLANE_ASSIGNEE_ID, PLANE_ASSIGNEE_EMAIL, or PLANE_ASSIGNEE_NAME.");
  return null;
}

async function main() {
  // 1. resolve project
  const projects = await fetchAll(`/projects/`);
  const project = process.env.PLANE_PROJECT_ID
    ? projects.find((p) => p.id === process.env.PLANE_PROJECT_ID)
    : projects.find((p) => p.identifier === "AIOS" || /(^|\b)AIOS\b/.test(p.name));
  if (!project) throw new Error(`AIOS project not found in workspace ${SLUG}`);
  const PID = project.id;
  const proj = (p) => `/projects/${PID}${p}`;
  console.log(`Project: ${project.name} (${project.identifier}) ${PID}`);
  const defaultAssignee = await resolveDefaultAssignee(proj);
  const assigneeIds = defaultAssignee ? [defaultAssignee.id] : [];
  if (defaultAssignee) {
    console.log(`Assignee: ${memberName(defaultAssignee) || defaultAssignee.display_name || defaultAssignee.email} (${defaultAssignee.id})`);
  }

  // Target state — items land in "To Do" (unstarted), not the default "Backlog".
  const states = await fetchAll(proj(`/states/`));
  const want = (process.env.PLANE_STATE || "Todo").toLowerCase().replace(/\s+/g, "");
  const todoState =
    states.find((s) => s.name.toLowerCase().replace(/\s+/g, "") === want) ||
    states.find((s) => s.group === "unstarted");
  const stateId = todoState?.id || null;
  if (stateId) console.log(`Target state: ${todoState.name} (${stateId})`);

  const totalItems = BACKLOG.length + BACKLOG.reduce((n, e) => n + e.subs.length, 0);
  console.log(`Backlog: ${BACKLOG.length} epics + ${totalItems - BACKLOG.length} sub-issues = ${totalItems} work items\n`);
  if (DRY) {
    for (const e of BACKLOG) {
      console.log(`◆ ${e.ext}  ${e.name}  [${e.wave}] (${e.priority})`);
      for (const s of e.subs) console.log(`   └─ ${s.ext}  ${s.name}`);
    }
    console.log("\n--dry-run: no writes performed.");
    return;
  }

  // 2. ensure labels
  const existingLabels = await fetchAll(proj(`/labels/`));
  const labelId = new Map(existingLabels.map((l) => [l.name, l.id]));
  for (const name of LABELS) {
    if (labelId.has(name)) continue;
    const created = await api("POST", proj(`/labels/`), { name });
    labelId.set(name, created.id);
    console.log(`label + ${name}`);
  }

  // 3. ensure modules (waves)
  const existingModules = await fetchAll(proj(`/modules/`));
  const moduleId = new Map(existingModules.map((m) => [m.name, m.id]));
  for (const name of [WAVE1, WAVE2]) {
    if (moduleId.has(name)) continue;
    const created = await api("POST", proj(`/modules/`), { name });
    moduleId.set(name, created.id);
    console.log(`module + ${name}`);
  }

  // 4. existing work items by external_id (idempotency)
  const existingItems = await fetchAll(proj(`/work-items/`));
  const byExt = new Map();
  for (const it of existingItems) {
    if (it.external_source === EXTERNAL_SOURCE && it.external_id) byExt.set(it.external_id, it);
  }

  const stats = { created: 0, skipped: 0, assigned: 0 };
  const moduleMembers = new Map([[WAVE1, []], [WAVE2, []]]);

  async function ensureItem({ ext, name, desc, priority, labels, parent }) {
    const existing = byExt.get(ext);
    if (existing) {
      stats.skipped++;
      if (VERBOSE) console.log(`skip   ${ext} (exists)`);
      const nextAssignees = new Set(existing.assignees || []);
      for (const id of assigneeIds) nextAssignees.add(id);
      if (nextAssignees.size !== (existing.assignees || []).length) {
        await api("PATCH", proj(`/work-items/${existing.id}/`), { assignees: [...nextAssignees] });
        stats.assigned++;
        console.log(`assign ${ext}  ${name}`);
      }
      return existing.id;
    }
    const body = {
      name,
      description_html: desc || "",
      external_id: ext,
      external_source: EXTERNAL_SOURCE,
    };
    if (priority) body.priority = priority;
    if (stateId) body.state = stateId; // new items start in "To Do", not Backlog
    if (labels?.length) body.labels = labels.map((n) => labelId.get(n)).filter(Boolean);
    if (assigneeIds.length) body.assignees = assigneeIds;
    if (parent) body.parent = parent;
    const created = await api("POST", proj(`/work-items/`), body);
    byExt.set(ext, created);
    stats.created++;
    console.log(`create ${ext}  ${name}`);
    return created.id;
  }

  // 5. epics then sub-issues
  for (const epic of BACKLOG) {
    const epicId = await ensureItem({ ext: epic.ext, name: epic.name, desc: epic.desc, priority: epic.priority, labels: epic.labels });
    moduleMembers.get(epic.wave).push(epicId);
    for (const sub of epic.subs) {
      const subId = await ensureItem({ ext: sub.ext, name: sub.name, desc: sub.desc, priority: epic.priority, labels: epic.labels, parent: epicId });
      moduleMembers.get(epic.wave).push(subId);
    }
  }

  // 6. assign items to their wave module (batch; only add missing)
  for (const [wave, ids] of moduleMembers) {
    if (!ids.length) continue;
    const mid = moduleId.get(wave);
    const present = new Set((await fetchAll(proj(`/modules/${mid}/module-issues/`))).map((mi) => mi.issue || mi.id));
    const missing = ids.filter((id) => !present.has(id));
    if (missing.length) {
      await api("POST", proj(`/modules/${mid}/module-issues/`), { issues: missing });
      console.log(`module ${wave} += ${missing.length} items`);
    }
  }

  // 7. optional: move all backlog items into the target state (one-off migration / fix).
  // Only runs with --restate so a normal re-run never fights a board change a human made.
  if (RESTATE && stateId) {
    const all = await fetchAll(proj(`/work-items/`));
    const targets = all.filter((x) => x.external_source === EXTERNAL_SOURCE && x.state !== stateId);
    for (const it of targets) {
      await api("PATCH", proj(`/work-items/${it.id}/`), { state: stateId });
      console.log(`restate ${it.external_id || it.id} → ${todoState.name}`);
    }
    console.log(`restated ${targets.length} item(s) → ${todoState?.name}.`);
  }

  console.log(`\nDone. created=${stats.created} skipped=${stats.skipped} assigned=${stats.assigned} (total ${totalItems}).`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
