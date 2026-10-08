import { readFileSync, readdirSync, statSync } from "node:fs";
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
  // The repair census (pure classifier + read-only reader) performs no provider request, but it is an
  // administrative reader with NO authorization of its own and a test-only options seam. Nothing in the
  // application may call it until an entry point that authorizes team administration exists.
  "lib/ingest/slack-repair-census.ts",
  "lib/ingest/slack-repair-census-read.ts",
  // The known-root requeue packet (AC-02, inactive) performs no provider request either, but its
  // preparer WRITES pending work under shared authority locks and decrypts a stored token locally,
  // with no caller authorization, no fairness lane and no deletion-safe publication behind it. No
  // route, action, script, scheduler or process start may reach either module, or its pure helpers.
  "lib/ingest/slack-known-root-page.ts",
  "lib/ingest/slack-known-root-requeue.ts",
];

/** The guarded modules an entry point of this tree can reach, each as the import chain that got there. */
function reachedGuarded(tree: ReadonlyMap<string, string>): string[] {
  const via = reach(importGraph(tree), entryPoints(tree));
  return GUARDED.filter((g) => via.has(g)).map((g) => chainTo(via, g));
}

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

/** The files a request, page, action, script or process start can begin from. */
function entryPoints(tree: ReadonlyMap<string, string>): string[] {
  // Root-level files (proxy.ts, instrumentation*.ts, sentry.*.config.ts, next.config.ts, …) are loaded by Next itself.
  return [...tree.keys()].filter((f) => /^(app|scripts)\//.test(f) || !f.includes("/"));
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
  for (const name of readdirSync(ROOT)) {
    const p = join(ROOT, name);
    if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.startsWith(".") && statSync(p).isFile()) tree.set(name, readFileSync(p, "utf8"));
  }
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
        `import { classifySlackRepairItem } from "./slack-repair-census";`,
        `export * from "@/lib/ingest/slack-repair-census-read";`,
        `import { readSlackKnownRootItemPage } from "./slack-known-root-page";`,
        `const requeue = await import("@/lib/ingest/slack-known-root-requeue");`,
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
    const roots = entryPoints(tree);
    const via = reach(importGraph(tree), roots);
    expect(tree.size).toBeGreaterThan(500);
    expect(roots.length).toBeGreaterThan(100);
    // Reached only by following a relative import AND an alias import: the traversal really walks both.
    expect(via.has("lib/ingest/index.ts")).toBe(true);
    expect(via.has("lib/ingest/slack-publication.ts")).toBe(true);
    expect(via.has("lib/ingest/slack-source-binding.ts")).toBe(true);
    for (const guarded of GUARDED) expect(tree.has(guarded), `${guarded} exists`).toBe(true);
  });

  it("treats every root-level file Next loads as an entry point (fix-review FX-03)", () => {
    // `proxy.ts` is Next's request-path entry and already imports `@/lib/auth/pg-session`; `instrumentation.ts`
    // dynamically imports `./sentry.server.config` / `./sentry.edge.config`. None of them sat under app/ or scripts/,
    // so an import of a guarded module from any of them was unreachable by construction, and the sentry edges were
    // silently dropped because those files were not in the tree at all.
    const tree = readTree();
    const roots = entryPoints(tree);
    for (const file of ["proxy.ts", "instrumentation.ts", "instrumentation-client.ts", "sentry.server.config.ts", "sentry.edge.config.ts"]) {
      expect(tree.has(file), `${file} is in the tree`).toBe(true);
      expect(roots, `${file} is a root`).toContain(file);
    }
    expect(importGraph(tree).get("instrumentation.ts")?.has("sentry.server.config.ts")).toBe(true);
  });

  it("reaches a guarded module from a root-level entry file such as proxy.ts (fold-review FF-02: pinned, not just mutated)", () => {
    const tree = new Map<string, string>([
      ["proxy.ts", `import "@/lib/ingest/slack-source-discovery";`],
      ["lib/ingest/slack-source-discovery.ts", ""],
    ]);
    expect(entryPoints(tree)).toContain("proxy.ts");
    const via = reach(importGraph(tree), entryPoints(tree));
    expect(chainTo(via, "lib/ingest/slack-source-discovery.ts")).toBe("proxy.ts → lib/ingest/slack-source-discovery.ts");
  });

  it("flags the repair census the moment an app/ entry point can reach it, directly or transitively", () => {
    const READER = "lib/ingest/slack-repair-census-read.ts";
    const PURE = "lib/ingest/slack-repair-census.ts";
    const census: [string, string][] = [
      [READER, `import { classifySlackRepairItem } from "./slack-repair-census";`],
      [PURE, ""],
    ];
    // Control: the two modules existing, importing each other and being imported by a test is not wiring.
    expect(
      reachedGuarded(
        new Map([
          ...census,
          ["test/datamechanics/slack-repair-census.datamechanics.test.ts", `import "@/lib/ingest/slack-repair-census-read";`],
          ["lib/ingest/unreferenced.ts", `import { readSlackRepairCensusPage } from "./slack-repair-census-read";`],
          ["app/api/v1/items/route.ts", `import { ingestItem } from "@/lib/ingest";`],
          ["lib/ingest/index.ts", `export { ingestItem } from "./run";`],
          ["lib/ingest/run.ts", ""],
        ])
      )
    ).toEqual([]);

    // Direct: a route (or a server action) importing the reader reaches it AND the classifier behind it.
    const route = "app/api/v1/admin/slack-repair-census/route.ts";
    expect(
      reachedGuarded(new Map([...census, [route, `import { readSlackRepairCensusPage } from "@/lib/ingest/slack-repair-census-read";`]]))
    ).toEqual([`${route} → ${READER} → ${PURE}`, `${route} → ${READER}`]);
    const action = "app/admin/actions.ts";
    expect(reachedGuarded(new Map([...census, [action, `const census = await import("@/lib/ingest/slack-repair-census");`]]))).toEqual([
      `${action} → ${PURE}`,
    ]);

    // Transitive: through a relative import, and through a re-export from the ingest index — the two
    // spellings a per-file pattern would have missed.
    const relative = new Map([
      ...census,
      ["app/admin/slack/page.tsx", `import { loadCensus } from "../../../lib/admin/slack-census";`],
      ["lib/admin/slack-census.ts", `import { readSlackRepairCensusPage } from "../ingest/slack-repair-census-read";`],
    ]);
    expect(reachedGuarded(relative)).toContain(`app/admin/slack/page.tsx → lib/admin/slack-census.ts → ${READER}`);
    const reexported = new Map([
      ...census,
      ["app/api/v1/items/route.ts", `import { ingestItem } from "@/lib/ingest";`],
      ["lib/ingest/index.ts", `export { readSlackRepairCensusPage } from "./slack-repair-census-read";`],
    ]);
    expect(reachedGuarded(reexported)).toEqual([
      `app/api/v1/items/route.ts → lib/ingest/index.ts → ${READER} → ${PURE}`,
      `app/api/v1/items/route.ts → lib/ingest/index.ts → ${READER}`,
    ]);
    // A script and a root-level file are entry points too.
    expect(reachedGuarded(new Map([...census, ["scripts/census.ts", `import "../lib/ingest/slack-repair-census-read";`]]))).toHaveLength(2);
    expect(reachedGuarded(new Map([...census, ["instrumentation.ts", `import "@/lib/ingest/slack-repair-census";`]]))).toEqual([
      `instrumentation.ts → ${PURE}`,
    ]);
  });

  it("flags the known-root requeue packet from every entry class and by every import spelling", () => {
    const PAGE = "lib/ingest/slack-known-root-page.ts";
    const REQUEUE = "lib/ingest/slack-known-root-requeue.ts";
    const packet: [string, string][] = [
      [REQUEUE, `import type { SlackKnownRootEntry } from "./slack-known-root-page";`],
      [PAGE, ""],
    ];
    // Control: the two modules existing, one importing the other, and tests or an unreferenced
    // library file importing them, is not wiring.
    expect(
      reachedGuarded(
        new Map([
          ...packet,
          ["test/slack-known-root-requeue.test.ts", `import { tallySlackKnownRootPage } from "@/lib/ingest/slack-known-root-requeue";`],
          ["test/datamechanics/slack-known-root-requeue.datamechanics.test.ts", `import "@/lib/ingest/slack-known-root-page";`],
          ["lib/ingest/unreferenced.ts", `import { prepareSlackKnownRootRequeue } from "./slack-known-root-requeue";`],
          ["app/api/v1/items/route.ts", `import { ingestItem } from "@/lib/ingest";`],
          ["lib/ingest/index.ts", `export { ingestItem } from "./run";`],
          ["lib/ingest/run.ts", ""],
        ])
      )
    ).toEqual([]);

    // A route by alias reaches the preparer AND the page module behind it; a pure helper is no exception.
    const route = "app/api/v1/admin/slack-requeue/route.ts";
    expect(
      reachedGuarded(new Map([...packet, [route, `import { classifySlackKnownRootPreparationFailure } from "@/lib/ingest/slack-known-root-requeue";`]]))
    ).toEqual([`${route} → ${REQUEUE} → ${PAGE}`, `${route} → ${REQUEUE}`]);
    // A server action by dynamic import, and by require.
    const action = "app/admin/actions.ts";
    expect(reachedGuarded(new Map([...packet, [action, `const page = await import("@/lib/ingest/slack-known-root-page");`]]))).toEqual([
      `${action} → ${PAGE}`,
    ]);
    expect(reachedGuarded(new Map([...packet, [action, `const page = require("../../lib/ingest/slack-known-root-page");`]]))).toEqual([
      `${action} → ${PAGE}`,
    ]);
    // A scheduler chain: a cron route, through the runner, by relative imports only.
    const scheduled = new Map([
      ...packet,
      ["app/api/cron/ingest/route.ts", `import { runIngest } from "@/lib/ingest/run";`],
      ["lib/ingest/run.ts", `import { sweepKnownRoots } from "./slack-known-root-sweep";`],
      ["lib/ingest/slack-known-root-sweep.ts", `import { prepareSlackKnownRootRequeue } from "./slack-known-root-requeue";`],
    ]);
    expect(reachedGuarded(scheduled)).toContain(
      `app/api/cron/ingest/route.ts → lib/ingest/run.ts → lib/ingest/slack-known-root-sweep.ts → ${REQUEUE}`
    );
    // A re-export from the ingest index, which a route already imports.
    const reexported = new Map([
      ...packet,
      ["app/api/v1/items/route.ts", `import { ingestItem } from "@/lib/ingest";`],
      ["lib/ingest/index.ts", `export { prepareSlackKnownRootRequeue } from "./slack-known-root-requeue";`],
    ]);
    expect(reachedGuarded(reexported)).toEqual([
      `app/api/v1/items/route.ts → lib/ingest/index.ts → ${REQUEUE} → ${PAGE}`,
      `app/api/v1/items/route.ts → lib/ingest/index.ts → ${REQUEUE}`,
    ]);
    // A script and a root-level instrumentation file are entry points too.
    expect(reachedGuarded(new Map([...packet, ["scripts/requeue-known-roots.ts", `import "../lib/ingest/slack-known-root-requeue";`]]))).toHaveLength(2);
    expect(reachedGuarded(new Map([...packet, ["instrumentation.ts", `import "@/lib/ingest/slack-known-root-page";`]]))).toEqual([
      `instrumentation.ts → ${PAGE}`,
    ]);
  });

  it("is reachable from no route, page, action, script or instrumentation entry point", () => {
    expect(reachedGuarded(readTree())).toEqual([]);
  });
});
