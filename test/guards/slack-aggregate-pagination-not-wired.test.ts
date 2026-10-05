import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { PR743_PINNED_HEAD, PR743_PINNED_PATHS } from "./slack-aggregate-pagination-pr743-paths";

/**
 * AIO-1170 AC-09 activation and ownership guard for the aggregate Slack pagination packet.
 *
 * Two different promises, both mechanical:
 *
 *  1. NOT WIRED. The aggregate page reader, its continuation contract and the complete-drain adapter
 *     are inactive capabilities. No route, page, action, script or process-start file may reach any
 *     of them, by any import spelling, directly or transitively — and nothing outside the packet may
 *     import them at all. The pure modules are guarded as well: "it only validates a cursor" is how
 *     an unreviewed continuation contract ends up on an HTTP route.
 *
 *  2. PATH-DISJOINT FROM PR 743. That pull request separately owns 226 paths, including the shared
 *     data-mechanics helpers and setup, the active timeline builder and cache, the identity writers
 *     and the transaction internals. This packet may not change one of them — a test helper counts
 *     exactly as a production file does.
 *
 * `test/guards/slack-source-not-wired.test.ts` keeps guarding the source pipeline, unchanged. This
 * file is self-contained on purpose: the shared entry-surface helper is one of the 226 paths.
 */

const ROOT = join(import.meta.dirname, "..", "..");

const PAGE_READ = "lib/ingest/slack-person-day-page-read.ts";
const CONTRACT = "lib/dashboard/slack-timeline-page-contract.ts";
const DRAIN = "lib/dashboard/slack-timeline-drain.ts";

/** The three packet modules. NONE may be reachable from an entry point or imported from outside the packet. */
const GUARDED: readonly string[] = [PAGE_READ, CONTRACT, DRAIN];

/** Every path this packet owns. A new packet file is added here, and is then gated like the rest. */
const PACKET_PATHS: readonly string[] = [
  ...GUARDED,
  "test/slack-timeline-page-contract.test.ts",
  "test/slack-timeline-drain.test.ts",
  "test/datamechanics/slack-person-day-page-read.datamechanics.test.ts",
  "test/guards/slack-aggregate-pagination-not-wired.test.ts",
  "test/guards/slack-aggregate-pagination-pr743-paths.ts",
];

// ── the path gate ────────────────────────────────────────────────────────────

/**
 * Both names of every changed path in `git diff --name-status -M -C` output: a rename or copy is a
 * change to its OLD name as well, so moving a PR 743 file away is caught exactly as editing it is.
 */
function pathsFromNameStatus(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const [status, ...names] = line.split("\t");
    const expectedNames = /^[RC]/.test(status) ? 2 : 1;
    if (!/^[ACDMRTUXB]\d*$/.test(status) || names.length !== expectedNames || names.some((name) => name === "")) {
      throw new Error("path gate: unreadable git name-status evidence");
    }
    paths.push(...names);
  }
  return paths;
}

/** The changed paths that PR 743 owns. Missing or malformed evidence throws: the gate fails closed. */
function pr743Intersection(evidence: { changedPaths: unknown; pinnedPaths: unknown }): string[] {
  const { changedPaths, pinnedPaths } = evidence ?? ({} as { changedPaths: unknown; pinnedPaths: unknown });
  const isPathList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((path) => typeof path === "string" && path !== "" && !path.startsWith("/"));
  if (!isPathList(changedPaths)) throw new Error("path gate: missing changed-path evidence");
  if (!isPathList(pinnedPaths) || pinnedPaths.length === 0) throw new Error("path gate: missing PR 743 readback evidence");
  const pinned = new Set(pinnedPaths);
  return [...new Set(changedPaths)].filter((path) => pinned.has(path)).sort();
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The union the specification names: committed since the packet base, staged, unstaged and untracked. */
function packetChangedPaths(base: string): string[] {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("path gate: the packet base must be a full commit id");
  git(["cat-file", "-e", `${base}^{commit}`]);
  return [...new Set([
    ...pathsFromNameStatus(git(["diff", "--name-status", "-M", "-C", `${base}...HEAD`])),
    ...pathsFromNameStatus(git(["diff", "--name-status", "-M", "-C", "--cached"])),
    ...pathsFromNameStatus(git(["diff", "--name-status", "-M", "-C"])),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter((path) => path !== ""),
  ])].sort();
}

// ── import reachability ──────────────────────────────────────────────────────

/**
 * The four import spellings. NONE is anchored to a line start: `import a from "./a"; import b from "./b";`
 * is two imports, and a line-anchored pattern sees only the first (red review, finding 2).
 *
 * The scan is deliberately over the RAW source and therefore fails closed: a commented-out import of
 * a guarded module counts as an edge. Blanking comments first would need a real tokenizer — a regular
 * expression literal that contains a slash followed by an asterisk reads as a comment opener to
 * anything simpler, and would hide every import after it. An unwired capability that is "one uncomment away" from a route is worth a
 * failing guard; a silently missed import is not an acceptable price for tidier output.
 *
 * The static form may not cross a quote, backtick or semicolon between its keyword and `from`, so it
 * can never swallow another statement's string — in particular a dynamic `import("…")` in between.
 */
const SPECIFIER =
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)|\brequire\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g;

