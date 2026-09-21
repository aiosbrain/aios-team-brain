import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AIO-1170 activation guard: the new Slack source pipeline is NOT reachable from any execution path yet.
 *
 * The discovery entrypoint, its channel state, the thread hydrator, the method budget and the real-HTTP page
 * transport perform provider requests against a real integration's token, and the slice they belong to is
 * deliberately incomplete — nothing publishes an item, nothing migrates a namespace, no capacity gate has been
 * certified. Wiring any of them into the runner, the scheduler, manual sync or an admin action would turn "the
 * code exists" into "the code runs against a production workspace", the one step this build must not take by
 * accident. Deleting this guard is the deliberate act that activation requires.
 *
 * WHY REACHABILITY, NOT A PER-FILE PATTERN. This used to grep every file for an import string containing
 * `ingest/<module>`. Review (P3-02 / P4-06) found that a RELATIVE import — `./slack-source-discovery` from
 * `lib/ingest/run.ts`, the exact spelling that file already uses for its neighbours — never contains `ingest/`,
 * so the wiring it exists to stop would have passed. It had already missed one: `slack-source-binding` was listed
 * as guarded while `app/api/v1/items/route.ts → lib/ingest/index.ts → slack-publication.ts → slack-source-binding.ts`
 * reached it. So this follows EVERY import spelling (static, `export … from`, side-effect, dynamic `import()`,
 * `require`, `@/` and relative) transitively from the real entry points, and fails with the chain that got there.
 *
 * `slack-source-binding` is deliberately NOT in the forbidden set: publication legitimately takes its lock helper,
 * and that path is DB-only and gated by a publication option nothing issues yet.
 */

const ROOT = join(import.meta.dirname, "..", "..");

/** Modules that talk to a real Slack workspace or drive the new pipeline. NONE may be reachable from an entry point. */
const GUARDED: readonly string[] = [
  "lib/ingest/slack-source-discovery.ts",
  "lib/ingest/slack-channel-state.ts",
  "lib/ingest/slack-thread-hydrator.ts",
  "lib/ingest/slack-method-budget.ts",
  "lib/ingest/sources/slack-page-request.ts",
];

const SPECIFIER =
  /(?:^|\n)\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every module specifier a source file names, in any of the import spellings. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

/** Resolve a `@/…` or relative specifier to a repo-relative file, or null for a package / unresolvable one. */
function resolveSpecifier(fromRel: string, spec: string, isFile: (rel: string) => boolean): string | null {
  const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? join(dirname(fromRel), spec) : null;
  if (base === null) return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find(isFile) ?? null;
}

/** file → the files it imports, for an in-memory `{ repo-relative path: source }` tree. */
function importGraph(tree: ReadonlyMap<string, string>): Map<string, Set<string>> {
  const isFile = (rel: string): boolean => tree.has(rel);
  const graph = new Map<string, Set<string>>();
  for (const [file, source] of tree) {
    const targets = new Set<string>();
    for (const spec of importSpecifiers(source)) {
      const resolved = resolveSpecifier(file, spec, isFile);
      if (resolved) targets.add(resolved);
    }
    graph.set(file, targets);
  }
  return graph;
}

/** Breadth-first from the roots; the value is the file that first reached each one, so a chain can be printed. */
function reach(graph: ReadonlyMap<string, ReadonlySet<string>>, roots: readonly string[]): Map<string, string | null> {
  const via = new Map<string, string | null>(roots.map((r) => [r, null]));
  const queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    for (const next of graph.get(queue[i]) ?? []) {
      if (!via.has(next)) {
        via.set(next, queue[i]);
        queue.push(next);
      }
    }
  }
  return via;
}

function chainTo(via: ReadonlyMap<string, string | null>, file: string): string {
  const chain: string[] = [];
  for (let cur: string | null | undefined = file; cur; cur = via.get(cur)) chain.push(cur);
  return chain.reverse().join(" → ");
}

