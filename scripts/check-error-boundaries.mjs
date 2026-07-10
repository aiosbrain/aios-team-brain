#!/usr/bin/env node
/**
 * Error boundary guard. Verifies that every layout.tsx that renders content is covered by a scoped
 * error boundary (error.tsx or global-error.tsx) at its own level or a parent level, so a
 * single-page render crash never replaces the entire <html>/<body>.
 *
 * Next.js error boundary propagation: error.tsx at a given segment catches errors in that segment
 * AND all nested children. global-error.tsx at the root catches errors in the root layout only.
 * The check walks UP from each layout's directory to find the nearest covering error boundary;
 * a layout is "covered" if it (or any ancestor) has error.tsx, or if it's the root and has
 * global-error.tsx.
 *
 * Run: node scripts/check-error-boundaries.mjs   (add to CI alongside check-docs-drift)
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";

const ROOT = process.cwd();
const APP_DIR = join(ROOT, "app");

function findLayouts(dir, layouts = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name.startsWith(".") || name === "node_modules") continue;
    const s = statSync(p);
    if (s.isDirectory()) findLayouts(p, layouts);
    else if (name === "layout.tsx") layouts.push(p);
  }
  return layouts;
}

/** Walk up from `dir` toward APP_DIR; return the first error boundary (or null). */
function findCovering(dir) {
  let cur = dir;
  while (cur.startsWith(APP_DIR)) {
    // Check error.tsx at this level (catches errors in this segment + children).
    if (existsSync(join(cur, "error.tsx"))) return join(cur, "error.tsx");
    // Check global-error.tsx at root (only valid at app/).
    if (cur === APP_DIR && existsSync(join(cur, "global-error.tsx"))) return join(cur, "global-error.tsx");
    cur = dirname(cur);
  }
  return null;
}

const layouts = findLayouts(APP_DIR);
let ok = true;

for (const layoutPath of layouts) {
  const dir = dirname(layoutPath);
  const rel = "/" + relative(APP_DIR, dir).replace(/\\/g, "/") || "/";
  const covering = findCovering(dir);

  if (covering) {
    const coverRel = "/" + relative(APP_DIR, covering).replace(/\\/g, "/");
    console.log(`OK       ${rel}/layout.tsx  (covered by ${coverRel})`);
  } else {
    console.error(`MISSING  ${rel}/layout.tsx  (no error boundary at this level or any ancestor)`);
    ok = false;
  }
}

if (ok) {
  console.log(`\nAll ${layouts.length} layout(s) covered by error boundaries. ✓`);
  process.exit(0);
}

console.error(
  "\nMissing error boundaries — add error.tsx to contain page crashes within the layout.\n" +
    "app/t/[team]/error.tsx is the template."
);
process.exit(1);
