import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";
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
 * Imports are read from the SYNTAX TREE the installed TypeScript compiler builds, and resolved by the
 * installed TypeScript module resolver under this repository's own compiler options.
 *
 * Two review rounds each found VALID imports that a text pattern missed: a second import on one
 * line, a `.js` specifier naming a `.ts` module, a comment between `import(` and its string, a quoted
 * comment before `from`. A parser has none of those cases. A comment is trivia wherever it sits, so
 * it can neither hide an import nor be mistaken for one; a string that merely contains the word
 * `import` is a string. What the compiler would load is what this guard follows.
 */
function importSpecifiers(file: string, source: string): string[] {
  // The file name selects the grammar (TSX for `.tsx`, JavaScript for `.mjs`), exactly as the compiler does.
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const add = (node: ts.Node | undefined): void => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) found.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier); // static, side-effect, type-only, `export … from`, `export * from`
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression); // `import x = require("…")`
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal); // `typeof import("…")` in a type position: still a dependency edge
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const dynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(callee) && callee.text === "require";
      const requireMember = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "require";
      if (dynamicImport || requireCall || requireMember) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return found; // in source order
}

/** Every module file extension the tree scan reads and the resolver can land on. */
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * This repository's compiler options, converted by the installed compiler from `tsconfig.json`
 * itself: `moduleResolution: "bundler"`, the `@/*` path mapping, `allowJs`. Only the options are
 * read — no file list is expanded — so the guard resolves the way `tsc --noEmit` does here.
 */
const COMPILER_OPTIONS: ts.CompilerOptions = (() => {
  const read = ts.readConfigFile(join(ROOT, "tsconfig.json"), (path) => readFileSync(path, "utf8"));
  if (read.error || !read.config) throw new Error("activation guard: tsconfig.json could not be read");
  const converted = ts.convertCompilerOptionsFromJson(read.config.compilerOptions ?? {}, ROOT, join(ROOT, "tsconfig.json"));
  if (converted.errors.length > 0) throw new Error("activation guard: tsconfig.json compiler options are invalid");
  // `paths` is relative to the directory of tsconfig.json, which is the repository root.
  return { ...converted.options, pathsBasePath: ROOT } as ts.CompilerOptions;
})();

/** The compiler's view of an in-memory `{ repo-relative path: source }` tree rooted at the repository. */
function resolutionHost(tree: ReadonlyMap<string, string>): ts.ModuleResolutionHost {
  const directories = new Set<string>();
  for (const file of tree.keys()) {
    for (let dir = dirname(file); dir !== "." && dir !== "" && !directories.has(dir); dir = dirname(dir)) directories.add(dir);
  }
  const rel = (path: string): string => relative(ROOT, path);
  return {
    fileExists: (path) => tree.has(rel(path)),
    readFile: (path) => tree.get(rel(path)),
    directoryExists: (path) => rel(path) === "" || directories.has(rel(path)),
    getCurrentDirectory: () => ROOT,
    realpath: (path) => path,
    useCaseSensitiveFileNames: () => true,
  };
}

interface Resolver { tree: ReadonlyMap<string, string>; host: ts.ModuleResolutionHost; cache: ts.ModuleResolutionCache }

function resolverFor(tree: ReadonlyMap<string, string>): Resolver {
  return { tree, host: resolutionHost(tree), cache: ts.createModuleResolutionCache(ROOT, (name) => name, COMPILER_OPTIONS) };
}

/**
 * Every file of the tree a specifier can name, or none for a package / unresolvable one.
 *
 * The first answer is the installed compiler's own: under this repository's `bundler` resolution
 * `./drain.js` names `./drain.ts`, and it names `./drain.ts` EVEN WHEN a `./drain.js` also exists.
 * The second answer is the file the specifier literally spells, when that file exists too: a runtime
 * bundler may load it instead. Both edges are kept. Reachability can only gain from the extra edge,
 * and the TypeScript edge — the one that can lead to a guarded module — is never dropped for it.
 */
function resolveSpecifier(resolver: Resolver, fromRel: string, spec: string): string[] {
  const targets = new Set<string>();
  const resolved = ts.resolveModuleName(spec, join(ROOT, fromRel), COMPILER_OPTIONS, resolver.host, resolver.cache).resolvedModule;
  if (resolved) {
    const file = relative(ROOT, resolved.resolvedFileName);
    if (resolver.tree.has(file)) targets.add(file);
  }
  const literal = spec.startsWith("@/") ? normalize(spec.slice(2)) : spec.startsWith(".") ? join(dirname(fromRel), spec) : null;
  if (literal !== null && resolver.tree.has(literal)) targets.add(literal);
  return [...targets].sort();
}

