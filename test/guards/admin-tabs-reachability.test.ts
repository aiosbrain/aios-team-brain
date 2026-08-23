import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";


/**
 * Admin surface reachability guard (AGENTUI-1).
 *
 * WHY THIS EXISTS — a repeated, observed bug. Three times now a capability has shipped with no way
 * to reach it: the Skills catalog (built, deployed, 22 prod items, no nav entry for weeks),
 * `admin/agents` (mint/revoke server actions, no page, 0 tokens ever minted), and `admin/access`
 * (still in that state today). Nothing failed in any of the three, because nothing pinned them.
 *
 * TWO DIRECTIONS, because each catches a different half and the first alone is blind to the bug
 * that motivated this file:
 *   (a) a page with no tab   — built, but not linked;
 *   (b) an actions.ts export with no caller — built, but nothing calls it. This is the actual
 *       failure class, and a page→tab guard cannot see it.
 *
 * Direction (b) carries an explicit allowlist so known debt is documented rather than invisible, and
 * the allowlist is asserted to be EXACTLY the known set — so it cannot quietly grow, and it fails
 * once the debt is paid rather than lingering forever.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const ADMIN = join(ROOT, "app", "t", "[team]", "admin");
const TABS_FILE = join(ROOT, "components", "admin", "admin-tabs.tsx");

/**
 * Known-orphaned admin exports, keyed at EXPORTED-SYMBOL level rather than by directory — a
 * directory-level allowlist would exempt every other export in the same file, hiding the next
 * orphan behind a known one. Both entries below were found by this guard on its first run and are
 * pre-existing debt, deliberately not fixed by AGENTUI-1:
 *   - access/*      : the PCCA access-chain admin UI was never built (sibling of the agents gap).
 *   - linkMemberSlack: defined 2026-xx, referenced nowhere in app/, components/, lib/ or scripts/.
 * Asserted to equal the real set EXACTLY, so a new orphan fails the build and a fixed one forces
 * the entry to be removed rather than lingering as a lie.
 */
const ORPHAN_ALLOWLIST = [
  "access/actions.ts :: runContextBackfillAction",
  "members/actions.ts :: linkMemberSlack",
] as const;

function adminDirs(): string[] {
  return readdirSync(ADMIN).filter((n) => statSync(join(ADMIN, n)).isDirectory());
}

function tabSlugs(): string[] {
  // Comments are stripped first: a `// { slug: "agents" … }` line is NOT a shipped tab, and matching
  // it would let someone comment an entry out of the nav with direction (a) still green — the exact
  // "source text is not rendered output" hole this guard family keeps rediscovering.
  const src = readFileSync(TABS_FILE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return [...src.matchAll(/\{\s*slug:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** Exported server-action names declared in a directory's actions.ts. */
export function exportedActions(src: string): string[] {
  return [...src.matchAll(/export\s+async\s+function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

/** Every source file under the searched roots. A FILESYSTEM walk, deliberately not `git grep`:
 *  git grep skips UNTRACKED files, so a brand-new caller in the same commit reads as absent and the
 *  guard fails on the very change that fixes the orphan. (Observed on this file's first run.) */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(p)) out.push(p);
    }
  };
  for (const r of ["app", "components", "lib", "scripts"]) walk(join(ROOT, r));
  return out;
}

const SOURCES = sourceFiles();

/** Is `name` referenced anywhere outside its own defining file? */
function hasCaller(name: string, ownFile: string): boolean {
  const re = new RegExp(`\\b${name}\\b`);
  return SOURCES.some((f) => f !== ownFile && re.test(readFileSync(f, "utf8")));
}

/** Every `dir/actions.ts :: exportName` in the admin tree that nothing references. */
function orphanedExportKeys(): string[] {
  const out: string[] = [];
  for (const d of adminDirs()) {
    const f = join(ADMIN, d, "actions.ts");
    if (!existsSync(f)) continue;
    for (const name of exportedActions(readFileSync(f, "utf8"))) {
      if (!hasCaller(name, f)) out.push(`${d}/actions.ts :: ${name}`);
    }
  }
  return out;
}

describe("admin surface reachability", () => {
  it("sees a real admin tree and a real tab list (non-vacuity)", () => {
    expect(adminDirs().length).toBeGreaterThanOrEqual(10);
    expect(tabSlugs()).toContain("members");
  });

  it("(a) every admin page has a tab — a page nothing links to is unreachable", () => {
    const slugs = new Set(tabSlugs());
    const orphanPages = adminDirs()
      .filter((d) => existsSync(join(ADMIN, d, "page.tsx")))
      .filter((d) => !slugs.has(d));
    expect(
      orphanPages,
      `Admin pages with no entry in components/admin/admin-tabs.tsx — reachable only by typing the URL:\n${orphanPages.join("\n")}`
    ).toEqual([]);
  });

  it("(b) every admin server action has a caller — the Skills/agents failure class", () => {
    const orphans: string[] = [];
    for (const key of orphanedExportKeys()) {
      if (!(ORPHAN_ALLOWLIST as readonly string[]).includes(key)) orphans.push(key);
    }
    expect(
      orphans,
      `Admin server actions nothing calls — built capability with no surface:\n${orphans.join("\n")}`
    ).toEqual([]);
  });

  it("the orphan allowlist matches reality exactly, so paid-off debt cannot linger", () => {
    expect(
      orphanedExportKeys().sort(),
      "ORPHAN_ALLOWLIST must equal the exports that are actually orphaned — no more (silent debt), no fewer (stale entry claiming debt that was paid)"
    ).toEqual([...ORPHAN_ALLOWLIST].sort());
  });

  it("a commented-out tab does not count as shipped (non-vacuity)", () => {
    const stripped = 'const TABS = [\n  // { slug: "ghost", label: "Ghost" },\n  { slug: "real", label: "Real" },\n];'
      .replace(/^\s*\/\/.*$/gm, "");
    const slugs = [...stripped.matchAll(/\{\s*slug:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(slugs).toEqual(["real"]);
  });

  it("the export parser discriminates (non-vacuity)", () => {
    expect(exportedActions('export async function mintFoo(') ).toEqual(["mintFoo"]);
    expect(exportedActions('async function notExported(')).toEqual([]);
    expect(exportedActions('export const notAFunction = 1')).toEqual([]);
  });
});
