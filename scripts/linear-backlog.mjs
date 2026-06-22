#!/usr/bin/env node
/**
 * Idempotent mirror of the AIOS remaining-work backlog into Linear.
 *
 * Linear-native mapping (decided with John): each Wave becomes a team CUSTOM VIEW (filtered by
 * the wave label), each epic becomes a parent ISSUE, and each chunk becomes a SUB-ISSUE.
 * The backlog data is shared verbatim with scripts/plane-backlog.mjs via scripts/aios-backlog.mjs,
 * so the Plane board and the Linear board stay in lock-step.
 *
 *   Wave 1 — MVP    →  custom view "AIOS — Wave 1 (MVP)" (label wave-1)
 *   Wave 2 — Later  →  custom view "AIOS — Wave 2 (Later)" (label wave-2)
 *     epic  P0      →  parent issue  "P0 — Plane integration (MCP + seed)"
 *       chunk P0.1  →  sub-issue     "Register official Plane MCP server"
 *
 * Idempotency: Linear has no Plane-style external_id, so each created issue carries a stable
 * footer marker `aios-ext: <ext>` in its description (ext = P0, P0.1, …). Re-runs read that
 * marker off existing issues and skip anything already present — safe to run repeatedly.
 * Re-runs do not update titles, descriptions, labels, or parent links when the backlog changes;
 * edit issues in Linear/Plane or delete and re-seed if you need a full refresh.
 *
 * Auth/config from env (read at runtime — never hard-coded):
 *   LINEAR_API_KEY  (required)  → header Authorization: <raw personal key>  (NOT a Bearer token)
 *   LINEAR_TEAM     (optional)  → target team key or name (e.g. "AIO" / "Engineering").
 *                                 If unset and the account has exactly one team, that team is used.
 *                                 May also be passed as `--team <key>`.
 *   PLANE_API_KEY / PLANE_WORKSPACE_SLUG / PLANE_BASE_URL  (only for --sync-status; same env as
 *                                 plane:backlog) → read Plane state groups to mirror onto Linear.
 *
 * Endpoint/auth verified against https://linear.app/developers (matches the shipped
 * linear-direct skill): POST https://api.linear.app/graphql, Authorization: <api-key>.
 *
 * Run (decrypts the dotenvx-encrypted key from the workspace .env, same pattern as plane:backlog):
 *   npx --yes @dotenvx/dotenvx run -f ../aios-workspace/.env -- node scripts/linear-backlog.mjs
 *   # or: npm run linear:backlog
 *
 * Flags: --dry-run (no writes; print plan; with --sync-status, plan state changes only)
 *        --verbose   --team <key>
 *        --sync-status (after seeding, set each Linear issue's state from its Plane counterpart)
 */

import { BACKLOG, WAVE1, WAVE2, LABELS } from "./aios-backlog.mjs";

const API = "https://api.linear.app/graphql";
const API_KEY = process.env.LINEAR_API_KEY;
const DRY = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");
// After seeding, reconcile each Linear issue's workflow state to match its Plane counterpart
// (matched by the shared ext key) so "done in Plane" shows as "done in Linear". Needs PLANE_API_KEY.
const SYNC_STATUS = process.argv.includes("--sync-status");
const teamFlagIdx = process.argv.indexOf("--team");
const TEAM_WANT = (teamFlagIdx !== -1 ? process.argv[teamFlagIdx + 1] : process.env.LINEAR_TEAM || "").trim();

// Wave → saved view name + filter label (issues already carry wave-1 / wave-2 labels).
const VIEW_NAME = {
  [WAVE1]: "AIOS — Wave 1 (MVP)",
  [WAVE2]: "AIOS — Wave 2 (Later)",
};
const WAVE_LABEL = {
  [WAVE1]: "wave-1",
  [WAVE2]: "wave-2",
};

// Stable per-issue idempotency marker, embedded in the issue description.
const EXT_SOURCE = "aios-backlog";
const extMarker = (ext) => `aios-ext: ${ext} · source: ${EXT_SOURCE}`;
const EXT_RE = /aios-ext:\s*([A-Za-z0-9._-]+)\s*[·•]\s*source:\s*aios-backlog\b/;
const parseExt = (description) => {
  const m = String(description || "").match(EXT_RE);
  return m ? m[1] : null;
};

if (!API_KEY && (!DRY || SYNC_STATUS)) {
  console.error("LINEAR_API_KEY is not set. Run via: npx @dotenvx/dotenvx run -f ../aios-workspace/.env -- node scripts/linear-backlog.mjs");
  process.exit(1);
}

// Plane priority words → Linear priority Int (0 none · 1 urgent · 2 high · 3 medium · 4 low).
function mapPriority(word) {
  switch ((word || "").toLowerCase()) {
    case "high": return 2;
    case "medium": return 3;
    case "low": return 4;
    default: return 0;
  }
}

