#!/usr/bin/env node
/**
 * Docs drift guard. Derives the repo's drift-prone *structural surfaces* from code and
 * checks they match the inventories documented in docs/ARCHITECTURE.md. Fails (exit 1)
 * on any mismatch in either direction, so a PR that adds/removes an API route, a DB
 * table, or an ingestion source must update the docs to merge.
 *
 * It verifies enumerable structure, not prose — keep the narrative/diagrams accurate by
 * review; this guard guarantees the inventories never silently drift.
 *
 * Doc format: each tracked surface lives between markers and lists items as inline code:
 *   <!-- drift:routes -->  ... `POST /api/v1/items` ...  <!-- /drift:routes -->
 *
 * Run: node scripts/check-docs-drift.mjs   (or: npm run check:docs)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DOC = join(ROOT, "docs", "ARCHITECTURE.md");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ── derive ground truth from code ────────────────────────────────────────────
function deriveRoutes() {
  const apiDir = join(ROOT, "app", "api");
  const routes = new Set();
  for (const file of walk(apiDir).filter((f) => f.endsWith("route.ts"))) {
    const rel = file.slice(ROOT.length).replace(/\\/g, "/"); // /app/api/.../route.ts
    const path = rel
      .replace(/^\/app/, "")
      .replace(/\/route\.ts$/, "")
      .replace(/\[(\w+)\]/g, ":$1");
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
      routes.add(`${m[1]} ${path}`);
    }
  }
  return routes;
}

function deriveTables() {
  const migDir = join(ROOT, "supabase", "migrations");
  const tables = new Set();
  for (const file of walk(migDir).filter((f) => f.endsWith(".sql"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      tables.add(m[1].toLowerCase());
    }
  }
  return tables;
}

function deriveAdapters() {
  const src = readFileSync(join(ROOT, "ingestion", "aios_ingest", "sources", "registry.py"), "utf8");
  const block = src.match(/_REGISTRY[^{]*\{([\s\S]*?)\}/);
  const adapters = new Set();
  if (block) {
    for (const m of block[1].matchAll(/"([a-z_]+)"\s*:/g)) adapters.add(m[1]);
  }
  return adapters;
}

// ── read documented inventories ──────────────────────────────────────────────
// Extract inline-code tokens between the markers, keeping only those matching `accept`
// (so descriptive inline code in the surrounding prose can't pollute the inventory).
function docBlock(content, name, accept) {
  const re = new RegExp(`<!--\\s*drift:${name}\\s*-->([\\s\\S]*?)<!--\\s*/drift:${name}\\s*-->`);
  const m = content.match(re);
  if (!m) return null;
  const items = new Set();
  for (const t of m[1].matchAll(/`([^`]+)`/g)) {
    if (accept.test(t[1])) items.add(t[1]);
  }
  return items;
}

const IS_ROUTE = /^(GET|POST|PUT|PATCH|DELETE)\s+\//;
const IS_IDENT = /^[a-z_][a-z0-9_]*$/;

// ── compare ──────────────────────────────────────────────────────────────────
function diff(label, actual, documented) {
  if (documented === null) {
    console.error(`✗ ${label}: missing <!-- drift:${label} --> block in docs/ARCHITECTURE.md`);
    return false;
  }
  const missing = [...actual].filter((x) => !documented.has(x)).sort();
  const extra = [...documented].filter((x) => !actual.has(x)).sort();
  if (missing.length === 0 && extra.length === 0) {
    console.log(`✓ ${label}: ${actual.size} item(s) in sync`);
    return true;
  }
  if (missing.length) console.error(`✗ ${label}: in code but NOT documented → ${missing.join(", ")}`);
  if (extra.length) console.error(`✗ ${label}: documented but NOT in code → ${extra.join(", ")}`);
  return false;
}

const doc = readFileSync(DOC, "utf8");
const checks = [
  diff("routes", deriveRoutes(), docBlock(doc, "routes", IS_ROUTE)),
  diff("tables", deriveTables(), docBlock(doc, "tables", IS_IDENT)),
  diff("sources", deriveAdapters(), docBlock(doc, "sources", IS_IDENT)),
];

if (checks.every(Boolean)) {
  console.log("\nDocs are congruent with the code. ✓");
  process.exit(0);
}
console.error(
  "\nDocs drift detected. Update the drift inventories in docs/ARCHITECTURE.md to match the code."
);
process.exit(1);
