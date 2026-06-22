#!/usr/bin/env node
/**
 * Idempotent mirror of the AIOS remaining-work backlog into Linear.
 *
 * Linear-native mapping (decided with John): each Wave becomes a Linear PROJECT, each epic
 * becomes a parent ISSUE inside its wave's project, and each chunk becomes a SUB-ISSUE.
 * The backlog data is shared verbatim with scripts/plane-backlog.mjs via scripts/aios-backlog.mjs,
 * so the Plane board and the Linear board stay in lock-step.
 *
 *   Wave 1 — MVP    →  Linear project "AIOS — Wave 1 (MVP)"
 *   Wave 2 — Later  →  Linear project "AIOS — Wave 2 (Later)"
 *     epic  P0      →  parent issue  "P0 — Plane integration (MCP + seed)"
 *       chunk P0.1  →  sub-issue     "Register official Plane MCP server"
 *
 * Idempotency: Linear has no Plane-style external_id, so each created issue carries a stable
 * footer marker `aios-ext: <ext>` in its description (ext = P0, P0.1, …). Re-runs read that
 * marker off existing issues and skip anything already present — safe to run repeatedly.
 *
 * Auth/config from env (read at runtime — never hard-coded):
 *   LINEAR_API_KEY  (required)  → header Authorization: <raw personal key>  (NOT a Bearer token)
 *   LINEAR_TEAM     (optional)  → target team key or name (e.g. "AIOS" / "Engineering").
 *                                 If unset and the account has exactly one team, that team is used.
 *                                 May also be passed as `--team <key>`.
 *
 * Endpoint/auth verified against https://linear.app/developers (matches the shipped
 * linear-direct skill): POST https://api.linear.app/graphql, Authorization: <api-key>.
 *
 * Run (decrypts the dotenvx-encrypted key from the workspace .env, same pattern as plane:backlog):
 *   npx --yes @dotenvx/dotenvx run -f ../aios-workspace/.env -- node scripts/linear-backlog.mjs
 *   # or: npm run linear:backlog
 *
 * Flags: --dry-run (no writes; print plan)   --verbose   --team <key>
 */

import { BACKLOG, WAVE1, WAVE2, LABELS } from "./aios-backlog.mjs";

const API = "https://api.linear.app/graphql";
const API_KEY = process.env.LINEAR_API_KEY;
const DRY = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");
const teamFlagIdx = process.argv.indexOf("--team");
const TEAM_WANT = (teamFlagIdx !== -1 ? process.argv[teamFlagIdx + 1] : process.env.LINEAR_TEAM || "").trim();

// Wave module → Linear project name.
const PROJECT_NAME = {
  [WAVE1]: "AIOS — Wave 1 (MVP)",
  [WAVE2]: "AIOS — Wave 2 (Later)",
};

// Stable per-issue idempotency marker, embedded in the issue description.
const EXT_SOURCE = "aios-backlog";
const extMarker = (ext) => `aios-ext: ${ext} · source: ${EXT_SOURCE}`;
const EXT_RE = /aios-ext:\s*([A-Za-z0-9._-]+)/;

if (!API_KEY && !DRY) {
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
let lastReq = 0;
async function gql(query, variables) {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL - (now - lastReq));
  if (wait) await sleep(wait);
  lastReq = Date.now();
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get("Retry-After") || 5) * 1000;
    console.warn(`  rate-limited; backing off ${retry}ms`);
    await sleep(retry);
    return gql(query, variables);
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

async function teamProjects(teamId) {
  const data = await gql(`query($id: String!) { team(id: $id) { projects(first: 250) { nodes { id name } } } }`, { id: teamId });
  return data.team.projects.nodes;
}

async function createProject(teamId, name) {
  const data = await gql(
    `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name } } }`,
    { input: { name, teamIds: [teamId], description: `Mirror of the AIOS ${name.includes("Wave 1") ? WAVE1 : WAVE2} backlog (see Plane workspace aios-alpha / project AIOS).` }
  });
  if (!data.projectCreate.success) throw new Error(`projectCreate failed for ${name}`);
  return data.projectCreate.project;
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
      const m = (node.description || "").match(EXT_RE);
      if (m) byExt.set(m[1], node.id);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return byExt;
}

async function createIssue({ teamId, title, description, priority, labelIds, projectId, parentId }) {
  const input = { teamId, title, description };
  if (priority) input.priority = priority;
  if (labelIds?.length) input.labelIds = labelIds;
  if (projectId) input.projectId = projectId;
  if (parentId) input.parentId = parentId;
  const data = await gql(
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`,
    { input }
  );
  if (!data.issueCreate.success) throw new Error(`issueCreate failed for ${title}`);
  return data.issueCreate.issue;
}

// ── plan / run ────────────────────────────────────────────────────────────────
async function main() {
  const totalItems = BACKLOG.length + BACKLOG.reduce((n, e) => n + e.subs.length, 0);

  if (DRY) {
    console.log(`Linear mirror plan (--dry-run): ${BACKLOG.length} epics + ${totalItems - BACKLOG.length} sub-issues = ${totalItems} issues`);
    console.log(`Projects: "${PROJECT_NAME[WAVE1]}", "${PROJECT_NAME[WAVE2]}"  ·  team: ${TEAM_WANT || "(auto / single team)"}\n`);
    for (const e of BACKLOG) {
      console.log(`◆ [${PROJECT_NAME[e.wave]}] (${e.priority})  ${e.name}`);
      for (const s of e.subs) console.log(`   └─ ${s.ext}  ${s.name}`);
    }
    console.log("\n--dry-run: no writes performed. Set LINEAR_API_KEY + LINEAR_TEAM and re-run without --dry-run.");
    return;
  }

  // 1. team
  const team = await resolveTeam();
  console.log(`Team: ${team.name} (${team.key}) ${team.id}`);

  // 2. ensure wave projects
  const existingProjects = await teamProjects(team.id);
  const projectId = new Map(existingProjects.map((p) => [p.name, p.id]));
  const waveProject = new Map();
  for (const wave of [WAVE1, WAVE2]) {
    const name = PROJECT_NAME[wave];
    let id = projectId.get(name);
    if (!id) {
      const created = await createProject(team.id, name);
      id = created.id;
      console.log(`project + ${name}`);
    }
    waveProject.set(wave, id);
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
      projectId: waveProject.get(wave),
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
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