// Backlog descriptions are authored as <p>…</p> HTML (for Plane's description_html). Linear wants
// markdown/plain text, so unwrap the single paragraph and append the idempotency marker.
function bodyFor(htmlDesc, ext) {
  const text = String(htmlDesc || "").replace(/^<p>/, "").replace(/<\/p>$/, "").trim();
  return `${text}\n\n${extMarker(ext)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── GraphQL transport: light throttle + 429 backoff ───────────────────────────
const MIN_INTERVAL = 150; // ms between requests; Linear allows ~1500 req/hr for personal keys
const MAX_429_RETRIES = 8;
let lastReq = 0;
async function gql(query, variables, attempt = 0, rateLimitAttempt = 0) {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL - (now - lastReq));
  if (wait) await sleep(wait);
  lastReq = Date.now();
  let res;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { Authorization: API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    // network blip — retry a few times before giving up
    if (attempt < 4) { console.warn(`  network error (${err.message}); retry ${attempt + 1}/4`); await sleep(1000 * (attempt + 1)); return gql(query, variables, attempt + 1, rateLimitAttempt); }
    throw err;
  }
  if (res.status === 429) {
    if (rateLimitAttempt >= MAX_429_RETRIES) throw new Error(`Linear rate-limited after ${MAX_429_RETRIES} retries`);
    const retry = Number(res.headers.get("Retry-After") || 5) * 1000;
    console.warn(`  rate-limited; backing off ${retry}ms (${rateLimitAttempt + 1}/${MAX_429_RETRIES})`);
    await sleep(retry);
    return gql(query, variables, attempt, rateLimitAttempt + 1);
  }
  if (res.status >= 500 && attempt < 4) {
    // transient Linear gateway error (502/503/504) — back off and retry
    console.warn(`  Linear HTTP ${res.status}; retry ${attempt + 1}/4`);
    await sleep(1000 * (attempt + 1));
    return gql(query, variables, attempt + 1, rateLimitAttempt);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) {
    const msg = json?.errors ? json.errors.map((e) => e.message).join("; ") : `HTTP ${res.status}`;
    throw new Error(`Linear GraphQL error: ${msg}`);
  }
  if (VERBOSE) console.log(`  gql ok`);
  return json.data;
}

// ── queries / mutations ───────────────────────────────────────────────────────
async function resolveTeam() {
  const data = await gql(`query { teams(first: 250) { nodes { id key name } } }`);
  const teams = data.teams.nodes;
  if (!teams.length) throw new Error("This Linear account has no teams.");
  if (TEAM_WANT) {
    const want = TEAM_WANT.toLowerCase();
    const team = teams.find((t) => t.key.toLowerCase() === want || t.name.toLowerCase() === want);
    if (!team) throw new Error(`Linear team "${TEAM_WANT}" not found. Available: ${teams.map((t) => `${t.key} (${t.name})`).join(", ")}`);
    return team;
  }
  if (teams.length === 1) return teams[0];
  throw new Error(`Multiple Linear teams — set LINEAR_TEAM (or --team) to one of: ${teams.map((t) => `${t.key} (${t.name})`).join(", ")}`);
}

async function teamCustomViews(teamId) {
  const data = await gql(`query { customViews(first: 250) { nodes { id name team { id } } } }`);
  return data.customViews.nodes.filter((v) => v.team?.id === teamId);
}

async function createCustomView(teamId, name, labelName) {
  const data = await gql(
    `mutation($input: CustomViewCreateInput!) { customViewCreate(input: $input) { success customView { id name } } }`,
    { input: {
      name,
      teamId,
      filterData: { labels: { name: { eq: labelName } } },
      description: `AIOS backlog mirror — issues labeled ${labelName} (see Plane workspace aios-alpha / project AIOS).`,
    } }
  );
  if (!data.customViewCreate.success) throw new Error(`customViewCreate failed for ${name}`);
  return data.customViewCreate.customView;
}

async function teamLabels(teamId) {
  const data = await gql(`query($id: String!) { team(id: $id) { labels(first: 250) { nodes { id name } } } }`, { id: teamId });
  return data.team.labels.nodes;
}

async function createLabel(teamId, name) {
  const data = await gql(
    `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }`,
    { input: { name, teamId } }
  );
  if (!data.issueLabelCreate.success) throw new Error(`issueLabelCreate failed for ${name}`);
  return data.issueLabelCreate.issueLabel;
}

// All team issues (paginated) → map of ext-marker → issue id, for idempotency + parent linking.
async function existingByExt(teamId) {
  const byExt = new Map();
  let after = null;
  for (let i = 0; i < 100; i++) {
    const data = await gql(
      `query($id: String!, $after: String) {
        team(id: $id) {
          issues(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id title description }
          }
        }
      }`,
      { id: teamId, after }
    );
    const conn = data.team.issues;
    for (const node of conn.nodes) {
      const ext = parseExt(node.description);
      if (ext) byExt.set(ext, node.id);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return byExt;
}

async function createIssue({ teamId, title, description, priority, labelIds, parentId }) {
  const input = { teamId, title, description };
  if (priority) input.priority = priority;
  if (labelIds?.length) input.labelIds = labelIds;
  if (parentId) input.parentId = parentId;
  const data = await gql(
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`,
    { input }
  );
  if (!data.issueCreate.success) throw new Error(`issueCreate failed for ${title}`);
  return data.issueCreate.issue;
}