function readTree(): Map<string, string> {
  const tree = new Map<string, string>();
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(p)) tree.set(relative(ROOT, p), readFileSync(p, "utf8"));
    }
  };
  for (const dir of ["app", "lib", "scripts", "components"]) walk(join(ROOT, dir));
  if (existsSync(join(ROOT, "instrumentation.ts"))) tree.set("instrumentation.ts", readFileSync(join(ROOT, "instrumentation.ts"), "utf8"));
  return tree;
}

describe("the Slack source pipeline is not wired to anything", () => {
  it("follows every import spelling to the module it names (negative control for the traversal itself)", () => {
    const tree = new Map<string, string>([
      ["lib/ingest/run.ts", [
        `import { a } from "./slack-source-discovery";`,
        `export { b } from "./slack-channel-state";`,
        `import "./sources/slack-page-request";`,
        `const h = await import("./slack-thread-hydrator");`,
        `const m = require("@/lib/ingest/slack-method-budget");`,
        `import type { T } from "./not-a-real-module";`,
        `import pg from "pg";`,
        `// import { x } from "./slack-source-binding";`,
      ].join("\n")],
      ["lib/ingest/multi.ts", `import {\n  one,\n  two,\n} from "./slack-source-discovery";`],
      ...GUARDED.map((g): [string, string] => [g, ""]),
      ["lib/ingest/slack-source-binding.ts", ""],
    ]);
    const graph = importGraph(tree);
    expect([...(graph.get("lib/ingest/run.ts") ?? [])].sort()).toEqual([...GUARDED].sort());
    expect([...(graph.get("lib/ingest/multi.ts") ?? [])]).toEqual(["lib/ingest/slack-source-discovery.ts"]);
    // A commented-out import is not an edge, and a bare package or unresolvable specifier is ignored.
    expect(graph.get("lib/ingest/run.ts")?.has("lib/ingest/slack-source-binding.ts")).toBe(false);
  });

  it("reaches a guarded module through a relative import from an entry point (the P3-02 / P4-06 hole)", () => {
    const tree = new Map<string, string>([
      ["app/api/v1/items/route.ts", `import { ingestItem } from "@/lib/ingest";`],
      ["lib/ingest/index.ts", `import { run } from "./run";`],
      ["lib/ingest/run.ts", `import { discover } from "./slack-source-discovery";`],
      ["lib/ingest/slack-source-discovery.ts", ""],
    ]);
    const via = reach(importGraph(tree), ["app/api/v1/items/route.ts"]);
    expect(via.has("lib/ingest/slack-source-discovery.ts")).toBe(true);
    expect(chainTo(via, "lib/ingest/slack-source-discovery.ts")).toBe(
      "app/api/v1/items/route.ts → lib/ingest/index.ts → lib/ingest/run.ts → lib/ingest/slack-source-discovery.ts",
    );
  });

  it("is not vacuous over the real tree: it reaches what is known to be reachable", () => {
    const tree = readTree();
    const roots = [...tree.keys()].filter((f) => /^(app|scripts)\//.test(f) || f === "instrumentation.ts");
    const via = reach(importGraph(tree), roots);
    expect(tree.size).toBeGreaterThan(500);
    expect(roots.length).toBeGreaterThan(100);
    // Reached only by following a relative import AND an alias import: the traversal really walks both.
    expect(via.has("lib/ingest/index.ts")).toBe(true);
    expect(via.has("lib/ingest/slack-publication.ts")).toBe(true);
    expect(via.has("lib/ingest/slack-source-binding.ts")).toBe(true);
    for (const guarded of GUARDED) expect(tree.has(guarded), `${guarded} exists`).toBe(true);
  });

  it("is reachable from no route, page, action, script or instrumentation entry point", () => {
    const tree = readTree();
    const roots = [...tree.keys()].filter((f) => /^(app|scripts)\//.test(f) || f === "instrumentation.ts");
    const via = reach(importGraph(tree), roots);
    const reached = GUARDED.filter((g) => via.has(g)).map((g) => chainTo(via, g));
    expect(reached).toEqual([]);
  });
});
