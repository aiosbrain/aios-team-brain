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
 *
 * Run (decrypts the dotenvx-encrypted key from the workspace .env):
 *   dotenvx run -f /Users/iamjohndass/Projects/aios/aios-workspace/.env -- node scripts/plane-backlog.mjs
 *   # or: npm run plane:backlog   (wrapper does the same)
 *
 * Flags: --dry-run (no writes; print plan)   --verbose
 */

const API_KEY = process.env.PLANE_API_KEY;
const SLUG = process.env.PLANE_WORKSPACE_SLUG || "aios-alpha";
const BASE = (process.env.PLANE_BASE_URL || "https://api.plane.so").replace(/\/$/, "");
const EXTERNAL_SOURCE = "aios-backlog";
const DRY = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");
const RESTATE = process.argv.includes("--restate"); // move all backlog items into the target state

if (!API_KEY) {
  console.error("PLANE_API_KEY is not set. Run via: dotenvx run -f <workspace>/.env -- node scripts/plane-backlog.mjs");
  process.exit(1);
}

const WAVE1 = "Wave 1 — MVP";
const WAVE2 = "Wave 2 — Later";
const LABELS = ["wave-1", "wave-2", "foundation", "brain", "sidecar", "ops", "integration", "design", "migration"];

// ── backlog: one epic per feature, sub-issues = chunks ────────────────────────
const p = (s) => `<p>${s}</p>`;
const BACKLOG = [
  { ext: "P0", name: "P0 — Plane integration (MCP + seed)", wave: WAVE1, priority: "high",
    labels: ["integration", "wave-1"], desc: p("Stand up Plane as a real integration: official MCP server (durable/agentic) + idempotent REST seed of this backlog under the AIOS project."),
    subs: [
      { ext: "P0.1", name: "Register official Plane MCP server", desc: p("claude mcp add --transport http plane https://mcp.plane.so/http/mcp (OAuth). Confirm tools listable. Fallback: uvx plane-mcp-server (user scope).") },
      { ext: "P0.2", name: "Idempotent REST seed script", desc: p("scripts/plane-backlog.mjs: discover AIOS project, ensure Wave modules + labels, create epics+sub-issues with external_id idempotency, throttle ≤60/min. npm plane:backlog.") },
      { ext: "P0.3", name: "Record Plane integration in brain integrations table", desc: p("After F5: integrations row type=plane, config={workspaceSlug:'aios-alpha', projectId}. Substrate for W2.4 plane ingestion source.") },
      { ext: "P0.4", name: "Verify backlog structure + idempotent re-run", desc: p("Confirm epics+sub-issues with parents/modules/labels; re-run seed → all skipped (no duplicates).") },
    ] },

  { ext: "F3", name: "F3 — Integrations auth surfaces + contract bump", wave: WAVE1, priority: "high",
    labels: ["foundation", "brain", "wave-1"], desc: p("Two auth surfaces for the integrations framework without touching the pinned /api/v1 write contract."),
    subs: [
      { ext: "F3.1", name: "Dashboard session-auth write (server action)", desc: p("Server action / app/api/dashboard/integrations/route.ts → lib/integrations/manage.ts; admin-gated like admin/layout.tsx. No /api/v1 write surface.") },
      { ext: "F3.2", name: "GET /api/v1/integrations (sidecar read)", desc: p("API-key auth; returns NON-SECRET selections for the team. The documented contract the sidecar consumes.") },
      { ext: "F3.3", name: "Version brain-api.md + drift:routes", desc: p("Add the new read endpoint to aios-workspace/docs/brain-api.md FIRST, then docs/ARCHITECTURE.md drift:routes; npm run check:docs green. dep: F3.2") },
      { ext: "F3.4", name: "Data-mechanics: admin-only write + scoped read", desc: p("Non-admin write → 403; API-key read returns only non-secret fields, team-scoped. dep: F3.1,F3.2") },
    ] },

  { ext: "F4", name: "F4 — Sidecar consumes selections", wave: WAVE1, priority: "high",
    labels: ["sidecar", "wave-1"], desc: p("Close the 'table does nothing' gap: the ingestion engine merges brain-side selections with local secrets. dep: F3"),
    subs: [
      { ext: "F4.1", name: "engine.py + brain_client.py merge", desc: p("Fetch GET /api/v1/integrations; merge with local secrets by (type,name) — selection from brain, tokens local.") },
      { ext: "F4.2", name: "connections.yaml.example + backward-compat", desc: p("Document; when selection-fetch unconfigured, behave exactly as today.") },
      { ext: "F4.3", name: "Python tests: merge + backward-compat", desc: p("Merge precedence; unconfigured = current behavior.") },
    ] },

  { ext: "F5", name: "F5 — Admin Integrations UI + tier guards", wave: WAVE1, priority: "high",
    labels: ["foundation", "brain", "wave-1"], desc: p("Admin-gated Integrations surface + per-table tier/role guards (no RLS backstop on postgres). dep: F3"),
    subs: [
      { ext: "F5.1", name: "Admin tab + integrations page", desc: p("components/admin/admin-tabs.tsx entry + app/t/[team]/admin/integrations/page.tsx (admin gate).") },
      { ext: "F5.2", name: "lib/integrations/read.ts scoped reads", desc: p("Role/tier-scoped read helper for the integrations surface.") },
      { ext: "F5.3", name: "integrations-tier-filter guard test", desc: p("test/guards/integrations-tier-filter.test.ts modeled on codebases-tier-filter.") },
      { ext: "F5.4", name: "Supabase fail-closed notice", desc: p("Under DB_BACKEND=supabase, surface shows 'not available on legacy backend'.") },
      { ext: "F5.5", name: "Data-mechanics: persistence + tier isolation", desc: p("Real-PG: integrations persist; external tier cannot read admin config.") },
    ] },

  { ext: "W1.1", name: "W1.1 — Granola → decisions (sanitized, consented)", wave: WAVE1, priority: "high",
    labels: ["sidecar", "integration", "wave-1"], desc: p("Ingest Granola meetings as decision rows only — NO verbatim transcript synced team-tier."),
    subs: [
      { ext: "W1.1.1", name: "granola.py source + registry + drift", desc: p("ingestion/aios_ingest/sources/granola.py implements Source; register in registry.py; drift:sources += granola.") },
      { ext: "W1.1.2", name: "Privacy gate: allowlist + consent", desc: p("Meeting allowlist (AIOS keyword / John+Chetan participants) + per-note consent; no verbatim team-tier transcript.") },
      { ext: "W1.1.3", name: "Reuse granola-digest pull/parse", desc: p("Transcripts pulled to workspace (admin-tier, local) only.") },
      { ext: "W1.1.4", name: "Wire transcript-decisions flow", desc: p("transcript-decisions workflow → human-reviewed decision rows → decision-log.md → aios push → materializeDecisions.") },
      { ext: "W1.1.5", name: "Python tests (mocked pagination/rate-limit)", desc: p("Registry + normalize + mocked API pagination & rate-limit.") },
    ] },

  { ext: "W1.2", name: "W1.2 — Token + cost per member (brain spend)", wave: WAVE1, priority: "high",
    labels: ["brain", "wave-1"], desc: p("Per-member LLM cost from query_log (built on the shipped scopeQueryLog fix + shared identity resolver)."),
    subs: [
      { ext: "W1.2.1", name: "lib/metrics/members.ts getPerMemberCosts", desc: p("Role-scoped aggregation of query_log via scopeQueryLog; admins team-wide, others self.") },
      { ext: "W1.2.2", name: "Admin usage page", desc: p("app/t/[team]/admin/usage/page.tsx (admin-only) reusing contributor-table + charts.") },
      { ext: "W1.2.3", name: "Throughput-vs-cost primitive", desc: p("Join code_contributions (via shared resolver) × query_log spend → $ per AI commit / contributor.") },
      { ext: "W1.2.4", name: "Tier/role guard + data-mechanics", desc: p("Guard test + real-PG aggregation test.") },
    ] },

  { ext: "W1.3", name: "W1.3 — GitHub native UI (selection + manual scan)", wave: WAVE1, priority: "high",
    labels: ["brain", "wave-1"], desc: p("Dashboard repo selection + member linking, reusing the code-only GitHub integration. No server-triggered scan in Wave 1. dep: F5"),
    subs: [
      { ext: "W1.3.1", name: "Repo selection persisted to integrations", desc: p("type=github, config.repos; reuse lib/codebases/github.ts.") },
      { ext: "W1.3.2", name: "Member → GitHub linking UI", desc: p("Reuse linkGithub.") },
      { ext: "W1.3.3", name: "Scan freshness + manual scan panel", desc: p("Show last-scan SHA vs main HEAD + documented manual aios-ingest command. Selection consumed by sidecar (F4).") },
      { ext: "W1.3.4", name: "Respect canSeeCodebases (team-tier)", desc: p("lib/codebases/visibility.ts gate.") },
    ] },

  { ext: "W1.4", name: "W1.4 — Ops hardening (Sentry, CodeRabbit, BugBot)", wave: WAVE1, priority: "high",
    labels: ["ops", "wave-1"], desc: p("Error logging + AI code review for the OSS repos."),
    subs: [
      { ext: "W1.4.1", name: "Sentry @sentry/nextjs ≥10.13 (Turbopack)", desc: p("instrumentation-client.ts, sentry.server/edge.config.ts, onRequestError in instrumentation.ts, app/global-error.tsx, withSentryConfig; DSN+token via env.") },
      { ext: "W1.4.2", name: "CodeRabbit GitHub App on public repos", desc: p("Free for public repos; no org-admin friction.") },
      { ext: "W1.4.3", name: "Fix Cursor BugBot org-app approval", desc: p("Approve Cursor app at AIOS-alpha → Third-party Access (manual; John is owner).") },
      { ext: "W1.4.4", name: "Sentry smoke test", desc: p("Client + server error → events + source maps resolve.") },
    ] },

  { ext: "W2.1", name: "W2.1 — External AI cost (usage_costs)", wave: WAVE2, priority: "medium",
    labels: ["brain", "wave-2"], desc: p("Per-member external provider spend (Anthropic/Cursor seats + API). dep: W1.2"),
    subs: [
      { ext: "W2.1.1", name: "usage_costs schema + FK registry + drift", desc: p("{team_id, member_id, provider, period, input_tokens, output_tokens, cost_usd, source}.") },
      { ext: "W2.1.2", name: "lib/costs/ingest.ts single writer + guard", desc: p("Only writer for usage_costs.") },
      { ext: "W2.1.3", name: "Anthropic Usage/Cost API source", desc: p("+ Enterprise Analytics per-user if available.") },
      { ext: "W2.1.4", name: "Cursor Admin API source (/teams/spend)", desc: p("Per-seat USD + tokens.") },
      { ext: "W2.1.5", name: "Identity resolve + retention + tier guard", desc: p("Shared resolver; 13-month retention; tier guard; merge into usage page.") },
    ] },

  { ext: "W2.2", name: "W2.2 — Slack bidirectional", wave: WAVE2, priority: "medium",
    labels: ["sidecar", "integration", "wave-2"], desc: p("Pull allowlisted channels into the brain; push digests + /ask-brain."),
    subs: [
      { ext: "W2.2.1", name: "Slack source + Events API (allowlisted)", desc: p("slack.py exists; Events API for allowlisted channels.") },
      { ext: "W2.2.2", name: "Push digests via incoming webhook", desc: p("Decisions / daily digest.") },
      { ext: "W2.2.3", name: "/ask-brain slash command", desc: p("→ lib/query/retrieve.ts.") },
      { ext: "W2.2.4", name: "Privacy allowlist + app manifest", desc: p("Like Granola; minimal Slack app manifest.") },
    ] },

  { ext: "W2.3", name: "W2.3 — Wise Business finance", wave: WAVE2, priority: "medium",
    labels: ["sidecar", "wave-2"], desc: p("Cash/runway view from Wise Business; secrets local."),
    subs: [
      { ext: "W2.3.1", name: "wise.py source (OAuth2)", desc: p("OAuth2 user token; balances + transactions.") },
      { ext: "W2.3.2", name: "finance_snapshots table + writer + guard", desc: p("Single writer + tier guard + FK registry.") },
      { ext: "W2.3.3", name: "Cash/runway dashboard tile", desc: p("Operating financials tile.") },
    ] },

  { ext: "W2.4", name: "W2.4 — PM bake-off: Linear + Plane → brain", wave: WAVE2, priority: "medium",
    labels: ["integration", "wave-2"], desc: p("Ingest both Linear and Plane issues/cycles INTO the brain; compare; pick. Closes the loop with P0."),
    subs: [
      { ext: "W2.4.1", name: "Configure linear source", desc: p("Existing linear source → ingest issues/cycles.") },
      { ext: "W2.4.2", name: "Add plane.py source", desc: p("Ingest AIOS work items/cycles back into the brain.") },
      { ext: "W2.4.3", name: "Brain overlay: link issues ↔ decisions", desc: p("Link issues ↔ decisions/deliverables.") },
      { ext: "W2.4.4", name: "Comparison writeup → pick", desc: p("Linear vs Plane decision.") },
    ] },

  { ext: "W2.5", name: "W2.5 — Pencil design system", wave: WAVE2, priority: "low",
    labels: ["design", "wave-2"], desc: p("Shared agentic design system with W3C design tokens."),
    subs: [
      { ext: "W2.5.1", name: "W3C DTCG tokens", desc: p("design/*.tokens.json.") },
      { ext: "W2.5.2", name: "Style Dictionary → tokens.css", desc: p("For Tailwind v4.") },
      { ext: "W2.5.3", name: "pencil MCP edits .pen + sync", desc: p("Two-way sync of tokens.") },
      { ext: "W2.5.4", name: "Shared design-library docs", desc: p("Usage across contributors/clients.") },
    ] },

  { ext: "W2.6", name: "W2.6 — connector→integration rename (blueprint migration)", wave: WAVE2, priority: "low",
    labels: ["migration", "wave-2"], desc: p("Versioned, backward-compatible rename — connectors is live blueprint JSON across repos."),
    subs: [
      { ext: "W2.6.1", name: "Bump blueprint schema version", desc: p("New version field.") },
      { ext: "W2.6.2", name: "Backward-compatible reader", desc: p("Accept both connectors + integrations keys.") },
      { ext: "W2.6.3", name: "Migrate published blueprints", desc: p("In-place migration.") },
      { ext: "W2.6.4", name: "brain-api.md + team-tools update", desc: p("Doc + UI.") },
    ] },
];

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

async function fetchAll(path) {
  // cursor pagination: ?cursor=value&per_page=100
  const out = [];
  let cursor = `100:0:0`;
  for (let i = 0; i < 100; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await api("GET", `${path}${sep}per_page=100&cursor=${encodeURIComponent(cursor)}`);
    out.push(...(page.results || []));
    if (!page.next_page_results || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out;
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
    if (it.external_source === EXTERNAL_SOURCE && it.external_id) byExt.set(it.external_id, it.id);
  }

  const stats = { created: 0, skipped: 0 };
  const moduleMembers = new Map([[WAVE1, []], [WAVE2, []]]);

  async function ensureItem({ ext, name, desc, priority, labels, parent }) {
    if (byExt.has(ext)) {
      stats.skipped++;
      if (VERBOSE) console.log(`skip   ${ext} (exists)`);
      return byExt.get(ext);
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
    if (parent) body.parent = parent;
    const created = await api("POST", proj(`/work-items/`), body);
    byExt.set(ext, created.id);
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

  console.log(`\nDone. created=${stats.created} skipped=${stats.skipped} (total ${totalItems}).`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