async function setIssueState(issueId, stateId) {
  const data = await gql(
    `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
    { id: issueId, input: { stateId } }
  );
  if (!data.issueUpdate.success) throw new Error(`issueUpdate failed for ${issueId}`);
}

// ── status sync: mirror Plane state groups onto Linear workflow states ─────────
// Plane and Linear share the same five workflow-state "groups"/"types", so we map by group
// and prefer a same-named state, falling back to the first state of that type.
const GROUP_TO_TYPE = { backlog: "backlog", unstarted: "unstarted", started: "started", completed: "completed", cancelled: "canceled" };
const GROUP_PREFERRED = { backlog: "Backlog", unstarted: "Todo", started: "In Progress", completed: "Done", cancelled: "Canceled" };

// Read Plane state groups for the AIOS backlog: returns Map(ext → group). Reuses the same env
// and cursor-pagination shape as scripts/plane-backlog.mjs.
async function planeExtGroups() {
  const KEY = process.env.PLANE_API_KEY;
  if (!KEY) throw new Error("--sync-status needs PLANE_API_KEY (same env as plane:backlog).");
  const SLUG = process.env.PLANE_WORKSPACE_SLUG || "aios-alpha";
  const BASE = (process.env.PLANE_BASE_URL || "https://api.plane.so").replace(/\/$/, "");
  const h = { "X-API-Key": KEY, "Content-Type": "application/json" };
  async function all(path) {
    const out = []; let cursor = "100:0:0";
    for (let i = 0; i < 100; i++) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await fetch(`${BASE}/api/v1/workspaces/${SLUG}${path}${sep}per_page=100&cursor=${encodeURIComponent(cursor)}`, { headers: h });
      if (!r.ok) throw new Error(`Plane ${path} → ${r.status}`);
      const j = await r.json();
      if (Array.isArray(j)) { out.push(...j); break; }
      out.push(...(j.results || []));
      if (!j.next_page_results || !j.next_cursor) break;
      cursor = j.next_cursor;
    }
    return out;
  }
  const projects = await all("/projects/");
  const project = process.env.PLANE_PROJECT_ID
    ? projects.find((p) => p.id === process.env.PLANE_PROJECT_ID)
    : projects.find((p) => p.identifier === "AIOS" || /(^|\b)AIOS\b/.test(p.name));
  if (!project) throw new Error(`AIOS project not found in Plane workspace ${SLUG}`);
  const states = await all(`/projects/${project.id}/states/`);
  const groupOf = new Map(states.map((s) => [s.id, s.group]));
  const items = await all(`/projects/${project.id}/work-items/`);
  const byExt = new Map();
  for (const it of items) {
    if (it.external_source === "aios-backlog" && it.external_id) byExt.set(it.external_id, groupOf.get(it.state) || "unstarted");
  }
  return byExt;
}

async function reconcileStatus(teamId, { dryRun = false } = {}) {
  // Linear workflow states for the team.
  const sData = await gql(`query($id: String!) { team(id: $id) { states(first: 50) { nodes { id name type } } } }`, { id: teamId });
  const states = sData.team.states.nodes;
  const stateForGroup = (group) => {
    const type = GROUP_TO_TYPE[group];
    const ofType = states.filter((s) => s.type === type);
    return ofType.find((s) => s.name === GROUP_PREFERRED[group])?.id || ofType[0]?.id || null;
  };

  // Current Linear issues (ext marker → {id, current stateId}).
  const current = new Map();
  let after = null;
  for (let i = 0; i < 100; i++) {
    const d = await gql(
      `query($id: String!, $after: String) { team(id: $id) { issues(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor } nodes { id description state { id } } } } }`,
      { id: teamId, after }
    );
    const conn = d.team.issues;
    for (const n of conn.nodes) {
      const ext = parseExt(n.description);
      if (ext) current.set(ext, { id: n.id, stateId: n.state?.id || null });
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  const planeGroups = await planeExtGroups();
  let changed = 0, matched = 0, missing = 0;
  for (const [ext, group] of planeGroups) {
    const issue = current.get(ext);
    if (!issue) { missing++; continue; }
    matched++;
    const target = stateForGroup(group);
    if (!target || target === issue.stateId) continue;
    changed++;
    if (dryRun) {
      if (VERBOSE) console.log(`would  ${ext} → ${GROUP_PREFERRED[group]} (${group})`);
      continue;
    }
    await setIssueState(issue.id, target);
    if (VERBOSE) console.log(`state  ${ext} → ${GROUP_PREFERRED[group]} (${group})`);
  }
  const prefix = dryRun ? "Status sync (dry-run)" : "Status sync";
  console.log(`${prefix}: ${changed} ${dryRun ? "would update" : "updated"} · ${matched - changed} already correct · ${missing} Plane item(s) not in Linear (e.g. pre-backlog history).`);
}

// ── plan / run ────────────────────────────────────────────────────────────────
async function main() {
  const totalItems = BACKLOG.length + BACKLOG.reduce((n, e) => n + e.subs.length, 0);

  if (DRY && !SYNC_STATUS) {
    console.log(`Linear mirror plan (--dry-run): ${BACKLOG.length} epics + ${totalItems - BACKLOG.length} sub-issues = ${totalItems} issues`);
    console.log(`Views: "${VIEW_NAME[WAVE1]}" (${WAVE_LABEL[WAVE1]}), "${VIEW_NAME[WAVE2]}" (${WAVE_LABEL[WAVE2]})  ·  team: ${TEAM_WANT || "(auto / single team)"}\n`);
    for (const e of BACKLOG) {
      console.log(`◆ [${VIEW_NAME[e.wave]}] (${e.priority})  ${e.name}`);
      for (const s of e.subs) console.log(`   └─ ${s.ext}  ${s.name}`);
    }
    console.log("\n--dry-run: no writes performed. Set LINEAR_API_KEY + LINEAR_TEAM and re-run without --dry-run.");
    return;
  }

  if (DRY && SYNC_STATUS) {
    const team = await resolveTeam();
    console.log(`Team: ${team.name} (${team.key}) ${team.id}\n`);
    await reconcileStatus(team.id, { dryRun: true });
    return;
  }

  // 1. team
  const team = await resolveTeam();
  console.log(`Team: ${team.name} (${team.key}) ${team.id}`);

  // 2. ensure wave views (label-filtered saved views, not projects)
  const existingViews = await teamCustomViews(team.id);
  const viewId = new Map(existingViews.map((v) => [v.name, v.id]));
  for (const wave of [WAVE1, WAVE2]) {
    const name = VIEW_NAME[wave];
    if (viewId.has(name)) continue;
    const created = await createCustomView(team.id, name, WAVE_LABEL[wave]);
    viewId.set(name, created.id);
    console.log(`view + ${name} (label ${WAVE_LABEL[wave]})`);
  }

  // 3. ensure labels
  const existingLabels = await teamLabels(team.id);
  const labelId = new Map(existingLabels.map((l) => [l.name, l.id]));
  for (const name of LABELS) {
    if (labelId.has(name)) continue;
    const created = await createLabel(team.id, name);
    labelId.set(name, created.id);
    console.log(`label + ${name}`);
  }

  // 4. idempotency index
  const byExt = await existingByExt(team.id);

  const stats = { created: 0, skipped: 0 };
  async function ensureIssue({ ext, name, desc, priority, labels, wave, parentId }) {
    const found = byExt.get(ext);
    if (found) {
      stats.skipped++;
      if (VERBOSE) console.log(`skip   ${ext} (exists)`);
      return found;
    }
    const issue = await createIssue({
      teamId: team.id,
      title: name,
      description: bodyFor(desc, ext),
      priority: mapPriority(priority),
      labelIds: (labels || []).map((n) => labelId.get(n)).filter(Boolean),
      parentId,
    });
    byExt.set(ext, issue.id);
    stats.created++;
    console.log(`create ${ext}  ${issue.identifier}  ${name}`);
    return issue.id;
  }

  // 5. epics (parent issues) then chunks (sub-issues)
  for (const epic of BACKLOG) {
    const epicId = await ensureIssue({ ext: epic.ext, name: epic.name, desc: epic.desc, priority: epic.priority, labels: epic.labels, wave: epic.wave });
    for (const sub of epic.subs) {
      await ensureIssue({ ext: sub.ext, name: sub.name, desc: sub.desc, priority: epic.priority, labels: epic.labels, wave: epic.wave, parentId: epicId });
    }
  }

  console.log(`\nDone. created=${stats.created} skipped=${stats.skipped} (total ${totalItems}).`);

  // 6. optional: mirror Plane state groups onto Linear (done-in-Plane → done-in-Linear).
  if (SYNC_STATUS) await reconcileStatus(team.id);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