/** Every module specifier a source file names, in any of the import spellings, in source order. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

/** Every module file extension the tree scan reads and the resolver can land on. */
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** What TypeScript's `bundler` resolution loads for a JavaScript-extension specifier. */
const TS_FOR_JS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/**
 * Resolve a `@/…` or relative specifier to a repo-relative file, or null for a package / unresolvable
 * one. `./drain.js` names `./drain.ts` when that is the file that exists — the spelling ESM-style
 * TypeScript uses, and one an extension-appending resolver never matches (red review, finding 2).
 */
function resolveSpecifier(fromRel: string, spec: string, isFile: (rel: string) => boolean): string | null {
  const base = spec.startsWith("@/") ? normalize(spec.slice(2)) : spec.startsWith(".") ? join(dirname(fromRel), spec) : null;
  if (base === null) return null;
  const jsExtension = /\.(?:js|jsx|mjs|cjs)$/.exec(base)?.[0];
  const rewritten = jsExtension ? TS_FOR_JS[jsExtension].map((to) => `${base.slice(0, -jsExtension.length)}${to}`) : [];
  const candidates = [
    base, ...rewritten,
    `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${base}.mjs`, `${base}.cjs`, `${base}.js`, `${base}.jsx`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.mjs`, `${base}/index.js`,
  ];
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
  return [...tree.keys()].filter((f) => /^(app|scripts)\//.test(f) || !f.includes("/"));
}

/** The guarded modules an entry point of this tree can reach, each as the import chain that got there. */
function reachedGuarded(tree: ReadonlyMap<string, string>): string[] {
  const via = reach(importGraph(tree), entryPoints(tree));
  return GUARDED.filter((g) => via.has(g)).map((g) => chainTo(via, g));
}

/** `importer → guarded` for every import of a guarded module from OUTSIDE the packet. */
function outsideImporters(tree: ReadonlyMap<string, string>): string[] {
  const edges: string[] = [];
  for (const [file, targets] of importGraph(tree)) {
    if (GUARDED.includes(file)) continue;
    for (const target of targets) if (GUARDED.includes(target)) edges.push(`${file} → ${target}`);
  }
  return edges.sort();
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
      else if (SOURCE_FILE.test(p)) tree.set(relative(ROOT, p), readFileSync(p, "utf8"));
    }
  };
  for (const dir of ["app", "lib", "scripts", "components"]) walk(join(ROOT, dir));
  for (const name of readdirSync(ROOT)) {
    const p = join(ROOT, name);
    if (SOURCE_FILE.test(name) && !name.startsWith(".") && statSync(p).isFile()) tree.set(name, readFileSync(p, "utf8"));
  }
  return tree;
}

const stubs = (): [string, string][] => GUARDED.map((g): [string, string] => [g, ""]);

describe("the aggregate Slack pagination packet touches no PR 743 path", () => {
  it("pins the saved PR 743 readback: 226 unique repo-relative paths at a full commit id", () => {
    expect(PR743_PINNED_HEAD).toMatch(/^[0-9a-f]{40}$/);
    expect(PR743_PINNED_PATHS).toHaveLength(226);
    expect(new Set(PR743_PINNED_PATHS).size).toBe(226);
    expect([...PR743_PINNED_PATHS]).toEqual([...PR743_PINNED_PATHS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const path of PR743_PINNED_PATHS) {
      expect(path, path).not.toMatch(/^\/|\\|^\s|\s$|^$/);
    }
    // The files a careless helper edit or "small shared fix" would actually touch.
    for (const owned of [
      "test/datamechanics/helpers.ts", "test/datamechanics/setup.ts", "test/guards/entry-surface-graph.ts",
      "lib/dashboard/work-timeline.ts", "lib/dashboard/timeline-cache.ts", "lib/dashboard/timeline-group.ts",
      "lib/db/pg/tx.ts", "lib/db/pg/client.ts", "lib/db/types.ts", "lib/identity/resolve.ts",
      "lib/identity/member-identities.ts", "lib/identity/provider-sync.ts", "lib/access/authorization-epoch.ts",
      "lib/ingest/attribution-correction.ts", "lib/ingest/index.ts", "lib/ingest/run.ts", "postgres/schema.sql",
      "scripts/dm-isolated.sh", "instrumentation.ts",
    ]) expect(PR743_PINNED_PATHS, owned).toContain(owned);
  });

  it.runIf(existsSync(join(ROOT, ".context/aio-1170-resume/slack-aggregate-pagination-astra-spec.md")))(
    "matches the accepted specification's list exactly, where that ignored artifact is present",
    () => {
      const spec = readFileSync(join(ROOT, ".context/aio-1170-resume/slack-aggregate-pagination-astra-spec.md"), "utf8");
      const section = spec.slice(spec.indexOf("### Pinned PR743 path list"));
      const block = /```text\n([\s\S]*?)\n```/.exec(section);
      expect(block, "the specification's pinned list is a fenced text block").not.toBeNull();
      expect(block![1].split("\n")).toEqual([...PR743_PINNED_PATHS]);
    }
  );

  it("declares packet paths that are all outside the pinned list", () => {
    expect(new Set(PACKET_PATHS).size).toBe(PACKET_PATHS.length);
    expect(pr743Intersection({ changedPaths: PACKET_PATHS, pinnedPaths: PR743_PINNED_PATHS })).toEqual([]);
    // The four red-test paths and the path fixture exist; so must the three modules they describe.
    for (const path of PACKET_PATHS) expect(existsSync(join(ROOT, path)), `${path} exists`).toBe(true);
  });

  it("fails the moment a shared data-mechanics helper is inserted into the packet's changes (negative control)", () => {
    const gate = (changedPaths: string[]) => pr743Intersection({ changedPaths, pinnedPaths: PR743_PINNED_PATHS });
    expect(gate([...PACKET_PATHS, "test/datamechanics/helpers.ts"])).toEqual(["test/datamechanics/helpers.ts"]);
    expect(gate([...PACKET_PATHS, "test/datamechanics/setup.ts"])).toEqual(["test/datamechanics/setup.ts"]);
    expect(gate(["test/datamechanics/setup.ts", "lib/dashboard/work-timeline.ts", "test/datamechanics/helpers.ts", "docs/unrelated.md"])).toEqual([
      "lib/dashboard/work-timeline.ts", "test/datamechanics/helpers.ts", "test/datamechanics/setup.ts",
    ]);
    // A test helper is not "only a test": it fails exactly as a production file does.
    expect(gate(["lib/db/pg/tx.ts"])).toHaveLength(1);
    expect(gate(["test/guards/entry-surface-graph.ts"])).toHaveLength(1);
    // Near misses are not matches: the gate compares whole paths.
    expect(gate(["test/datamechanics/helpers.ts.bak", "test/datamechanics/slack-source-helpers.ts", "datamechanics/helpers.ts"])).toEqual([]);
  });

  it("checks BOTH names of a rename or copy", () => {
    const evidence = [
      "M\tlib/ingest/slack-person-day-page-read.ts",
      "A\ttest/slack-timeline-drain.test.ts",
      "R087\ttest/datamechanics/helpers.ts\ttest/datamechanics/slack-aggregate-helpers.ts",
      "C100\tlib/ingest/slack-source-page-read.ts\tlib/db/pg/tx.ts",
      "D\tlib/dashboard/timeline-cache.ts",
      "",
    ].join("\n");
    const changed = pathsFromNameStatus(evidence);
    expect(changed).toContain("test/datamechanics/helpers.ts");
    expect(changed).toContain("test/datamechanics/slack-aggregate-helpers.ts");
    expect(pr743Intersection({ changedPaths: changed, pinnedPaths: PR743_PINNED_PATHS })).toEqual([
      "lib/dashboard/timeline-cache.ts", "lib/db/pg/tx.ts", "test/datamechanics/helpers.ts",
    ]);
  });

  it("fails closed on missing or malformed evidence instead of reporting an empty intersection", () => {
    for (const changedPaths of [undefined, null, "test/datamechanics/helpers.ts", [42], [""], ["/abs/test/datamechanics/helpers.ts"]]) {
      expect(() => pr743Intersection({ changedPaths, pinnedPaths: PR743_PINNED_PATHS })).toThrow(/changed-path evidence/);
    }
    for (const pinnedPaths of [undefined, null, [], "paths", [42]]) {
      expect(() => pr743Intersection({ changedPaths: [...PACKET_PATHS], pinnedPaths })).toThrow(/readback evidence/);
    }
    expect(() => pr743Intersection(undefined as never)).toThrow();
    for (const unreadable of ["lib/a.ts", "M", "R100\told-only", "Z\tlib/a.ts", "M\t"]) {
      expect(() => pathsFromNameStatus(unreadable)).toThrow(/name-status/);
    }
    expect(pathsFromNameStatus("")).toEqual([]);
    expect(() => packetChangedPaths("82f8fab")).toThrow(/full commit id/);
    expect(() => packetChangedPaths("0".repeat(40))).toThrow();
  });

  // The live gate reads this checkout's Git state, so it runs only when the packet base is named.
  // Run permanently it would misfire on every later, unrelated change to a PR 743 path.
  it.runIf(Boolean(process.env.SLACK_AGGREGATE_PACKET_BASE))(
    "has an empty intersection for everything changed since the named packet base (live Git evidence)",
    () => {
      const changed = packetChangedPaths(String(process.env.SLACK_AGGREGATE_PACKET_BASE));
      expect(changed.length, "the packet has changed paths").toBeGreaterThan(0);
      expect(pr743Intersection({ changedPaths: changed, pinnedPaths: PR743_PINNED_PATHS })).toEqual([]);
    }
  );
});

describe("the aggregate Slack pagination packet is not wired to anything", () => {
  it("follows every import spelling to each guarded module (negative control for the traversal itself)", () => {
    const tree = new Map<string, string>([
      ["lib/dashboard/work-timeline.ts", [
        `import { readSlackPersonDayPage } from "@/lib/ingest/slack-person-day-page-read";`,
        `export { drainSlackTimeline } from "./slack-timeline-drain";`,
        `import "./slack-timeline-page-contract";`,
        `import type { T } from "./not-a-real-module";`,
        `import pg from "pg";`,
        `// import { x } from "./slack-timeline-drain-commented";`,
      ].join("\n")],
      ["lib/dashboard/dynamic.ts", `const d = await import("./slack-timeline-drain");\nconst c = require("@/lib/dashboard/slack-timeline-page-contract");`],
      ["lib/ingest/multi.ts", `import {\n  one,\n  two,\n} from "./slack-person-day-page-read";`],
      ["lib/ingest/star.ts", `export * from "../dashboard/slack-timeline-page-contract";`],
      ...stubs(),
    ]);
    const graph = importGraph(tree);
    expect([...(graph.get("lib/dashboard/work-timeline.ts") ?? [])].sort()).toEqual([...GUARDED].sort());
    expect([...(graph.get("lib/dashboard/dynamic.ts") ?? [])].sort()).toEqual([CONTRACT, DRAIN].sort());
    expect([...(graph.get("lib/ingest/multi.ts") ?? [])]).toEqual([PAGE_READ]);
    expect([...(graph.get("lib/ingest/star.ts") ?? [])]).toEqual([CONTRACT]);
    expect(outsideImporters(tree)).toHaveLength(7);
  });

  it("sees a second static import on the same source line (red review counterexample)", () => {
    const entry = "app/api/v1/timeline/route.ts";
    for (const guarded of GUARDED) {
      const spec = `@/${guarded.replace(/\.ts$/, "")}`;
      // The exact shape the review ran: an innocent import, then the guarded one, on ONE line.
      const line = `import { a } from "@/lib/innocent"; import { b } from "${spec}";`;
      expect(importSpecifiers(line)).toEqual(["@/lib/innocent", spec]);
      const tree = new Map<string, string>([...stubs(), ["lib/innocent.ts", ""], [entry, line]]);
      expect(reachedGuarded(tree), guarded).toEqual([`${entry} → ${guarded}`]);
      expect(outsideImporters(tree), guarded).toEqual([`${entry} → ${guarded}`]);
    }
    // Position on the line does not matter, nor does the spelling of the later statements.
    const crowded = [
      `const first = 1; import one from "./one"; export { two } from "./two"; import "./three"; const four = await import("./four"); const five = require("./five");`,
      `export const x = 1; import six from "./six"`,
    ].join("\n");
    expect(importSpecifiers(crowded)).toEqual(["./one", "./two", "./three", "./four", "./five", "./six"]);
    // A static form never swallows a dynamic import that sits between its keyword and a later `from`.
    expect(importSpecifiers('export function load() { return import(`./lazy`) }\nimport late from "./late";')).toEqual(["./lazy", "./late"]);
    // Transitively as well: the same-line import is in a module the route reaches.
    const transitive = new Map<string, string>([
      ...stubs(),
      ["lib/innocent.ts", ""],
      [entry, `import { load } from "@/lib/dashboard/loader";`],
      ["lib/dashboard/loader.ts", `import { a } from "../innocent"; import { drainSlackTimeline } from "./slack-timeline-drain";`],
    ]);
    expect(reachedGuarded(transitive)).toEqual([`${entry} → lib/dashboard/loader.ts → ${DRAIN}`]);
    expect(outsideImporters(transitive)).toEqual([`lib/dashboard/loader.ts → ${DRAIN}`]);
  });

  it("resolves a .js specifier to the guarded .ts module TypeScript loads for it (red review counterexample)", () => {
    const entry = "app/api/v1/timeline/route.ts";
    // The exact shape the review ran.
    const reviewed = new Map<string, string>([...stubs(), [entry, `import { drainSlackTimeline } from "@/lib/dashboard/slack-timeline-drain.js";`]]);
    expect(reachedGuarded(reviewed)).toEqual([`${entry} → ${DRAIN}`]);
    expect(outsideImporters(reviewed)).toEqual([`${entry} → ${DRAIN}`]);

    const spellings: [string, (guarded: string) => string][] = [
      ["an alias static import", (g) => `import { x } from "@/${g.replace(/\.ts$/, ".js")}";`],
      ["a relative static import", (g) => `import { x } from "../../../../${g.replace(/\.ts$/, ".js")}";`],
      ["a dynamic import", (g) => `const m = await import("@/${g.replace(/\.ts$/, ".js")}");`],
      ["a template-literal dynamic import", (g) => `const m = await import(\`@/${g.replace(/\.ts$/, ".js")}\`);`],
      ["a re-export", (g) => `export * from "@/${g.replace(/\.ts$/, ".js")}";`],
      ["a side-effect import", (g) => `import "@/${g.replace(/\.ts$/, ".js")}";`],
      ["a require", (g) => `const m = require("@/${g.replace(/\.ts$/, ".js")}");`],
      ["an un-normalized alias path", (g) => `import { x } from "@/./lib/../${g.replace(/\.ts$/, ".js")}";`],
    ];
    for (const [label, spell] of spellings) {
      for (const guarded of GUARDED) {
        const tree = new Map<string, string>([...stubs(), ["app/t/[team]/timeline/page.tsx", spell(guarded)]]);
        expect(reachedGuarded(tree), `${label}: ${guarded}`).toEqual([`app/t/[team]/timeline/page.tsx → ${guarded}`]);
        expect(outsideImporters(tree), `${label}: ${guarded}`).toEqual([`app/t/[team]/timeline/page.tsx → ${guarded}`]);
      }
    }
    // The other JavaScript extensions map the way TypeScript maps them, and a real .js file still wins.
    const isFile = (files: string[]) => (rel: string): boolean => files.includes(rel);
    expect(resolveSpecifier("lib/a.ts", "./b.js", isFile(["lib/b.tsx"]))).toBe("lib/b.tsx");
    expect(resolveSpecifier("lib/a.ts", "./b.jsx", isFile(["lib/b.tsx"]))).toBe("lib/b.tsx");
    expect(resolveSpecifier("lib/a.ts", "./b.mjs", isFile(["lib/b.mts"]))).toBe("lib/b.mts");
    expect(resolveSpecifier("lib/a.ts", "./b.cjs", isFile(["lib/b.cts"]))).toBe("lib/b.cts");
    expect(resolveSpecifier("lib/a.ts", "./b.js", isFile(["lib/b.js", "lib/b.ts"]))).toBe("lib/b.js");
    expect(resolveSpecifier("lib/a.ts", "./b.js", isFile(["lib/c.ts"]))).toBeNull();
    expect(resolveSpecifier("lib/a.ts", "pg", isFile(["pg.ts"]))).toBeNull();
    // Both counterexamples at once, through a chain.
    const both = new Map<string, string>([
      ...stubs(),
      ["lib/innocent.ts", ""],
      [entry, `import { a } from "@/lib/innocent.js"; import { load } from "@/lib/dashboard/loader.js";`],
      ["lib/dashboard/loader.ts", `import { a } from "../innocent.js"; export { readSlackPersonDayPage } from "../ingest/slack-person-day-page-read.js";`],
    ]);
    expect(reachedGuarded(both)).toEqual([`${entry} → lib/dashboard/loader.ts → ${PAGE_READ}`]);
    expect(outsideImporters(both)).toEqual([`lib/dashboard/loader.ts → ${PAGE_READ}`]);
  });

  it("fails closed on a commented-out import of a guarded module, and ignores what it cannot resolve", () => {
    const entry = "scripts/drain-slack.ts";
    for (const comment of [
      `// import { drainSlackTimeline } from "@/lib/dashboard/slack-timeline-drain";`,
      `/* const d = await import("@/lib/dashboard/slack-timeline-drain"); */`,
      `const url = "https://example.com"; // import "@/lib/dashboard/slack-timeline-drain.js";`,
    ]) {
      const tree = new Map<string, string>([...stubs(), [entry, comment]]);
      // One uncomment away from wired is reported, not waved through.
      expect(reachedGuarded(tree), comment).toEqual([`${entry} → ${DRAIN}`]);
    }
    // Prose, packages, unresolvable paths and non-literal specifiers are not edges.
    const inert = new Map<string, string>([
      ...stubs(),
      [entry, [
        `// the drain adapter lives in lib/dashboard/slack-timeline-drain.ts`,
        `import pg from "pg";`,
        `import { x } from "./slack-timeline-drain";`, // relative to scripts/: no such file
        `const m = await import(name);`,
        "const n = await import(`@/lib/dashboard/${name}`);",
      ].join("\n")],
    ]);
    expect(reachedGuarded(inert)).toEqual([]);
    expect(outsideImporters(inert)).toEqual([]);
  });

  it("treats the packet's own modules importing each other, and tests importing them, as not wiring (control)", () => {
    const tree = new Map<string, string>([
      [PAGE_READ, `import { encodeSlackTimelineCursor } from "@/lib/dashboard/slack-timeline-page-contract";`],
      [DRAIN, `import { mergeSlackTimelineDays } from "./slack-timeline-page-contract";`],
      [CONTRACT, `import { mergeTimelineSlackContinuation } from "./timeline-continuation-merge";`],
      ["lib/dashboard/timeline-continuation-merge.ts", ""],
      ["test/slack-timeline-drain.test.ts", `import "@/lib/dashboard/slack-timeline-drain";`],
      ["app/api/v1/timeline/route.ts", `import { buildTimeline } from "@/lib/dashboard/work-timeline";`],
      ["lib/dashboard/work-timeline.ts", `import { mergeTimelineSlackContinuation } from "./timeline-continuation-merge";`],
    ]);
    expect(reachedGuarded(tree)).toEqual([]);
    // The test file is not production: only app/lib/scripts/components and root files are scanned
    // by the real-tree check, and this synthetic tree shows the outside-importer rule sees it.
    expect(outsideImporters(tree)).toEqual([`test/slack-timeline-drain.test.ts → ${DRAIN}`]);
  });

  it.each([
    ["an alias import from a v1 route", "app/api/v1/timeline/route.ts", (g: string) => `import { x } from "@/${g.replace(/\.ts$/, "")}";`],
    ["a relative import from a page", "app/t/[team]/timeline/page.tsx", (g: string) => `import { x } from "../../../../${g.replace(/\.ts$/, "")}";`],
    ["a dynamic import from a server action", "app/t/[team]/actions.ts", (g: string) => `const m = await import("@/${g.replace(/\.ts$/, "")}");`],
    ["a re-export from a script", "scripts/drain-slack.ts", (g: string) => `export * from "../${g.replace(/\.ts$/, "")}";`],
    ["a require from a script", "scripts/drain-slack.mjs", (g: string) => `const m = require("../${g}");`],
    ["a side-effect import from root instrumentation", "instrumentation.ts", (g: string) => `import "@/${g.replace(/\.ts$/, "")}";`],
    ["an import from the request proxy", "proxy.ts", (g: string) => `import { x } from "./${g.replace(/\.ts$/, "")}";`],
  ])("flags each guarded module reached directly through %s", (_label, entry, spell) => {
    for (const guarded of GUARDED) {
      const tree = new Map<string, string>([...stubs(), [entry, spell(guarded)]]);
      expect(reachedGuarded(tree), `${entry} → ${guarded}`).toEqual([`${entry} → ${guarded}`]);
      expect(outsideImporters(tree)).toEqual([`${entry} → ${guarded}`]);
    }
  });

  it("flags a guarded module reached transitively through the active timeline, its cache, a re-export or the Slack source", () => {
    const viaBuilder = new Map<string, string>([
      ...stubs(),
      [DRAIN, `import { assertSlackTimelinePageProtocol } from "./slack-timeline-page-contract";`],
      ["app/api/v1/timeline/route.ts", `import { getTimeline } from "@/lib/dashboard/timeline-cache";`],
      ["lib/dashboard/timeline-cache.ts", `import { buildTimeline } from "./work-timeline";`],
      ["lib/dashboard/work-timeline.ts", `import { drainSlackTimeline } from "./slack-timeline-drain";`],
    ]);
    expect(reachedGuarded(viaBuilder)).toEqual([
      `app/api/v1/timeline/route.ts → lib/dashboard/timeline-cache.ts → lib/dashboard/work-timeline.ts → ${DRAIN} → ${CONTRACT}`,
      `app/api/v1/timeline/route.ts → lib/dashboard/timeline-cache.ts → lib/dashboard/work-timeline.ts → ${DRAIN}`,
    ]);

    const viaIndex = new Map<string, string>([
      ...stubs(),
      ["app/api/v1/items/route.ts", `import { ingestItem } from "@/lib/ingest";`],
      ["lib/ingest/index.ts", `export { readSlackPersonDayPage } from "./slack-person-day-page-read";`],
    ]);
    expect(reachedGuarded(viaIndex)).toEqual([`app/api/v1/items/route.ts → lib/ingest/index.ts → ${PAGE_READ}`]);

    const viaSource = new Map<string, string>([
      ...stubs(),
      ["scripts/sync.ts", `import "../lib/ingest/run";`],
      ["lib/ingest/run.ts", `import { readSlackSourceEvidencePage } from "./slack-source-evidence-page-read";`],
      ["lib/ingest/slack-source-evidence-page-read.ts", `import { readSlackPersonDayPage } from "./slack-person-day-page-read";`],
    ]);
    expect(reachedGuarded(viaSource)).toEqual([
      `scripts/sync.ts → lib/ingest/run.ts → lib/ingest/slack-source-evidence-page-read.ts → ${PAGE_READ}`,
    ]);

    const viaComponent = new Map<string, string>([
      ...stubs(),
      ["app/t/[team]/page.tsx", `import { Panel } from "@/components/dashboard/panel";`],
      ["components/dashboard/panel.tsx", `import { assertSlackTimelineBindingUnchanged } from "@/lib/dashboard/slack-timeline-page-contract";`],
    ]);
    expect(reachedGuarded(viaComponent)).toEqual([`app/t/[team]/page.tsx → components/dashboard/panel.tsx → ${CONTRACT}`]);
  });

  it("is not vacuous over the real tree: the traversal reaches what is known to be reachable", () => {
    const tree = readTree();
    const roots = entryPoints(tree);
    const via = reach(importGraph(tree), roots);
    expect(tree.size).toBeGreaterThan(500);
    expect(roots.length).toBeGreaterThan(100);
    // The active surfaces this packet must stay out of are themselves reachable and scanned.
    for (const active of [
      "lib/dashboard/work-timeline.ts", "lib/dashboard/timeline-cache.ts", "lib/ingest/index.ts", "lib/access/enforce.ts",
    ]) expect(via.has(active), `${active} is reachable`).toBe(true);
    // The shared pure merger the packet reuses is in the scanned tree, and is itself still inactive.
    expect(tree.has("lib/dashboard/timeline-continuation-merge.ts")).toBe(true);
    for (const root of ["proxy.ts", "instrumentation.ts"]) expect(roots, `${root} is a root`).toContain(root);
    // The guarded modules exist: a guard over files that are not there proves nothing.
    for (const guarded of GUARDED) expect(tree.has(guarded), `${guarded} exists`).toBe(true);
  });

  it("is reachable from no route, page, action, script or instrumentation entry point", () => {
    expect(reachedGuarded(readTree())).toEqual([]);
  });

  it("is imported by nothing outside the packet — not the builder, the cache, the UI, v1 or the Slack source", () => {
    expect(outsideImporters(readTree())).toEqual([]);
  });

  it("keeps the packet's own imports inside its inactive boundary", () => {
    const tree = readTree();
    const graph = importGraph(tree);
    for (const guarded of GUARDED) expect(tree.has(guarded), `${guarded} exists`).toBe(true);
    // The contract is the pure base: it imports neither sibling, no database and no server-only code.
    const contractImports = [...(graph.get(CONTRACT) ?? [])];
    expect(contractImports).not.toContain(PAGE_READ);
    expect(contractImports).not.toContain(DRAIN);
    for (const pure of [CONTRACT, DRAIN]) {
      const source = tree.get(pure) ?? "";
      expect(importSpecifiers(source).filter((spec) => /^(@\/lib\/db|@\/lib\/ingest|@\/lib\/access|server-only$|pg$)/.test(spec)), pure).toEqual([]);
      expect(source, `${pure} reads no environment`).not.toMatch(/process\.env/);
    }
    // No module of the packet imports the ACTIVE builder, cache, HTTP Slack client, runner or scheduler.
    const active = [
      "lib/dashboard/work-timeline.ts", "lib/dashboard/timeline-cache.ts", "lib/ingest/sources/slack.ts",
      "lib/ingest/run.ts", "lib/ingest/index.ts", "lib/ingest/scheduler.ts", "lib/ingest/slack-source-discovery.ts",
      "lib/ingest/slack-thread-hydrator.ts", "lib/ingest/slack-publication.ts",
    ];
    for (const guarded of GUARDED) {
      const direct = [...(graph.get(guarded) ?? [])];
      for (const file of active) expect(direct, `${guarded} must not import ${file}`).not.toContain(file);
    }
    // The cursor key is injected: no source of the packet names an environment variable or a literal key.
    for (const guarded of GUARDED) expect(tree.get(guarded) ?? "", guarded).not.toMatch(/process\.env|SECRETS_KEY/);
    // The page reader is the only module that owns a transaction, and it opens a read-only one.
    expect(tree.get(PAGE_READ) ?? "").toMatch(/REPEATABLE READ, READ ONLY/);
    expect(tree.get(PAGE_READ) ?? "").toMatch(/^import "server-only";/);
  });
});