const GRAPHS = new WeakMap<ReadonlyMap<string, string>, Map<string, Set<string>>>();

/** file → the files it imports, for an in-memory `{ repo-relative path: source }` tree. Computed once per tree. */
function importGraph(tree: ReadonlyMap<string, string>): Map<string, Set<string>> {
  const known = GRAPHS.get(tree);
  if (known) return known;
  const resolver = resolverFor(tree);
  const graph = new Map<string, Set<string>>();
  for (const [file, source] of tree) {
    const targets = new Set<string>();
    for (const spec of importSpecifiers(file, source)) {
      for (const target of resolveSpecifier(resolver, file, spec)) targets.add(target);
    }
    graph.set(file, targets);
  }
  GRAPHS.set(tree, graph);
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

let REAL_TREE: Map<string, string> | null = null;

/** The repository's real source tree, read once: every real-tree test shares it and its import graph. */
function readTree(): Map<string, string> {
  if (REAL_TREE) return REAL_TREE;
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
  REAL_TREE = tree;
  return tree;
}

/** Parsing and resolving the whole repository with the compiler takes seconds, not milliseconds. */
const REAL_TREE_TIMEOUT = { timeout: 120_000 };

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
      expect(importSpecifiers(entry, line)).toEqual(["@/lib/innocent", spec]);
      const tree = new Map<string, string>([...stubs(), ["lib/innocent.ts", ""], [entry, line]]);
      expect(reachedGuarded(tree), guarded).toEqual([`${entry} → ${guarded}`]);
      expect(outsideImporters(tree), guarded).toEqual([`${entry} → ${guarded}`]);
    }
    // Position on the line does not matter, nor does the spelling of the later statements.
    const crowded = [
      `const first = 1; import one from "./one"; export { two } from "./two"; import "./three"; const four = await import("./four"); const five = require("./five");`,
      `export const x = 1; import six from "./six"`,
    ].join("\n");
    expect(importSpecifiers("lib/crowded.ts", crowded)).toEqual(["./one", "./two", "./three", "./four", "./five", "./six"]);
    // A dynamic import inside a declaration, before a later static import: both, in source order.
    expect(importSpecifiers("lib/lazy.ts", 'export function load() { return import(`./lazy`) }\nimport late from "./late";')).toEqual(["./lazy", "./late"]);
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
    // The other JavaScript extensions map the way the installed compiler maps them.
    const resolve = (files: string[], spec: string): string[] =>
      resolveSpecifier(resolverFor(new Map(["lib/a.ts", ...files].map((file): [string, string] => [file, ""]))), "lib/a.ts", spec);
    expect(resolve(["lib/b.tsx"], "./b.js")).toEqual(["lib/b.tsx"]);
    expect(resolve(["lib/b.tsx"], "./b.jsx")).toEqual(["lib/b.tsx"]);
    expect(resolve(["lib/b.mts"], "./b.mjs")).toEqual(["lib/b.mts"]);
    expect(resolve(["lib/b.cts"], "./b.cjs")).toEqual(["lib/b.cts"]);
    expect(resolve(["lib/b.ts"], "./b")).toEqual(["lib/b.ts"]);
    expect(resolve(["lib/b/index.ts"], "./b")).toEqual(["lib/b/index.ts"]);
    expect(resolve(["lib/c.ts"], "./b.js")).toEqual([]);
    // A bare package name is not a path, even beside a same-named root file; an unmapped alias is nothing.
    expect(resolve(["pg.ts"], "pg")).toEqual([]);
    expect(resolve(["lib/b.ts"], "~/lib/b")).toEqual([]);
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

  it("keeps the TypeScript edge when a .js file sits beside the .ts module (installed bundler resolution)", () => {
    // Under this repository's `moduleResolution: "bundler"`, `./b.js` names `./b.ts` even when
    // `./b.js` exists as well. An earlier version of this guard asserted the opposite ("a real .js
    // file still wins") and so could drop exactly the edge that leads to a guarded module.
    const resolver = resolverFor(new Map([["lib/a.ts", ""], ["lib/b.js", ""], ["lib/b.ts", ""]]));
    const direct = ts.resolveModuleName("./b.js", join(ROOT, "lib/a.ts"), COMPILER_OPTIONS, resolver.host).resolvedModule;
    expect(direct && relative(ROOT, direct.resolvedFileName), "what the installed compiler itself resolves").toBe("lib/b.ts");
    // The guard keeps that edge, and conservatively the literally-named file too.
    expect(resolveSpecifier(resolver, "lib/a.ts", "./b.js")).toEqual(["lib/b.js", "lib/b.ts"]);
    expect(resolveSpecifier(resolver, "lib/a.ts", "./b")).toContain("lib/b.ts");

    // The control that matters: a stray compiled `.js` beside EACH guarded module hides nothing.
    const entry = "app/api/v1/timeline/route.ts";
    for (const guarded of GUARDED) {
      const shadow = guarded.replace(/\.ts$/, ".js");
      for (const spec of [`@/${shadow}`, `@/${guarded.replace(/\.ts$/, "")}`, `../../../../${shadow}`]) {
        const tree = new Map<string, string>([...stubs(), [shadow, ""], [entry, `import { x } from "${spec}";`]]);
        expect(reachedGuarded(tree), spec).toEqual([`${entry} → ${guarded}`]);
        expect(outsideImporters(tree), spec).toEqual([`${entry} → ${guarded}`]);
        expect([...(importGraph(tree).get(entry) ?? [])], spec).toContain(guarded);
      }
    }
    // And transitively through the shadow file itself: the `.js` twin that re-exports is followed too.
    const viaShadow = new Map<string, string>([
      ...stubs(),
      ["lib/dashboard/loader.js", `export * from "./slack-timeline-drain.js";`],
      ["lib/dashboard/loader.ts", `export const nothing = 1;`],
      [entry, `import { x } from "@/lib/dashboard/loader.js";`],
    ]);
    expect(reachedGuarded(viaShadow)).toEqual([`${entry} → lib/dashboard/loader.js → ${DRAIN}`]);
  });

  it("sees a valid import whatever comments sit inside it (red rereview counterexamples)", () => {
    const entry = "app/api/v1/timeline/route.ts";
    // The exact two shapes the rereview ran, which a text pattern reported as zero imports.
    const chunkName = `const m = await import(/* webpackChunkName: "slack" */ "@/lib/dashboard/slack-timeline-drain");`;
    const quotedBeforeFrom = `import { drainSlackTimeline } /* "quoted" comment */ from "@/lib/dashboard/slack-timeline-drain";`;
    for (const source of [chunkName, quotedBeforeFrom]) {
      expect(importSpecifiers(entry, source), source).toEqual(["@/lib/dashboard/slack-timeline-drain"]);
      const tree = new Map<string, string>([...stubs(), [entry, source]]);
      expect(reachedGuarded(tree), source).toEqual([`${entry} → ${DRAIN}`]);
      expect(outsideImporters(tree), source).toEqual([`${entry} → ${DRAIN}`]);
    }

    const commented: [string, (spec: string) => string][] = [
      ["a magic comment in a dynamic import", (s) => `const m = await import(/* webpackChunkName: "slack" */ "${s}");`],
      ["line comments around a dynamic import's argument", (s) => `const m = await import(\n  // "not/this"\n  "${s}" // 'nor this'\n);`],
      ["a quoted comment before from", (s) => `import { x } /* "quoted" comment */ from "${s}";`],
      ["quoted comments in every gap of a static import", (s) => `import /* 'a' */ { x /* "b"; */ } /* from "./decoy" */ from /* 'c' */ "${s}" /* "d" */;`],
      ["a quoted trailing comment inside a multi-line import", (s) => `import {\n  x, // "quoted"; from './decoy'\n  y,\n} from "${s}";`],
      ["a quoted comment in a re-export", (s) => `export * /* "from" './decoy' */ from "${s}";`],
      ["a quoted comment in a named re-export", (s) => `export { x /* "y" */ } /* ; */ from "${s}";`],
      ["a comment in a side-effect import", (s) => `import /* "./decoy" */ "${s}";`],
      ["a comment in a require call", (s) => `const m = require(/* "./decoy" */ "${s}");`],
      ["a comment in a type-only import", (s) => `import type /* "t" */ { T } /* 'u' */ from "${s}";`],
      ["a comment between import and its parenthesis", (s) => `const m = await import /* "x" */ ("${s}");`],
    ];
    for (const [label, spell] of commented) {
      for (const guarded of GUARDED) {
        const spec = `@/${guarded.replace(/\.ts$/, "")}`;
        const source = spell(spec);
        // Only the real specifier: nothing quoted inside a comment is taken for one.
        expect(importSpecifiers(entry, source), `${label}: ${guarded}`).toEqual([spec]);
        const tree = new Map<string, string>([...stubs(), ["lib/decoy.ts", ""], [entry, source]]);
        expect(reachedGuarded(tree), `${label}: ${guarded}`).toEqual([`${entry} → ${guarded}`]);
        expect(outsideImporters(tree), `${label}: ${guarded}`).toEqual([`${entry} → ${guarded}`]);
      }
    }
  });

  it("does not mistake comments, strings or unresolvable names for imports", () => {
    const entry = "scripts/drain-slack.ts";
    const notImports = [
      `// import { drainSlackTimeline } from "@/lib/dashboard/slack-timeline-drain";`,
      `/* const d = await import("@/lib/dashboard/slack-timeline-drain"); */`,
      `/**\n * import "@/lib/dashboard/slack-timeline-drain";\n */\nexport const documented = 1;`,
      `const url = "https://example.com"; // import "@/lib/dashboard/slack-timeline-drain.js";`,
      `const text = 'import { x } from "@/lib/dashboard/slack-timeline-drain"';`,
      "const text = `import(\"@/lib/dashboard/slack-timeline-drain\")`;",
      `const pattern = /import\\("@\\/lib\\/dashboard\\/slack-timeline-drain"\\)/;`,
      `const o = { import: "@/lib/dashboard/slack-timeline-drain", from: "@/lib/dashboard/slack-timeline-drain" };`,
      `notRequire("@/lib/dashboard/slack-timeline-drain"); loader.load("@/lib/dashboard/slack-timeline-drain");`,
    ];
    for (const source of notImports) {
      expect(importSpecifiers(entry, source), source).toEqual([]);
      const tree = new Map<string, string>([...stubs(), [entry, source]]);
      expect(reachedGuarded(tree), source).toEqual([]);
      expect(outsideImporters(tree), source).toEqual([]);
    }
    // Packages, unresolvable paths and non-literal specifiers are imports that lead nowhere in the tree.
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
    expect(importSpecifiers(entry, inert.get(entry) ?? "")).toEqual(["pg", "./slack-timeline-drain"]);
    expect(reachedGuarded(inert)).toEqual([]);
    expect(outsideImporters(inert)).toEqual([]);
    // A real import on the same line as a comment that also names one is still exactly one edge.
    const mixed = new Map<string, string>([
      ...stubs(),
      [entry, `import "@/lib/dashboard/slack-timeline-page-contract"; // import "@/lib/dashboard/slack-timeline-drain";`],
    ]);
    expect(reachedGuarded(mixed)).toEqual([`${entry} → ${CONTRACT}`]);
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

  it("is not vacuous over the real tree: the traversal reaches what is known to be reachable", REAL_TREE_TIMEOUT, () => {
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

  it("is reachable from no route, page, action, script or instrumentation entry point", REAL_TREE_TIMEOUT, () => {
    expect(reachedGuarded(readTree())).toEqual([]);
  });

  it("is imported by nothing outside the packet — not the builder, the cache, the UI, v1 or the Slack source", REAL_TREE_TIMEOUT, () => {
    expect(outsideImporters(readTree())).toEqual([]);
  });

  it("keeps the packet's own imports inside its inactive boundary", REAL_TREE_TIMEOUT, () => {
    const tree = readTree();
    const graph = importGraph(tree);
    for (const guarded of GUARDED) expect(tree.has(guarded), `${guarded} exists`).toBe(true);
    // The contract is the pure base: it imports neither sibling, no database and no server-only code.
    const contractImports = [...(graph.get(CONTRACT) ?? [])];
    expect(contractImports).not.toContain(PAGE_READ);
    expect(contractImports).not.toContain(DRAIN);
    for (const pure of [CONTRACT, DRAIN]) {
      const source = tree.get(pure) ?? "";
      expect(importSpecifiers(pure, source).filter((spec) => /^(@\/lib\/db|@\/lib\/ingest|@\/lib\/access|server-only$|pg$)/.test(spec)), pure).toEqual([]);
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
