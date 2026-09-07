import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, relative, resolve as resolvePath } from "node:path";
import ts from "typescript";
import {
  analyseTreeAt,
  discoverSourcePaths,
  NOT_WALKED_ROOTS,
  WALK_SOURCE_EXT,
  WALKED_ROOTS,
} from "./entry-surface-discovery";
import {
  analyseEntrySurfaces,
  isGraphSourceFile,
  CANONICAL_WRITER_MODULE,
  COMPUTED_LOAD_EXCEPTIONS,
  ENTRY_CLASSES,
  ENTRY_INVENTORY,
  GRAPH_SOURCE_EXT,
  PINNED_TS_PATHS,
  type ComputedLoadException,
  type EntryClass,
  type EntryRecord,
  type EntrySurfaceAnalysis,
  type EntryViolationKind,
} from "./entry-surface-graph";

/**
 * Pin the §11 context-partition CALL SITES, and — since AUDITFIX-2 — ENUMERATE them.
 *
 * ## Why the enumeration exists (AUDITFIX-2, `docs/design/auditfix2-writer-inventory-guard.md`)
 *
 * This file used to pin THREE named files and call itself a guard on "the call sites". It never
 * asked who calls `ingestItem`. Checked against git: on the day this guard shipped (`d3cb8e2c`,
 * #530, 2026-08-11) there were TWELVE direct `ingestItem` call sites across six files, and it
 * pinned three — the three that slice had just wired. A test asserting what its author did rather
 * than what the contract requires is characterization-by-construction, which CLAUDE.md §2 forbids
 * as the default, and it is why this stayed green for eleven days while the commits path (64% of
 * ingested volume) took an unclassified route to the substrate.
 *
 * ## What the build enforces — exactly this and no more
 *
 *   Every file that calls `ingestItem` DIRECTLY carries a CLASSIFICATION and a non-empty rationale
 *   below. An unclassified caller fails. A classification whose file no longer calls it fails.
 *
 * That is a review tripwire on the SET OF DIRECT WRITERS. It is NOT an access-substrate control:
 * nothing here validates a rationale, proves a reconcile is REACHED on a given branch, or checks
 * any latency claim. The `latency` notes are documentation for a human, not assertions.
 *
 * ## The second half — ENTRY SURFACES, by reverse import closure (AUDITFIX-18)
 *
 * The direct-writer inventory above cannot see A NEW ENTRY SURFACE THAT CALLS AN EXISTING,
 * ALREADY-CLASSIFIED WRAPPER: `POST /api/v1/codebases` calls `ingestCodebaseScan`, not `ingestItem`,
 * so a second route calling the same helper adds no direct call site and leaves that half green.
 * The `describe` at the foot of this file closes it — NOT with a whole-program call graph, which is
 * what this header used to promise, but with the reverse closure of MODULE IMPORTS from the
 * canonical writer (`./entry-surface-graph`). It follows edges, so it names files that can REACH the
 * writer; it does not decide which exported function runs, so each `ENTRY_INVENTORY` record is a
 * REVIEW DECLARATION rather than a structural fact. The two inventories answer different questions
 * and keep their own rules:
 *
 *   INVENTORY      — who calls `ingestItem` DIRECTLY. Exact counts + per-class structural checks.
 *   ENTRY_INVENTORY — who can REACH it through imports. Exact keys + a written reason. No shape check.
 *
 * ## Why an AST walk and not a grep
 *
 * AUDITFIX-1's guard was beaten three times — by a literal, an alias, and a computed key — each a
 * new SPELLING of one act. A `grep "ingestItem("` is beaten by an alias import; a matcher keyed on
 * the literal specifier `@/lib/ingest` is beaten by a RELATIVE import, and that escape is already in
 * this tree (`scripts/seed-demo.ts` imports `"../lib/ingest"`). So every specifier is RESOLVED to
 * the canonical module path before anything is decided.
 *
 * Undecidable provenance FAILS CLOSED (`REFUSED:`) rather than being ignored — see `bindingsFor`.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The one module that defines the writer. Everything resolves to this or is irrelevant. */
const CANONICAL = "lib/ingest/index.ts";
const WRITER = "ingestItem";


type Classification = "RECONCILES_AFTER_RESPONSE" | "RECONCILES_INLINE" | "SWEEP_COVERED";

interface Entry {
  class: Classification;
  /** How many direct call sites this file has. Lives HERE, next to the reason, so bumping the
   *  number means re-reading why the classification is right — Fable M4: a count table in a second
   *  place teaches "paste over the number" instead. */
  sites: number;
  /** Why this is the right classification. Required and non-empty — a bare class is a shrug. */
  reason: string;
  /** REVIEW-ONLY. Nothing below asserts this; it exists so the trade is visible in review. */
  latency: string;
}

/**
 * The inventory. Adding a direct `ingestItem` caller means adding a line here WITH A REASON —
 * that is the whole point, and the failure message says so.
 */
const INVENTORY: Record<string, Entry> = {
  "app/api/v1/items/route.ts": {
    sites: 1,
    class: "RECONCILES_AFTER_RESPONSE",
    reason: "the workspace CLI push path; reconciling in after() keeps the push from blocking on it",
    latency: "measured 0.0 min median on prod — 41/41 items partitioned inside 60s",
  },
  "lib/meetings/notes.ts": {
    sites: 1,
    class: "RECONCILES_INLINE",
    reason: "inline ON PURPOSE: without it the uploader's own meeting 404s until the sweep",
    latency: "immediate; `visible:false` is returned when the reconcile did not complete",
  },
  "lib/meetings/merge.ts": {
    sites: 1,
    class: "RECONCILES_INLINE",
    reason:
      "inline and LOAD-BEARING: it throws and aborts the merge if the reconcile fails, BEFORE " +
      "re-pointing the survivor. Deferring to after() would break that ordering contract",
    latency: "immediate, and a failure aborts the write rather than deferring it",
  },
  "lib/codebases/commits-to-items.ts": {
    sites: 1,
    class: "SWEEP_COVERED",
    reason:
      "reached only from POST /api/v1/codebases via ingestCodebaseScan. Reconciling at push was " +
      "specced and DECLINED (spec §6b): it needs an admission allocation, not a budget — the route " +
      "admits 60 req/min per key and `recent_commits` has no array maximum",
    latency: "⚠️ 64% of ingested volume; median 8.0-8.8 min, up to one full tick interval",
  },
  "lib/ingest/run.ts": {
    sites: 7,
    class: "SWEEP_COVERED",
    reason:
      "the four scheduled connector legs. The tick sequences them BEFORE runContextBackfill and the " +
      "sweep's cutoff is taken at STAGE start, so a scheduled leg's items are swept in their own tick",
    latency:
      "measured 0.8-1.9 min when scheduled; since AUDITFIX-14 manual sync and the four admin " +
      "'Run now' actions await ONE bounded 25-candidate pass of their own, so a small manual import " +
      "is partitioned before the response — a larger backlog reports pending and needs repeated " +
      "runs, and with INGEST_POLL_ENABLED=false those repeated runs are the only progress there is",
  },
  "lib/actions/handlers.ts": {
    sites: 1,
    class: "SWEEP_COVERED",
    reason:
      "note.create, reached from POST /api/v1/actions (runAction) and the admin approval path — " +
      "an HTTP/admin writer OUTSIDE the scheduler chain, not inside it",
    latency: "⚠️ next tick or later; no backstop when INGEST_POLL_ENABLED=false",
  },
  "scripts/seed-demo.ts": {
    sites: 3,
    class: "SWEEP_COVERED",
    reason:
      "demo seeding. Drained ONLY under docker/bootstrap.mjs; `npm run dev:seed`, scripts/e2e.sh " +
      "and scripts/dev-test-setup.sh invoke it with no drain",
    latency: "⚠️ undrained on the direct invocations; unreachable indefinitely with the poller off",
  },
};

/* ────────────────────────── canonical module resolution ────────────────────────── */

/** Resolve a module specifier from `fromRel` to a repo-relative path, or null if it is not ours. */
function resolveSpecifier(fromRel: string, spec: string, known: ReadonlySet<string>): string | null {
  let abs: string;
  if (spec.startsWith("@/")) abs = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) abs = resolvePath(join(ROOT, dirname(fromRel)), spec);
  else return null; // a bare package specifier is never this repo's module
  const rels = [
    ...["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"].map((e) => `${abs}${e}`),
    ...["index.ts", "index.tsx"].map((i) => join(abs, i)),
  ].map((c) => relative(ROOT, c).split("\\").join("/"));
  // Candidate order is TypeScript's, and each candidate is checked against the analysed set AND the
  // disk before moving on. Checking all in-memory candidates first (the earlier shape) let a LATER
  // candidate outrank an EARLIER real file — Codex LOW 2; no collision exists today, but the
  // ordering is what makes that true rather than luck. Fixtures are synthetic modules with no disk
  // presence, so `known` cannot simply be dropped.
  for (const rel of rels) {
    if (known.has(rel)) return rel;
    try {
      if (statSync(join(ROOT, rel)).isFile()) return rel;
    } catch {
      /* not this candidate */
    }
  }
  return null;
}

/**
 * Every module through which the writer can be imported — the canonical one plus any RE-EXPORT
 * BARREL, to a fixpoint.
 *
 * ⚠️ TWO REVIEWS, TWO DEFEATS, ONE FUNCTION. Fable beat the first version with
 *   `lib/barrel.ts:  export { ingestItem } from "@/lib/ingest";`
 * because the comment claimed "one level is followed by `resolveSpecifier`" and that function only
 * resolves PATH SPELLINGS — it never reads a re-export. Barrels became followed.
 *
 * Codex then beat THAT with a RENAMED one:
 *   `lib/barrel.ts:  export { ingestItem as writeItem } from "@/lib/ingest";`
 *   `lib/writer.ts:  import { writeItem } from "@/lib/barrel"; await writeItem(...)`
 * — the module was correctly identified as a writer module, and then consumers were bound on the
 * literal name `ingestItem`, so the barrel's ALIAS was lost. Compiled clean, guard stayed 40/40.
 *
 * So this no longer returns "which modules re-export the writer" but **which NAMES each module
 * exports that reach it** — the only form in which a consumer can actually import it.
 */
function writerExports(files: { rel: string; code: string }[], known: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>([[CANONICAL, new Set([WRITER])]]);
  const byRel = new Map(files.map((f) => [f.rel, f.code]));
  if (!byRel.has(CANONICAL)) byRel.set(CANONICAL, "");
  // Only files that RE-EXPORT anything can ever join the set, so the fixpoint iterates over those
  // rather than the whole tree (the real tree has a handful; it had been re-parsing ~1,000 files a
  // pass).
  const reExporters = [...byRel].filter(([, code]) => /\bexport\b[^;]*\bfrom\b/.test(code));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [rel, code] of reExporters) {
      const src = parse(rel, code);
      const names = out.get(rel) ?? new Set<string>();
      const before = names.size;
      const visit = (n: ts.Node): void => {
        if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) {
          const target = resolveSpecifier(rel, n.moduleSpecifier.text, known);
          const upstream = target ? out.get(target) : undefined;
          if (upstream) {
            if (!n.exportClause) {
              // `export * from` — every upstream name keeps its own spelling.
              for (const u of upstream) if (u !== "default") names.add(u);
            } else if (ts.isNamedExports(n.exportClause)) {
              for (const el of n.exportClause.elements) {
                // The name AS EXPORTED BY THIS MODULE is what a consumer will import.
                if (upstream.has(el.propertyName?.text ?? el.name.text)) names.add(el.name.text);
              }
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(src);
      if (names.size > before || (names.size > 0 && !out.has(rel))) {
        out.set(rel, names);
        grew = true;
      }
    }
  }
  return out;
}

/* ────────────────────────────── the walk ────────────────────────────── */

interface Bindings {
  /** Local names bound to the writer itself. */
  direct: Set<string>;
  /** Local names bound to a writer-module namespace. */
  namespaces: Set<string>;
  /** Identifier nodes that are the DECLARATION of one of the above (never a "use"). */
  declSites: Set<ts.Node>;
}

const scriptKind = (rel: string) => (rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/**
 * Parsing is MEMOISED, and that is a correctness-of-the-suite matter rather than a nicety.
 * `writerExports` iterates to a fixpoint over every file, so without this the real tree is parsed
 * ~1,000 files × N passes × once per `analyse()` call — which pushed AC3 and AC4 past vitest's 5 s
 * default under coverage instrumentation and FAILED IN CI while `npm test` was green locally.
 * (CI runs `npm run coverage`, not `npm test`.) Keyed on the content, so a fixture that reuses a
 * path with different code still parses fresh.
 */
const parseCache = new Map<string, ts.SourceFile>();
const parse = (rel: string, code: string): ts.SourceFile => {
  const key = `${rel}\u0000${code}`;
  let sf = parseCache.get(key);
  if (!sf) {
    sf = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, scriptKind(rel));
    parseCache.set(key, sf);
  }
  return sf;
};

/** `require("…")` / `await import("…")` / `import("…")` → the specifier, when it is a string literal. */
function moduleSpecifierOf(e: ts.Expression): string | null {
  const inner = ts.isAwaitExpression(e) ? e.expression : e;
  if (!ts.isCallExpression(inner)) return null;
  const isImport = inner.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(inner.expression) && inner.expression.text === "require";
  if (!isImport && !isRequire) return null;
  const arg = inner.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/**
 * PASS 1 — collect every local name that can reach the writer.
 *
 * Recognised forms (each is a spelling the guard COUNTS rather than refuses):
 *   `import { ingestItem }` / `{ ingestItem as write }` / `import * as ingest`
 *   `import ingest = require("…")`
 *   `const { ingestItem } = await import("…")` / `= require("…")`
 *   `const mod = await import("…")` then `const { ingestItem } = mod`   ← Fable BLOCKER 2
 *   `const write = ingestItem`  (chained to a fixpoint)
 *
 * Anything else that TOUCHES one of these bindings is refused in pass 2 — that is where the
 * fail-closed promise in this file's header is actually kept.
 */
function bindingsFor(rel: string, src: ts.SourceFile, modules: Map<string, Set<string>>, known: ReadonlySet<string>): Bindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  const declSites = new Set<ts.Node>();
  /** The names THIS module would have to import to reach the writer, or null if the specifier is
   *  not a writer module at all. */
  const exportedNames = (spec: string): Set<string> | null => {
    const t = resolveSpecifier(rel, spec, known);
    return t === null ? null : (modules.get(t) ?? null);
  };
  const isWriterModule = (spec: string) => exportedNames(spec) !== null;

  let grew = true;
  while (grew) {
    grew = false;
    const addDirect = (n: string, decl: ts.Node) => {
      if (!direct.has(n)) {
        direct.add(n);
        grew = true;
      }
      declSites.add(decl);
    };
    const addNs = (n: string, decl: ts.Node) => {
      if (!namespaces.has(n)) {
        namespaces.add(n);
        grew = true;
      }
      declSites.add(decl);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const exported = exportedNames(node.moduleSpecifier.text);
        if (exported) {
          const clause = node.importClause;
          const named = clause?.namedBindings;
          if (named && ts.isNamedImports(named)) {
            for (const el of named.elements) {
              // Match the name AS THE MODULE EXPORTS IT — a renamed barrel is why this is not `WRITER`.
              if (exported.has(el.propertyName?.text ?? el.name.text)) addDirect(el.name.text, el.name);
            }
          } else if (named && ts.isNamespaceImport(named)) addNs(named.name.text, named.name);
          // `import writeItem from "…"` against `export { ingestItem as default }`.
          if (clause?.name && exported.has("default")) addDirect(clause.name.text, clause.name);
        }
      }
      // `import ingest = require("@/lib/ingest")`
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteralLike(node.moduleReference.expression) &&
        isWriterModule(node.moduleReference.expression.text)
      ) {
        addNs(node.name.text, node.name);
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = node.initializer;
        const spec = moduleSpecifierOf(init);
        const fromWriterModule = spec !== null && isWriterModule(spec);
        // `= await import(…)` / `= require(…)`, OR a two-step through a known namespace identifier.
        const fromKnownNs = ts.isIdentifier(init) && namespaces.has(init.text);
        if (fromWriterModule || fromKnownNs) {
          const exported = spec !== null ? exportedNames(spec) : new Set([WRITER]);
          if (ts.isObjectBindingPattern(node.name)) {
            for (const el of node.name.elements) {
              const orig = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : undefined;
              const local = ts.isIdentifier(el.name) ? el.name.text : undefined;
              if (local && exported?.has(orig ?? local)) addDirect(local, el.name);
            }
          } else if (ts.isIdentifier(node.name) && fromWriterModule) addNs(node.name.text, node.name);
        }
        // `const write = ingestItem` — a direct alias of an already-known binding.
        if (ts.isIdentifier(init) && direct.has(init.text) && ts.isIdentifier(node.name)) {
          addDirect(node.name.text, node.name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }
  return { direct, namespaces, declSites };
}

/**
 * PASS 2 — every USE of a collected binding is either a recognised CALL or a REFUSAL.
 *
 * ⚠️ FABLE DIFF REVIEW, BLOCKERS 2+3 and HIGH 1. The previous version counted three callee shapes
 * and refused only four VariableDeclaration initialiser kinds, so `(0, ingestItem)(…)`,
 * `ingestItem.call(…)`, and `runWith(ingestItem, …)` were all silently DROPPED — the opposite of
 * this file's own "fails closed" header — while a name-matching refusal fired on an INNOCENT local
 * function called `ingestItem` and broke the build. Both are one mistake: deciding on shapes we
 * enumerate instead of on provenance we resolved. So the rule inverts — a resolved binding may
 * appear in exactly the positions below, and anywhere else is `REFUSED`.
 */
function usesOf(rel: string, src: ts.SourceFile, b: Bindings): { calls: string[]; refused: string[] } {
  const calls: string[] = [];
  const refused: string[] = [];
  const at = (n: ts.Node) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;

  const inTypePosition = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p) || ts.isTypeNode(p)) return true;
      if (ts.isExpressionStatement(p) || ts.isBlock(p) || ts.isSourceFile(p)) return false;
    }
    return false;
  };

  /**
   * SHADOWING (Codex diff review, HIGH 1). Bindings are file-wide NAMES, so a nested parameter or
   * local of the same name was treated as the imported writer:
   *
   *   import { ingestItem } from "@/lib/ingest";
   *   export function callInjectedCallback(ingestItem: () =&gt; void) { ingestItem(); }
   *
   * — an innocent file that BROKE THE BUILD, which is the same deletion-risk failure mode §12
   * claims was eliminated (only its object-literal instance was). Full symbol resolution needs a
   * Program + checker, far too slow for a guard called ~30 times per run, so this tracks a scope
   * stack of names REDECLARED below module scope: inside such a scope the name is not ours.
   */
  const shadowed: string[] = [];
  const declaredNamesIn = (n: ts.Node): string[] => {
    const names: string[] = [];
    const add = (name: ts.BindingName | undefined) => {
      if (!name) return;
      if (ts.isIdentifier(name)) names.push(name.text);
      else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const el of name.elements) if (ts.isBindingElement(el)) add(el.name);
      }
    };
    if (ts.isFunctionLike(n)) {
      for (const prm of n.parameters) add(prm.name);
      if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) names.push(n.name.text);
    }
    const body = ts.isFunctionLike(n) ? n.body : ts.isBlock(n) || ts.isSourceFile(n) ? n : undefined;
    if (body && (ts.isBlock(body) || ts.isSourceFile(body))) {
      for (const st of body.statements) {
        if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) add(d.name);
        else if (ts.isFunctionDeclaration(st) && st.name) names.push(st.name.text);
        else if (ts.isClassDeclaration(st) && st.name) names.push(st.name.text);
      }
    }
    return names;
  };
  const isShadowed = (name: string) => shadowed.includes(name);

  const visit = (node: ts.Node): void => {
    const opensScope = ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node) || ts.isForStatement(node);
    let pushed = 0;
    if (opensScope) {
      for (const n of declaredNamesIn(node)) {
        shadowed.push(n);
        pushed++;
      }
    }
    if (ts.isIdentifier(node) && !b.declSites.has(node) && !isShadowed(node.text)) {
      const p = node.parent;
      if (b.direct.has(node.text)) {
        if (ts.isCallExpression(p) && p.expression === node) calls.push(at(p));
        else if (ts.isVariableDeclaration(p) && p.initializer === node && ts.isIdentifier(p.name)) {
          /* the recognised alias form — pass 1 already bound it */
        } else if (inTypePosition(node)) {
          /* `typeof ingestItem` is not a use */
        } else if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isBindingElement(p)) {
          /* re-export or destructure metadata, not a value use */
        } else {
          refused.push(`${at(node)} \`${node.text}\` (a resolved ${WRITER} binding) used as ${ts.SyntaxKind[p.kind]} — the guard cannot decide where it goes. Call it directly, or classify the file explicitly`);
        }
      } else if (b.namespaces.has(node.text)) {
        const isMemberBase =
          (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === node;
        if (isMemberBase) {
          const member = ts.isPropertyAccessExpression(p)
            ? p.name.text
            : ts.isStringLiteralLike(p.argumentExpression)
              ? p.argumentExpression.text
              : null;
          if (member === WRITER) {
            if (ts.isCallExpression(p.parent) && p.parent.expression === p) calls.push(at(p.parent));
            else refused.push(`${at(p)} \`${node.text}.${WRITER}\` referenced without calling it — the guard cannot follow where it goes`);
          }
          /* any other member of the module is not our business */
        } else if (ts.isVariableDeclaration(p) && p.initializer === node) {
          /* the recognised two-step form — pass 1 already bound it */
        } else if (inTypePosition(node)) {
          /* type-only */
        } else {
          refused.push(`${at(node)} the ${WRITER} module namespace \`${node.text}\` used as ${ts.SyntaxKind[p.kind]} — the guard cannot decide where it goes`);
        }
      }
    }
    ts.forEachChild(node, visit);
    for (let i = 0; i < pushed; i++) shadowed.pop();
  };
  visit(src);
  return { calls, refused };
}

/**
 * Does this module await `reconcileItemContext`, and is that call inside an `after(...)` callback?
 *
 * ⚠️ Keyed on the BARE NAMES `after` / `reconcileItemContext`, and that limit is real (Fable M2): a
 * local helper called `after` would satisfy the after-response shape, and importing `after` under
 * another name would fail a legitimate file. Both are acceptable HERE and nowhere else, because
 * this is the "review tripwire, not proof" half of the guard (see the header) — the CLASS is the
 * enforced fact, its shape check is a sanity rail. An aliased `after` import is refused explicitly
 * so the false-positive direction is loud rather than confusing.
 */
function reconcileShape(rel: string, src: ts.SourceFile): { calls: number; insideAfter: number; aliasedAfter: boolean } {
  let calls = 0;
  let insideAfter = 0;
  let aliasedAfter = false;
  const visit = (node: ts.Node, inAfter: boolean): void => {
    if (ts.isImportDeclaration(node)) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if (el.propertyName?.text === "after" && el.name.text !== "after") aliasedAfter = true;
        }
      }
    }
    let nowInAfter = inAfter;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "after") nowInAfter = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "reconcileItemContext") {
      // AWAITED, directly or through a `.catch(...)`/`.then(...)` chain (merge.ts uses the former).
      // Codex HIGH 2: counting any bare call let `await` be deleted with the suite still green,
      // while both class names and the spec say the reconcile is awaited.
      let top: ts.Node = node;
      while (ts.isPropertyAccessExpression(top.parent) || ts.isCallExpression(top.parent)) top = top.parent;
      if (ts.isAwaitExpression(top.parent)) {
        calls++;
        if (inAfter) insideAfter++;
      }
    }
    ts.forEachChild(node, (c) => visit(c, nowInAfter));
  };
  visit(src, false);
  return { calls, insideAfter, aliasedAfter };
}

/* ────────────────────────── analysis over the real tree ────────────────────────── */

/**
 * The walk — its roots, its exclusions and its extension list — now lives in
 * `./entry-surface-discovery` with the ROOT INJECTED, and these are the same values under the names
 * the criteria below already used. The move is behaviour-preserving; what it buys is that a fixture
 * can run the REAL walk against a throwaway tree (see `fixtureRoot`), which is impossible while the
 * only caller is `ROOT`. The rationale for each list is in that module's header (Fable HIGH 2:
 * `components/` and the root-level sources were once silently outside coverage).
 */
const WALKED = WALKED_ROOTS;
const NOT_WALKED = NOT_WALKED_ROOTS;
const SOURCE_EXT = WALK_SOURCE_EXT;

const productionFiles = (): string[] => discoverSourcePaths(ROOT);

export interface Violation {
  kind: "unclassified" | "stale" | "refused" | "shape";
  message: string;
}

/** The whole guard, over an arbitrary file set — so fixtures exercise the SAME code path. */
function analyse(
  files: { rel: string; code: string }[],
  inventory: Record<string, Entry>
): { violations: Violation[]; sites: Record<string, number> } {
  const violations: Violation[] = [];
  const sites: Record<string, number> = {};
  const known = new Set(files.map((f) => f.rel));
  const modules = writerExports(files, known);

  for (const f of files) {
    const src = parse(f.rel, f.code);
    const b = bindingsFor(f.rel, src, modules, known);
    const { calls, refused } = usesOf(f.rel, src, b);
    for (const r of refused) violations.push({ kind: "refused", message: `REFUSED: ${r}` });
    if (calls.length === 0) continue;
    sites[f.rel] = calls.length;

    const entry = inventory[f.rel];
    if (!entry) {
      violations.push({
        kind: "unclassified",
        message:
          `${f.rel} calls ${WRITER} (${calls.join(", ")}) but is not classified. Add it to INVENTORY ` +
          `with a class and a REASON — do not silence this.`,
      });
      continue;
    }
    if (!entry.reason.trim()) violations.push({ kind: "unclassified", message: `${f.rel} has an empty rationale` });
    if (entry.sites !== calls.length) {
      violations.push({
        kind: "stale",
        message: `${f.rel} has ${calls.length} ${WRITER} call site(s); INVENTORY says ${entry.sites}. Re-read the reason before bumping the number.`,
      });
    }
    const shape = reconcileShape(f.rel, src);
    if (shape.aliasedAfter) {
      violations.push({ kind: "shape", message: `${f.rel} imports \`after\` under another name — this guard keys on the bare name and cannot judge the shape` });
    }
    if (entry.class === "RECONCILES_AFTER_RESPONSE" && shape.insideAfter === 0) {
      violations.push({ kind: "shape", message: `${f.rel} is RECONCILES_AFTER_RESPONSE but has no reconcileItemContext inside an after() callback` });
    }
    if (entry.class === "RECONCILES_INLINE") {
      if (shape.calls === 0) violations.push({ kind: "shape", message: `${f.rel} is RECONCILES_INLINE but never calls reconcileItemContext` });
      else if (shape.calls === shape.insideAfter) {
        violations.push({ kind: "shape", message: `${f.rel} is RECONCILES_INLINE but every reconcileItemContext is inside after()` });
      }
    }
  }

  for (const rel of Object.keys(inventory)) {
    if (!(rel in sites)) {
      violations.push({ kind: "stale", message: `${rel} is classified but no longer calls ${WRITER} — remove the stale entry` });
    }
  }
  return { violations, sites };
}

let realFilesCache: { rel: string; code: string }[] | null = null;
const realFiles = () => (realFilesCache ??= productionFiles().map((rel) => ({ rel, code: read(rel) })));

/**
 * The real-tree pass, computed ONCE and shared.
 *
 * ⚠️ CI TAUGHT ME THIS TWICE. The tests below each analysed the whole tree independently, which is
 * ~1,000 TypeScript parses per test. That fits comfortably under `npm test` locally and TIMED OUT at
 * vitest's 5 s default in CI, which runs `npm run coverage` — instrumentation plus a slower shared
 * runner. Parsing is memoised (see `parse`) and the analysis itself is now memoised too, so the tree
 * is walked once per run rather than once per assertion. The explicit timeouts below are the honest
 * belt-and-braces: this guard does real work over the whole repository and should be allowed to.
 */
const REAL_TREE_TIMEOUT_MS = 60_000;
let realAnalysisCache: ReturnType<typeof analyse> | null = null;
const analyseRealTree = () => (realAnalysisCache ??= analyse(realFiles(), INVENTORY));

/* ────────────────────────────── the criteria ────────────────────────────── */

const IMPORT_CANON = `import { ${WRITER} } from "@/lib/ingest";`;
const NO_INVENTORY: Record<string, Entry> = {};
const classified = (rel: string, cls: Classification, sites = 1): Record<string, Entry> => ({
  [rel]: { sites, class: cls, reason: "fixture", latency: "fixture" },
});

describe("§11 context-partition — the WRITER INVENTORY (AUDITFIX-2)", () => {
  it("AC3 — the real tree passes, and the discovered inventory is EXACT", () => {
    const { violations, sites } = analyseRealTree();
    expect(violations.map((v) => v.message), "the tree must be fully classified").toEqual([]);
    // Set EQUALITY, not a subset: a walk that finds nothing also "passes". This is the criterion
    // that makes the guard non-vacuous — and it is only as strong as the recognizer behind it,
    // which is why controls 4 and 5 pin canonical resolution.
    expect(sites).toEqual({
      "app/api/v1/items/route.ts": 1,
      "lib/meetings/notes.ts": 1,
      "lib/meetings/merge.ts": 1,
      "lib/codebases/commits-to-items.ts": 1,
      "lib/ingest/run.ts": 7,
      "lib/actions/handlers.ts": 1,
      "scripts/seed-demo.ts": 3,
    });
  }, REAL_TREE_TIMEOUT_MS);

  it("AC1 — an unclassified direct writer fails, and the message names the file", () => {
    const rel = "lib/new-writer.ts";
    const { violations } = analyse([{ rel, code: `${IMPORT_CANON}\nawait ${WRITER}(db, auth, p, "team");` }], NO_INVENTORY);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("unclassified");
    expect(violations[0].message).toContain(rel);
  });

  // AC2 — every evasion fails AND every innocent twin passes, in ONE criterion on purpose: a guard
  // that failed everything would satisfy the evasion half alone. Each row asserts its OWN kind, so
  // a control that stops discriminating is visible rather than absorbed into "something failed".
  //
  // ⚠️ Rows 12-18 are the FIVE DEFEATS Fable's diff review demonstrated with working code that kept
  // the guard 25/25 green, plus the two spellings its remediation named. Every one is kept as a
  // permanent negative control: AUDITFIX-1's guard was beaten three times, and each defeat was a new
  // SPELLING of one act, so the spellings are the regression suite.
  const CONTROLS: { n: string; files: { rel: string; code: string }[]; inv: Record<string, Entry>; kind: Violation["kind"] | null; msg?: string }[] = [
    { n: "1 canonical named import + call", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/f.ts calls" },
    { n: "2 aliased import", files: [{ rel: "lib/f.ts", code: `import { ${WRITER} as writeItem } from "@/lib/ingest";\nawait writeItem(a);` }], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/f.ts calls" },
    { n: "3 namespace member call", files: [{ rel: "lib/f.ts", code: `import * as ingest from "@/lib/ingest";\nawait ingest.${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/f.ts calls" },
    { n: "4 RELATIVE specifier (the escape already in this tree)", files: [{ rel: "scripts/f.ts", code: `import { ${WRITER} } from "../lib/ingest";\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" , msg: "scripts/f.ts calls" },
    { n: "5 explicit /index specifier", files: [{ rel: "lib/f.ts", code: `import { ${WRITER} } from "@/lib/ingest/index";\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/f.ts calls" },
    { n: "6 dynamic-import destructure", files: [{ rel: "lib/f.ts", code: `const { ${WRITER} } = await import("@/lib/ingest");\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/f.ts calls" },
    { n: "7 direct alias", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nconst write = ${WRITER};\nawait write(a);` }], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/f.ts calls" },
    { n: "8 computed namespace key", files: [{ rel: "lib/f.ts", code: `import * as ingest from "@/lib/ingest";\nawait ingest["${WRITER}"](a);` }], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/f.ts calls" },
    { n: "9 RECONCILES_AFTER_RESPONSE whose reconcile is only a comment", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\n// reconcileItemContext(db, t, id)\nawait ${WRITER}(a);` }], inv: classified("lib/f.ts", "RECONCILES_AFTER_RESPONSE"), kind: "shape" , msg: "no reconcileItemContext inside an after() callback" },
    { n: "10 stored in an object literal", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nconst box = { w: ${WRITER} };\nawait box.w(a);` }], inv: NO_INVENTORY, kind: "refused" , msg: "used as PropertyAssignment" },
    { n: "11 stale entry — classified file with no call", files: [{ rel: "lib/f.ts", code: `export const x = 1;` }], inv: classified("lib/f.ts", "SWEEP_COVERED"), kind: "stale" , msg: "no longer calls" },
    // ── Fable's demonstrated defeats ──────────────────────────────────────────────────────────
    { n: "12 FABLE B1 — re-export barrel", files: [
        { rel: "lib/barrel.ts", code: `export { ${WRITER} } from "@/lib/ingest";` },
        { rel: "lib/w.ts", code: `import { ${WRITER} } from "@/lib/barrel";\nawait ${WRITER}(a);` },
      ], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/w.ts calls" },
    { n: "13 FABLE B1b — barrel via a specifier containing no 'ingest'", files: [
        { rel: "lib/ingest/barrel.ts", code: `export { ${WRITER} } from "./index";` },
        { rel: "lib/w.ts", code: `import { ${WRITER} } from "@/lib/ingest/barrel";\nawait ${WRITER}(a);` },
      ], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/w.ts calls" },
    { n: "14 FABLE B1c — export * barrel", files: [
        { rel: "lib/star.ts", code: `export * from "@/lib/ingest";` },
        { rel: "lib/w.ts", code: `import { ${WRITER} } from "@/lib/star";\nawait ${WRITER}(a);` },
      ], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/w.ts calls" },
    { n: "15 FABLE B2 — two-step dynamic import", files: [{ rel: "lib/f.ts", code: `const mod = await import("@/lib/ingest");\nconst { ${WRITER} } = mod;\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/f.ts calls" },
    { n: "16 FABLE B2b — require() destructure", files: [{ rel: "lib/f.ts", code: `const { ${WRITER} } = require("../lib/ingest");\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/f.ts calls" },
    { n: "17 FABLE B2c — import = require()", files: [{ rel: "lib/f.ts", code: `import ingest = require("@/lib/ingest");\nawait ingest.${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" , msg: "lib/f.ts calls" },
    { n: "18 FABLE B3 — comma-expression indirect call", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nawait (0, ${WRITER})(a);` }], inv: NO_INVENTORY, kind: "refused", msg: "used as BinaryExpression" },
    { n: "19 FABLE B3b — .call/.apply", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nawait ${WRITER}.call(null, a);` }], inv: NO_INVENTORY, kind: "refused" , msg: "used as PropertyAccessExpression" },
    { n: "20 FABLE B3c — passed as an argument", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nregister(${WRITER});` }], inv: NO_INVENTORY, kind: "refused" , msg: "used as CallExpression" },
    { n: "21 namespace passed as a value", files: [{ rel: "lib/f.ts", code: `import * as ingest from "@/lib/ingest";\nregister(ingest);` }], inv: NO_INVENTORY, kind: "refused" , msg: "namespace `ingest` used as CallExpression" },
    // ── Codex's demonstrated defeats (it compiled them clean and the guard stayed 40/40) ───────
    { n: "24 CODEX B1 — RENAMED re-export barrel", files: [
        { rel: "lib/barrel.ts", code: `export { ${WRITER} as writeItem } from "@/lib/ingest";` },
        { rel: "lib/w.ts", code: `import { writeItem } from "@/lib/barrel";\nawait writeItem(a);` },
      ], inv: NO_INVENTORY, kind: "unclassified", msg: "lib/w.ts calls" },
    { n: "25 CODEX B1b — DEFAULT re-export barrel", files: [
        { rel: "lib/barrel.ts", code: `export { ${WRITER} as default } from "@/lib/ingest";` },
        { rel: "lib/w.ts", code: `import w from "@/lib/barrel";\nawait w(a);` },
      ], inv: NO_INVENTORY, kind: "unclassified", msg: "lib/w.ts calls" },
    { n: "26 CODEX B1c — renamed barrel, then renamed AGAIN on import", files: [
        { rel: "lib/barrel.ts", code: `export { ${WRITER} as writeItem } from "@/lib/ingest";` },
        { rel: "lib/w.ts", code: `import { writeItem as w2 } from "@/lib/barrel";\nawait w2(a);` },
      ], inv: NO_INVENTORY, kind: "unclassified", msg: "lib/w.ts calls" },
    { n: "27 a reconcile that is NOT awaited does not satisfy its class", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nawait ${WRITER}(a);\nafter(async () => { reconcileItemContext(db, t, id); });` }], inv: classified("lib/f.ts", "RECONCILES_AFTER_RESPONSE"), kind: "shape", msg: "no reconcileItemContext inside an after() callback" },
    // ── Two rules added in the Fable fold whose mutations SURVIVED: nothing pinned them ────────
    { n: "22 the per-entry site COUNT is wrong (a new call site appeared)", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nawait ${WRITER}(a);\nawait ${WRITER}(b);` }], inv: classified("lib/f.ts", "SWEEP_COVERED", 1), kind: "stale" , msg: "INVENTORY says 1" },
    // ONE CONDITION PER FIXTURE: the reconcile sits inside a bare `after(...)`, so the
    // insideAfter rule is SATISFIED and `aliasedAfter` is the only rule that can fire. The first
    // version of this row called `later(...)` instead, which tripped BOTH — and its mutation
    // SURVIVED, because deleting the aliased-after rule left the other one failing it anyway.
    { n: "23 `after` imported under another name — the shape check cannot judge it", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nimport { after as later } from "next/server";\nawait ${WRITER}(a);\nafter(async () => { await reconcileItemContext(db, t, id); });` }], inv: classified("lib/f.ts", "RECONCILES_AFTER_RESPONSE"), kind: "shape", msg: "imports `after` under another name" },
    // ── Positive twins: without these, a guard that always failed would pass every row above ────
    { n: "T1 a LOCAL function of the same name, CALLED", files: [{ rel: "lib/f.ts", code: `function ${WRITER}(x: string){ return x; }\nexport const y = ${WRITER}("a");` }], inv: NO_INVENTORY, kind: null },
    { n: "T1b FABLE H1 — a LOCAL function of the same name, used as a VALUE", files: [{ rel: "lib/f.ts", code: `function ${WRITER}(x: string){ return x; }\nexport const registry = { ${WRITER} };` }], inv: NO_INVENTORY, kind: null },
    { n: "T1c CODEX H1 — a PARAMETER shadowing a real canonical import", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nexport function callInjected(${WRITER}: () => void) { ${WRITER}(); }\nexport type W = typeof ${WRITER};` }], inv: NO_INVENTORY, kind: null },
    { n: "T1d a LOCAL const shadowing a real canonical import inside a block", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nexport function f() { const ${WRITER} = (x: number) => x; return ${WRITER}(1); }` }], inv: NO_INVENTORY, kind: null },
    { n: "T2 a dynamic import of another module, no call", files: [{ rel: "lib/f.ts", code: `const { other } = await import("@/lib/other");` }], inv: NO_INVENTORY, kind: null },
    { n: "T3 canonical import used only in a TYPE position", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\ntype F = typeof ${WRITER};\nexport const z: F | null = null;` }], inv: NO_INVENTORY, kind: null },
    { n: "T4 a namespace's OTHER exports are not our business", files: [{ rel: "lib/f.ts", code: `import * as ingest from "@/lib/ingest";\nawait ingest.somethingElse(a);` }], inv: NO_INVENTORY, kind: null },
    { n: "T5 a writer barrel's OTHER exports are importable without penalty", files: [
        { rel: "lib/barrel.ts", code: `export { ${WRITER}, somethingElse, andAnother } from "@/lib/ingest";` },
        { rel: "lib/w.ts", code: `import { somethingElse, andAnother } from "@/lib/barrel";\nsomethingElse();\nandAnother();` },
      ], inv: NO_INVENTORY, kind: null },
  ];

  it.each(CONTROLS)("AC2 — control $n", ({ files, inv, kind, msg }) => {
    const { violations } = analyse(files, inv);
    if (kind === null) {
      expect(violations.map((v) => v.message)).toEqual([]);
      return;
    }
    expect(violations.map((v) => v.kind)).toContain(kind);
    // Fable L2: asserting the KIND alone lets a control pass while failing for a different
    // same-kind reason. Where a row names its message, the specific rule must be the one that fired.
    if (msg) expect(violations.map((v) => v.message).join("\n")).toContain(msg);
  });

  it("AC9 — every top-level directory IN THE REPOSITORY is accounted for", () => {
    // Fable HIGH 2: the previous roots list silently omitted `components/` (109 shipped files).
    // Coverage must not shrink as the repo grows, so a NEW top-level directory fails here until
    // someone decides which list it belongs in.
    //
    // ⚠️ ASK GIT, NOT THE FILESYSTEM — and it took CI two failures to teach me that. Asserting
    // against `readdirSync(ROOT)` asks "what is on this disk", which is not a property of the
    // repository and gave a different answer three ways:
    //   1. it passed here and failed on a clean runner, because `supabase/` is GITIGNORED — a
    //      leftover from the Postgres migration that exists only on my machine;
    //   2. weakening it to a subset check then passed everywhere EXCEPT the CI job that runs
    //      `npm run coverage`, because that command CREATES `coverage/` before this test reads the
    //      directory listing — the harness manufacturing the very thing the assertion complains
    //      about;
    //   3. the next build artifact would have done it again.
    // Tracked paths are the same on every machine and in every job, so equality is safe again —
    // and equality also catches a STALE entry, which the subset form could not.
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .filter((f) => f.includes("/"))
      .map((f) => f.slice(0, f.indexOf("/")))
      .filter((d) => !d.startsWith("."));
    expect([...new Set(tracked)].sort()).toEqual([...WALKED, ...Object.keys(NOT_WALKED)].sort());
  });

  it("AC10 — the walk actually reaches components/ and the root-level sources", () => {
    // Set-equality (AC3) proves the INVENTORY is exact; it cannot prove the walk is wide, because a
    // narrower walk finds the same seven writers. This is the coverage half, asserted separately.
    const files = productionFiles();
    expect(files.some((f) => f.startsWith("components/")), "components/ must be walked").toBe(true);
    expect(files, "root-level server sources must be walked").toContain("instrumentation.ts");
    expect(files.length).toBeGreaterThan(500);
  }, REAL_TREE_TIMEOUT_MS);

  it("AC4 — a stale classification fails even when the tree is otherwise clean", () => {
    const { violations } = analyse(realFiles(), { ...INVENTORY, "lib/gone.ts": { sites: 1, class: "SWEEP_COVERED", reason: "r", latency: "l" } });
    expect(violations.map((v) => v.kind)).toEqual(["stale"]);
    expect(violations[0].message).toContain("lib/gone.ts");
  }, REAL_TREE_TIMEOUT_MS);

  it("AC5 — the three classes carry DISTINCT obligations", () => {
    const afterCode = `${IMPORT_CANON}\nawait ${WRITER}(a);\nafter(async () => { await reconcileItemContext(db, t, id); });`;
    const inlineCode = `${IMPORT_CANON}\nawait ${WRITER}(a);\nawait reconcileItemContext(db, t, id);`;
    const rel = "lib/f.ts";
    // Each class accepts its OWN shape …
    expect(analyse([{ rel, code: afterCode }], classified(rel, "RECONCILES_AFTER_RESPONSE")).violations).toEqual([]);
    expect(analyse([{ rel, code: inlineCode }], classified(rel, "RECONCILES_INLINE")).violations).toEqual([]);
    // … and REJECTS the other's, which is what proves they are not one class wearing three names.
    expect(analyse([{ rel, code: inlineCode }], classified(rel, "RECONCILES_AFTER_RESPONSE")).violations).toHaveLength(1);
    expect(analyse([{ rel, code: afterCode }], classified(rel, "RECONCILES_INLINE")).violations).toHaveLength(1);
    // A RECONCILES_* file with no reconcile at all fails both.
    const none = `${IMPORT_CANON}\nawait ${WRITER}(a);`;
    expect(analyse([{ rel, code: none }], classified(rel, "RECONCILES_AFTER_RESPONSE")).violations).toHaveLength(1);
    expect(analyse([{ rel, code: none }], classified(rel, "RECONCILES_INLINE")).violations).toHaveLength(1);
  });

  it("AC7 — an undecidable binding is REFUSED, not ignored", () => {
    const { violations } = analyse(
      // ONE CONDITION: the writer is only ever PASSED, never called, so the position refusal is the
      // only rule that can fire. The first version also called it, producing a second violation and
      // letting the assertion pass for the wrong reason (Codex HIGH 2).
      [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nregisterWriter(${WRITER});` }],
      NO_INVENTORY
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("refused");
    expect(violations[0].message).toContain("used as CallExpression");
  });

  it("AC8 — a barrel's exported ALIAS is what consumers are bound on", () => {
    // Codex BLOCKER 1: the module was correctly identified as a writer module and then consumers
    // were bound on the literal name `ingestItem`, losing the barrel's alias. Asserted on the
    // EXPORT MAP directly, so the property is pinned independently of any single control row.
    const files = [
      { rel: "lib/b1.ts", code: `export { ${WRITER} as writeItem } from "@/lib/ingest";` },
      { rel: "lib/b2.ts", code: `export { writeItem as second } from "@/lib/b1";` },
      { rel: "lib/b3.ts", code: `export * from "@/lib/b2";` },
    ];
    const map = writerExports(files, new Set(files.map((f) => f.rel)));
    expect([...(map.get("lib/b1.ts") ?? [])]).toEqual(["writeItem"]);
    expect([...(map.get("lib/b2.ts") ?? [])]).toEqual(["second"]);
    expect([...(map.get("lib/b3.ts") ?? [])], "export * keeps each upstream spelling").toEqual(["second"]);
  });

  it("AC8b — no re-export barrel of the writer exists in the real tree today", () => {
    // If one ever appears, `bindingsFor` refuses a SECOND level rather than missing it silently.
    // Asserted here because otherwise that branch is unreachable and therefore untested.
    const barrels = productionFiles().filter(
      (rel) => /^lib\/ingest\//.test(rel) && rel !== CANONICAL && /export\s[^;]*\sfrom\s+["'][^"']*ingest/.test(read(rel))
    );
    expect(barrels, "a new lib/ingest barrel needs the second-level refusal exercised").toEqual([]);
  }, REAL_TREE_TIMEOUT_MS);
});

/* ───── the four assertions this guard shipped with (#530) — kept, unchanged ───── */

describe("§11 context-partition call sites", () => {
  it("the items push route reconciles context after the response", () => {
    const src = read("app/api/v1/items/route.ts");
    expect(src).toMatch(/reconcileItemContext/);
    // the reconcile must be INSIDE an after() block (not merely that the file uses after()
    // somewhere — pm-sync already does): require after(async ...) with reconcileItemContext in it.
    expect(src, "must run in after(), not inline (never blocks the push)").toMatch(/after\(async[\s\S]{0,400}reconcileItemContext/);
    // The load-bearing OR: the hook must ALSO fire when a heal-path tier flip returns
    // status:'unchanged' (Codex Medium — this was mutation-vacuous). Deleting the OR must redden.
    expect(src, "must fire on a heal-path tier flip (accessChanged), not only status change").toMatch(/result\.accessChanged/);
  });

  it("the scheduler tick runs the context-backfill convergence leg", () => {
    const src = read("lib/ingest/scheduler.ts");
    expect(src).toMatch(/await runContextBackfill\(db\);/);
    expect(src).toMatch(/backfillAllTeams/);
  });

  it("the admin action wires to the backfill through the admin guard", () => {
    const src = read("app/t/[team]/admin/access/actions.ts");
    expect(src).toMatch(/backfillTeamContext\s*\(/);
    expect(src).toMatch(/requireAdmin\s*\(/);
    expect(src, "must gate execution on the admin check").toMatch(/if \(!ctx\) return/);
  });

  it("the backfill and the ingest hook share ONE reconcile core (no divergent partitioning)", () => {
    // Both must go through reconcileItemContext — if the backfill re-inlined its own routing,
    // the two paths could partition an item differently. Pin the shared dependency.
    expect(read("lib/projects/context/backfill.ts")).toMatch(/reconcileItemContext/);
    expect(read("lib/projects/context/reconcile-item.ts")).toMatch(/closeMembershipInto/);
  });
});

/* ═════════════ AUDITFIX-18 — the ENTRY SURFACES, by reverse import closure ═════════════ */

/**
 * The limit this file's own header names — "A NEW ENTRY SURFACE THAT CALLS AN EXISTING,
 * ALREADY-CLASSIFIED WRAPPER" — is what the criteria below close.
 *
 * The analysis lives in `./entry-surface-graph` so fixtures and the real tree run the SAME code
 * (a second copy in here would only prove the copy agrees with itself). The direct-writer half
 * above is untouched: it keeps its exact counts and structural obligations, and the two inventories
 * answer different questions — WHO WRITES (structural, checkable) vs WHO CAN REACH THE WRITER
 * (a review declaration, explicitly not a claim that an ingest runs there).
 */

const SEED = { rel: CANONICAL, code: `export async function ${WRITER}(db, auth, p, team) { return { id: "i1" }; }` };

/** A plain `lib/` wrapper: one hop from the seed, and never a surface itself. */
const WRAP = (rel = "lib/wrap.ts", prefix = "") => ({
  rel,
  code: `${prefix}${IMPORT_CANON}\nexport type WOpts = { team: string };\nexport const w = async (a) => ${WRITER}(a);\nexport const readOnly = () => "no write here";`,
});

/** The real topology of the escape: route → ingestCodebaseScan → projectCommitsToItems → writer. */
const WRAPPER_CHAIN = [
  SEED,
  {
    rel: "lib/codebases/commits-to-items.ts",
    code: `${IMPORT_CANON}\nexport async function projectCommitsToItems(a) { await ${WRITER}(a); }`,
  },
  {
    rel: "lib/codebases/ingest.ts",
    code: `import { projectCommitsToItems } from "@/lib/codebases/commits-to-items";\nexport async function ingestCodebaseScan(a) { await projectCommitsToItems(a); }`,
  },
  {
    rel: "app/api/v1/codebases/route.ts",
    code: `import { ingestCodebaseScan } from "@/lib/codebases/ingest";\nexport async function POST() { await ingestCodebaseScan({}); }`,
  },
];
const NEW_ROUTE = {
  rel: "app/api/v2/scans/route.ts",
  code: `import { ingestCodebaseScan } from "@/lib/codebases/ingest";\nexport async function POST() { await ingestCodebaseScan({}); }`,
};

const REC = (cls: EntryClass = "IMPORT_ONLY", reason = "fixture: enters through lib/codebases/ingest.ts"): EntryRecord => ({ class: cls, reason });
const entryInv = (...rels: string[]): Record<string, EntryRecord> => Object.fromEntries(rels.map((r) => [r, REC()]));
const NO_ENTRIES: Record<string, EntryRecord> = {};

/** Kinds that mean "the analysis could not see something", as opposed to "a record is missing". */
const DIAGNOSTIC_KINDS: EntryViolationKind[] = ["unresolved", "refused-load", "unsupported-alias", "parse", "stale-exception", "excluded-ref"];
const diagnostics = (r: EntrySurfaceAnalysis) => r.violations.filter((v) => DIAGNOSTIC_KINDS.includes(v.kind)).map((v) => v.message);
const ofKind = (r: EntrySurfaceAnalysis, kind: EntryViolationKind) => r.violations.filter((v) => v.kind === kind);

/* ── a throwaway repository ROOT on disk, for the criteria that must exercise the REAL walk ──────
 *
 * Astra medium 1. The production file set is what the WALK YIELDS, and the walk is where excluded
 * sources are dropped — so a synthetic file list can only ever model "the excluded file does not
 * exist", never "it exists and the walk did not hand it over". Those are different inputs, and the
 * second is the one the real path actually produces. These fixtures therefore plant a miniature
 * repository in a temp directory and run `analyseTreeAt`, the same seam `AC18-07` runs against this
 * repository, with the root injected.
 *
 * Nothing is written inside this repository, and both halves of resolution — the walk's output AND
 * the file-existence evidence the seam supplies — are scoped to the INJECTED root, so no fixture can
 * reach the real tree. (The virtual fixtures get no host at all; `AC18-05b` and `AC18-05p` are the
 * two halves of that control.)
 */
const fixtureRoots: string[] = [];
afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(files: Record<string, string>): string {
  // realpath'd on creation: macOS hands out `/var/…` for a `/private/var/…` directory, and the
  // walk's symlink de-duplication compares realpaths against the root it was given.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "auditfix18-entry-")));
  fixtureRoots.push(root);
  // Every walked root EXISTS, used or not: the walk reads all four unconditionally, exactly as it
  // does here, and a fixture must not quietly require it to tolerate a missing one.
  for (const dir of WALKED) mkdirSync(join(root, dir), { recursive: true });
  for (const [rel, code] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), code);
  }
  return root;
}

/** The anchor surface every on-disk fixture keeps: proof the walk found the tree at all. */
const ANCHOR = "app/api/anchor/route.ts";

/** The miniature repository each on-disk fixture starts from: seed → wrapper → one anchor surface. */
const MINI_REPO: Record<string, string> = {
  // The WALK skips the canonical writer (it is not one of its own callers) and the GRAPH adds it
  // back as the seed. Planting it keeps the fixture an honest model of the real topology rather
  // than of a repository where the writer happens not to exist.
  "lib/ingest/index.ts": `export async function ${WRITER}(db, auth, p, team) { return { id: "i1" }; }`,
  "lib/wrap.ts": `${IMPORT_CANON}\nexport const w = async (a) => ${WRITER}(a);`,
  [ANCHOR]: `import { w } from "@/lib/wrap";\nexport async function POST(){ await w({}); }`,
};

describe("§11 entry surfaces — the REVERSE-IMPORT INVENTORY (AUDITFIX-18)", () => {
  it("AC18-02 — a NEW route through an ALREADY-CLASSIFIED wrapper fails, and the direct-writer set does not move", () => {
    const withNew = [...WRAPPER_CHAIN, NEW_ROUTE];

    // ── THE ESCAPE, stated as an equality. The old invariant literally cannot tell these apart:
    // the second route adds no `ingestItem` call site, so AC3's set-equality stays green while a
    // brand-new HTTP entry into the substrate ships unreviewed. If this equality ever breaks, the
    // fixture stopped modelling the escape and the criterion below is proving something else.
    expect(analyse(withNew, NO_INVENTORY).sites).toEqual(analyse(WRAPPER_CHAIN, NO_INVENTORY).sites);
    expect(analyse(withNew, NO_INVENTORY).sites).toEqual({ "lib/codebases/commits-to-items.ts": 1 });

    // ── and what the new analysis must do about it.
    const r = analyseEntrySurfaces(withNew, entryInv("app/api/v1/codebases/route.ts"));
    expect(r.surfaces, "the new route is an entry surface").toContain(NEW_ROUTE.rel);
    const missing = ofKind(r, "unclassified-entry");
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain(NEW_ROUTE.rel);
    // The WITNESS is the actionable half: a failure that says "unclassified" without saying how the
    // file reaches the writer sends the reader on the search this guard was built to do for them.
    expect(missing[0].message, "the failure must show the path to the writer").toContain("lib/codebases/ingest.ts");
    expect(missing[0].message).toContain(CANONICAL);
    expect(r.witness[NEW_ROUTE.rel]).toEqual([
      NEW_ROUTE.rel,
      "lib/codebases/ingest.ts",
      "lib/codebases/commits-to-items.ts",
      CANONICAL,
    ]);
  });

  it("AC18-02b — classifying that same surface with a concrete reason makes the SAME fixture pass", () => {
    // The positive twin. Without it, an analysis that failed everything would satisfy AC18-02.
    const r = analyseEntrySurfaces([...WRAPPER_CHAIN, NEW_ROUTE], entryInv("app/api/v1/codebases/route.ts", NEW_ROUTE.rel));
    expect(r.violations.map((v) => v.message)).toEqual([]);
  });

  it.each([
    { n: "an empty reason", rec: { class: "IMPORT_ONLY", reason: "" } as EntryRecord, kind: "blank-reason" as EntryViolationKind },
    { n: "a whitespace reason", rec: { class: "SWEEP_DEPENDENT", reason: "   " } as EntryRecord, kind: "blank-reason" as EntryViolationKind },
    { n: "a class nobody defined", rec: { class: "PROBABLY_FINE" as unknown as EntryClass, reason: "it looked ok" }, kind: "unknown-class" as EntryViolationKind },
  ])("AC18-02c — a record that is not a decision fails: $n", ({ rec, kind }) => {
    const inv = { "app/api/v1/codebases/route.ts": REC(), [NEW_ROUTE.rel]: rec };
    const r = analyseEntrySurfaces([...WRAPPER_CHAIN, NEW_ROUTE], inv);
    expect(r.violations.map((v) => v.kind)).toContain(kind);
    expect(r.violations.map((v) => v.message).join("\n")).toContain(NEW_ROUTE.rel);
  });

  it("AC18-02d — the closure comes from the GRAPH, never from the inventory", () => {
    // Seeding from the hand-maintained list would let an OMITTED entry erase its own callers — the
    // exact shape of the AUDITFIX-2 miss, one layer up. So the discovered set must be identical
    // whether the inventory is empty or full; only the violations may differ.
    const files = [...WRAPPER_CHAIN, NEW_ROUTE];
    const empty = analyseEntrySurfaces(files, NO_ENTRIES);
    const full = analyseEntrySurfaces(files, entryInv("app/api/v1/codebases/route.ts", NEW_ROUTE.rel));
    expect(empty.surfaces).toEqual(full.surfaces);
    expect(empty.closure).toEqual(full.closure);
    expect(empty.surfaces).toEqual(["app/api/v1/codebases/route.ts", NEW_ROUTE.rel]);
  });

  it("AC18-01 — a reached `lib/` module is a graph NODE, not a second inventory entry", () => {
    // The two inventories stay disjoint. `lib/codebases/commits-to-items.ts` is a direct writer with
    // its own INVENTORY record and structural obligations; it is traversed here (or the route above
    // could never be found) and it is NOT an entry surface, so it needs no entry record and the old
    // classification keeps meaning exactly what it meant.
    const r = analyseEntrySurfaces(WRAPPER_CHAIN, entryInv("app/api/v1/codebases/route.ts"));
    expect(r.closure).toContain("lib/codebases/commits-to-items.ts");
    expect(r.closure).toContain("lib/codebases/ingest.ts");
    expect(r.surfaces).toEqual(["app/api/v1/codebases/route.ts"]);
    expect(r.violations.map((v) => v.message)).toEqual([]);
  });

  // ── AC18-03: every SPELLING of a module edge reaches the seed ──────────────────────────────────
  //
  // AUDITFIX-1's guard was beaten three times by new spellings of one act and AUDITFIX-2's twice
  // more; the same lesson applies to edges rather than call sites. Each row is a spelling, and the
  // assertion is that the edge is FOLLOWED — not that the symbol is used, which this analysis
  // deliberately does not decide.
  const ROUTE = "app/api/x/route.ts";
  const FORMS: { n: string; files: { rel: string; code: string }[]; reaches: string[]; surfaces: string[] }[] = [
    { n: "01 named import", files: [SEED, WRAP(), { rel: ROUTE, code: `import { w } from "@/lib/wrap";\nexport async function POST(){ await w({}); }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "02 renamed import", files: [SEED, WRAP(), { rel: ROUTE, code: `import { w as go } from "@/lib/wrap";\nexport async function POST(){ await go({}); }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "03 default import", files: [SEED, { rel: "lib/wrap.ts", code: `${IMPORT_CANON}\nexport default async function wrap(a){ await ${WRITER}(a); }` }, { rel: ROUTE, code: `import wrap from "@/lib/wrap";\nexport async function POST(){ await wrap({}); }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "04 namespace import", files: [SEED, WRAP(), { rel: ROUTE, code: `import * as wrap from "@/lib/wrap";\nexport async function POST(){ await wrap.w({}); }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "05 side-effect import, no bindings at all", files: [SEED, WRAP(), { rel: ROUTE, code: `import "@/lib/wrap";\nexport async function POST(){ return null; }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "06 export-from, named", files: [SEED, WRAP(), { rel: "lib/barrel.ts", code: `export { w } from "@/lib/wrap";` }, { rel: ROUTE, code: `import { w } from "@/lib/barrel";\nexport async function POST(){ await w({}); }` }], reaches: ["lib/wrap.ts", "lib/barrel.ts"], surfaces: [ROUTE] },
    { n: "07 export-from, renamed", files: [SEED, WRAP(), { rel: "lib/barrel.ts", code: `export { w as write } from "@/lib/wrap";` }, { rel: ROUTE, code: `import { write } from "@/lib/barrel";\nexport async function POST(){ await write({}); }` }], reaches: ["lib/wrap.ts", "lib/barrel.ts"], surfaces: [ROUTE] },
    { n: "08 export * from", files: [SEED, WRAP(), { rel: "lib/barrel.ts", code: `export * from "@/lib/wrap";` }, { rel: ROUTE, code: `import { w } from "@/lib/barrel";\nexport async function POST(){ await w({}); }` }], reaches: ["lib/wrap.ts", "lib/barrel.ts"], surfaces: [ROUTE] },
    { n: "09 export * as ns from", files: [SEED, WRAP(), { rel: "lib/barrel.ts", code: `export * as wrap from "@/lib/wrap";` }, { rel: ROUTE, code: `import { wrap } from "@/lib/barrel";\nexport async function POST(){ await wrap.w({}); }` }], reaches: ["lib/wrap.ts", "lib/barrel.ts"], surfaces: [ROUTE] },
    { n: "10 import = require()", files: [SEED, WRAP(), { rel: ROUTE, code: `import wrap = require("@/lib/wrap");\nexport async function POST(){ await wrap.w({}); }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "11 awaited literal dynamic import", files: [SEED, WRAP(), { rel: ROUTE, code: `export async function POST(){ const { w } = await import("@/lib/wrap"); await w({}); }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "12 UN-awaited literal dynamic import", files: [SEED, WRAP(), { rel: ROUTE, code: `const pending = import("@/lib/wrap");\nexport async function POST(){ return pending; }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "13 require() buried deep in the AST", files: [SEED, WRAP(), { rel: ROUTE, code: `export async function POST(cond){ if (cond) { for (const k of []) { return require("@/lib/wrap").w(k); } } }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "14 directory index", files: [SEED, WRAP("lib/wrap/index.ts"), { rel: ROUTE, code: `import { w } from "@/lib/wrap";\nexport async function POST(){ await w({}); }` }], reaches: ["lib/wrap/index.ts"], surfaces: [ROUTE] },
    { n: "15 explicit .ts extension", files: [SEED, WRAP(), { rel: ROUTE, code: `import { w } from "@/lib/wrap.ts";\nexport async function POST(){ await w({}); }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "16 emitted .js name → the .ts source", files: [SEED, WRAP(), { rel: ROUTE, code: `import { w } from "@/lib/wrap.js";\nexport async function POST(){ await w({}); }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "17 emitted .jsx name → the .tsx source", files: [SEED, WRAP("lib/wrap.tsx"), { rel: ROUTE, code: `import { w } from "@/lib/wrap.jsx";\nexport async function POST(){ await w({}); }` }], reaches: ["lib/wrap.tsx"], surfaces: [ROUTE] },
    { n: "18 emitted .mjs name → the .mts source", files: [SEED, WRAP("lib/wrap.mts"), { rel: ROUTE, code: `import { w } from "@/lib/wrap.mjs";\nexport async function POST(){ await w({}); }` }], reaches: ["lib/wrap.mts"], surfaces: [ROUTE] },
    { n: "19 emitted .cjs name → the .cts source", files: [SEED, WRAP("lib/wrap.cts"), { rel: ROUTE, code: `import { w } from "@/lib/wrap.cjs";\nexport async function POST(){ await w({}); }` }], reaches: ["lib/wrap.cts"], surfaces: [ROUTE] },
    { n: "20 RELATIVE specifier (the spelling already in this tree)", files: [SEED, WRAP(), { rel: "scripts/tool.ts", code: `import { w } from "../lib/wrap";\nawait w({});` }], reaches: ["lib/wrap.ts"], surfaces: ["scripts/tool.ts"] },
    { n: "21 a .cjs source with require()", files: [SEED, WRAP(), { rel: "scripts/tool.cjs", code: `const { w } = require("../lib/wrap");\nw({});` }], reaches: ["lib/wrap.ts"], surfaces: ["scripts/tool.cjs"] },
    { n: "22 an imported symbol that is NEVER CALLED still keeps the edge", files: [SEED, WRAP(), { rel: ROUTE, code: `import { w } from "@/lib/wrap";\nexport const unused = 1;` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "23 a MIXED value/type import keeps the edge", files: [SEED, WRAP(), { rel: ROUTE, code: `import { w, type WOpts } from "@/lib/wrap";\nexport async function POST(o: WOpts){ await w(o); }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
    { n: "24 a READER imported from a writer-bearing module still enters", files: [SEED, WRAP(), { rel: ROUTE, code: `import { readOnly } from "@/lib/wrap";\nexport function GET(){ return readOnly(); }` }], reaches: ["lib/wrap.ts"], surfaces: [ROUTE] },
  ];

  it.each(FORMS)("AC18-03 — the edge is followed: $n", ({ files, reaches, surfaces }) => {
    const r = analyseEntrySurfaces(files, NO_ENTRIES);
    for (const rel of reaches) expect(r.closure, `${rel} must be reached`).toContain(rel);
    for (const rel of surfaces) expect(r.surfaces, `${rel} must be an entry surface`).toContain(rel);
    // A form that quietly REFUSED would also "not miss" the edge; separate the two outcomes.
    expect(diagnostics(r), "this form must resolve cleanly, not be refused").toEqual([]);
  });

  it("AC18-03b — a four-edge chain declared in REVERSE order reaches the seed, with the exact closure", () => {
    // File order is an accident of the walk; the fixpoint must not depend on it. The surface is
    // listed FIRST and the writer LAST, which is the order a single forward pass handles worst.
    const page = "app/t/[team]/scans/page.tsx";
    const files = [
      { rel: page, code: `import { d } from "@/lib/d";\nexport default function P(){ return d; }` },
      { rel: "lib/d.ts", code: `export { c as d } from "@/lib/c";` },
      { rel: "lib/c.ts", code: `import { b } from "@/lib/b";\nexport const c = b;` },
      { rel: "lib/b.ts", code: `import { a } from "@/lib/a";\nexport const b = a;` },
      { rel: "lib/a.ts", code: `${IMPORT_CANON}\nexport const a = async (x) => ${WRITER}(x);` },
      SEED,
    ];
    const r = analyseEntrySurfaces(files, NO_ENTRIES);
    expect(r.closure).toEqual([CANONICAL, page, "lib/a.ts", "lib/b.ts", "lib/c.ts", "lib/d.ts"].sort());
    expect(r.surfaces).toEqual([page]);
    expect(r.witness[page]).toEqual([page, "lib/d.ts", "lib/c.ts", "lib/b.ts", "lib/a.ts", CANONICAL]);
  });

  it("AC18-03c — an import CYCLE terminates, with the exact closure", () => {
    const files = [
      SEED,
      { rel: "lib/cycle-a.ts", code: `${IMPORT_CANON}\nimport { b } from "@/lib/cycle-b";\nexport const a = async (x) => { await ${WRITER}(x); return b; };` },
      { rel: "lib/cycle-b.ts", code: `import { a } from "@/lib/cycle-a";\nexport const b = a;` },
      { rel: "scripts/run-cycle.ts", code: `import { b } from "@/lib/cycle-b";\nb();` },
    ];
    const r = analyseEntrySurfaces(files, NO_ENTRIES);
    expect(r.closure).toEqual([CANONICAL, "lib/cycle-a.ts", "lib/cycle-b.ts", "scripts/run-cycle.ts"].sort());
    expect(r.surfaces).toEqual(["scripts/run-cycle.ts"]);
    expect(r.witness["scripts/run-cycle.ts"]).toEqual(["scripts/run-cycle.ts", "lib/cycle-b.ts", "lib/cycle-a.ts", CANONICAL]);
  });

  it("AC18-03d — the witness is the SHORTEST chain, ties broken lexicographically, order-independent", () => {
    // Two equal-length paths exist. Without a stated tie-break the diagnostic flips between runs and
    // between file orderings, and a flapping witness is a diagnostic nobody trusts or can diff.
    const hop = (rel: string) => ({ rel, code: `${IMPORT_CANON}\nexport const w = async (x) => ${WRITER}(x);` });
    const route = { rel: ROUTE, code: `import { w as z } from "@/lib/zeta";\nimport { w as a } from "@/lib/alpha";\nexport async function POST(){ await z({}); await a({}); }` };
    const files = [SEED, hop("lib/zeta.ts"), hop("lib/alpha.ts"), route];
    const expected = [ROUTE, "lib/alpha.ts", CANONICAL];
    expect(analyseEntrySurfaces(files, NO_ENTRIES).witness[ROUTE]).toEqual(expected);
    expect(analyseEntrySurfaces([...files].reverse(), NO_ENTRIES).witness[ROUTE], "reversing the input must not move the witness").toEqual(expected);
  });

  // ── AC18-04: what IS a surface, what is only a node, and what never enters at all ─────────────
  const SURFACES: { n: string; files: { rel: string; code: string }[]; surface: string }[] = [
    { n: "an API route", files: [SEED, WRAP(), { rel: ROUTE, code: `import { w } from "@/lib/wrap";\nexport async function POST(){ await w({}); }` }], surface: ROUTE },
    { n: "a page", files: [SEED, WRAP(), { rel: "app/t/[team]/scans/page.tsx", code: `import { w } from "@/lib/wrap";\nexport default function P(){ return w; }` }], surface: "app/t/[team]/scans/page.tsx" },
    { n: "a layout", files: [SEED, WRAP(), { rel: "app/t/[team]/layout.tsx", code: `import { w } from "@/lib/wrap";\nexport default function L({ children }){ return children ?? w; }` }], surface: "app/t/[team]/layout.tsx" },
    { n: "a server-action file", files: [SEED, WRAP(), { rel: "app/t/[team]/admin/x/actions.ts", code: `"use server";\nimport { w } from "@/lib/wrap";\nexport async function run(){ await w({}); }` }], surface: "app/t/[team]/admin/x/actions.ts" },
    { n: "a component", files: [SEED, WRAP(), { rel: "components/Widget.tsx", code: `import { w } from "@/lib/wrap";\nexport function Widget(){ return null; }` }], surface: "components/Widget.tsx" },
    { n: "a .jsx component (the extension the old walk never read)", files: [SEED, WRAP(), { rel: "components/Legacy.jsx", code: `import { w } from "@/lib/wrap";\nexport function Legacy(){ return null; }` }], surface: "components/Legacy.jsx" },
    { n: "a CLI script", files: [SEED, WRAP(), { rel: "scripts/tool.ts", code: `import { w } from "@/lib/wrap";\nawait w({});` }], surface: "scripts/tool.ts" },
    { n: "a script HELPER, not the entry file", files: [SEED, WRAP(), { rel: "scripts/lib/helper.ts", code: `import { w } from "@/lib/wrap";\nexport const help = () => w;` }], surface: "scripts/lib/helper.ts" },
    { n: "a root-level source", files: [SEED, WRAP(), { rel: "boot-hook.ts", code: `export async function register(){ const { w } = await import("@/lib/wrap"); await w({}); }` }], surface: "boot-hook.ts" },
    { n: "a lib file with a SOURCE-level `use server` directive", files: [SEED, WRAP(), { rel: "lib/x/actions.ts", code: `"use server";\nimport { w } from "@/lib/wrap";\nexport async function run(){ await w({}); }` }], surface: "lib/x/actions.ts" },
    { n: "a lib file with a FUNCTION-BODY `use server` directive", files: [SEED, WRAP(), { rel: "lib/y/actions.ts", code: `import { w } from "@/lib/wrap";\nexport async function run(){ "use server";\n await w({}); }` }], surface: "lib/y/actions.ts" },
    // The body-bearing forms are not just `function` declarations: an action written as an arrow
    // (the common `export const run = async () => { "use server"; … }`) must still be a surface, so
    // narrowing the directive walk to declarations alone reddens here.
    { n: "a lib file with an ARROW-BODY `use server` directive", files: [SEED, WRAP(), { rel: "lib/arrow/actions.ts", code: `import { w } from "@/lib/wrap";\nexport const run = async () => { "use server";\n await w({}); };` }], surface: "lib/arrow/actions.ts" },
    { n: "a lib file with a METHOD-BODY `use server` directive", files: [SEED, WRAP(), { rel: "lib/method/actions.ts", code: `import { w } from "@/lib/wrap";\nexport class Runner { async run(){ "use server";\n await w({}); } }` }], surface: "lib/method/actions.ts" },
    { n: "a lib file whose directive follows a \"use strict\" prologue entry", files: [SEED, WRAP(), { rel: "lib/z/actions.ts", code: `"use strict";\n"use server";\nimport { w } from "@/lib/wrap";\nexport async function run(){ await w({}); }` }], surface: "lib/z/actions.ts" },
  ];

  it.each(SURFACES)("AC18-04 — a surface needing a record: $n", ({ files, surface }) => {
    const unclassified = analyseEntrySurfaces(files, NO_ENTRIES);
    expect(unclassified.surfaces).toContain(surface);
    expect(ofKind(unclassified, "unclassified-entry").map((v) => v.message).join("\n")).toContain(surface);
    // …and its positive twin in the same row, so a "fail everything" analysis satisfies neither half.
    const withRecord = analyseEntrySurfaces(files, entryInv(surface));
    expect(withRecord.violations.map((v) => v.message)).toEqual([]);
    expect(diagnostics(unclassified)).toEqual([]);
  });

  const NODES_NOT_SURFACES: { n: string; code: string }[] = [
    { n: "a plain lib wrapper", code: `import { w } from "@/lib/wrap";\nexport const passthrough = w;` },
    { n: "`use server` in a COMMENT", code: `// "use server"\nimport { w } from "@/lib/wrap";\nexport const p = w;` },
    { n: "`use server` as a TYPE", code: `import { w } from "@/lib/wrap";\nexport type Mode = "use server";\nexport const p = w;` },
    { n: "`use server` as an arbitrary expression", code: `import { w } from "@/lib/wrap";\nexport const mode = "use server";\nexport const p = w;` },
    { n: "`use server` AFTER a statement (not a prologue)", code: `import { w } from "@/lib/wrap";\nexport const p = w;\n"use server";` },
    { n: "`use server` as a TEMPLATE literal (not a directive)", code: "`use server`;\nimport { w } from \"@/lib/wrap\";\nexport const p = w;" },
    { n: "`use server` inside a function body but NOT in its prologue", code: `import { w } from "@/lib/wrap";\nexport async function run(){ const a = 1; "use server";\n await w({ a }); }` },
  ];

  it.each(NODES_NOT_SURFACES)("AC18-04b — traversed, but NOT a surface: $n", ({ code }) => {
    const rel = "lib/candidate.ts";
    const r = analyseEntrySurfaces([SEED, WRAP(), { rel, code }], NO_ENTRIES);
    expect(r.closure, "it is still a graph node — the traversal must go THROUGH it").toContain(rel);
    expect(r.surfaces).not.toContain(rel);
    expect(r.violations.map((v) => v.message), "a non-surface node needs no entry record").toEqual([]);
  });

  const NEVER_ENTERS: { n: string; files: { rel: string; code: string }[] }[] = [
    { n: "import type", files: [SEED, WRAP(), { rel: ROUTE, code: `import type { WOpts } from "@/lib/wrap";\nexport async function POST(o: WOpts){ return o; }` }] },
    { n: "export type … from", files: [SEED, WRAP(), { rel: ROUTE, code: `export type { WOpts } from "@/lib/wrap";` }] },
    { n: "a wholly type-only named import", files: [SEED, WRAP(), { rel: ROUTE, code: `import { type WOpts } from "@/lib/wrap";\nexport async function POST(o: WOpts){ return o; }` }] },
    { n: "an import-TYPE expression", files: [SEED, WRAP(), { rel: ROUTE, code: `type M = typeof import("@/lib/wrap");\nexport const m: M | null = null;` }] },
    { n: "an unrelated module", files: [SEED, WRAP(), { rel: "lib/other.ts", code: `export const other = 1;` }, { rel: ROUTE, code: `import { other } from "@/lib/other";\nexport async function POST(){ return other; }` }] },
    { n: "the specifier as a STRING, not an import", files: [SEED, WRAP(), { rel: ROUTE, code: `const spec = "@/lib/wrap";\nexport async function POST(){ return spec; }` }] },
    { n: "a LOCAL function with the wrapper's export name", files: [SEED, WRAP(), { rel: ROUTE, code: `function w(x){ return x; }\nexport async function POST(){ return w(1); }` }] },
  ];

  it.each(NEVER_ENTERS)("AC18-04c — an innocent twin that never enters the closure: $n", ({ files }) => {
    const r = analyseEntrySurfaces(files, NO_ENTRIES);
    expect(r.closure, "the wrapper itself is still reached").toContain("lib/wrap.ts");
    expect(r.closure).not.toContain(ROUTE);
    expect(r.closure).not.toContain("lib/other.ts");
    expect(r.surfaces).toEqual([]);
    expect(r.violations.map((v) => v.message)).toEqual([]);
  });

  // ── AC18-05: resolution, and every way a reference could disappear quietly ────────────────────
  it.each([
    { n: ".ts", rel: "lib/a.ts", ok: true },
    { n: ".tsx", rel: "components/A.tsx", ok: true },
    { n: ".mts", rel: "lib/a.mts", ok: true },
    { n: ".cts", rel: "lib/a.cts", ok: true },
    { n: ".js", rel: "scripts/a.js", ok: true },
    { n: ".jsx (added by this slice)", rel: "components/A.jsx", ok: true },
    { n: ".mjs", rel: "scripts/a.mjs", ok: true },
    { n: ".cjs", rel: "scripts/a.cjs", ok: true },
    { n: "a .d.ts declaration", rel: "lib/a.d.ts", ok: false },
    { n: "a .d.mts declaration", rel: "lib/a.d.mts", ok: false },
    { n: "a test source", rel: "test/guards/a.test.ts", ok: false },
    { n: "a .tsx test source", rel: "components/a.test.tsx", ok: false },
    { n: "the in-memory PostgREST double", rel: "lib/ingest/fake-supabase.ts", ok: false },
    { n: "the canonical writer (the graph adds it as its SEED, not as a walked node)", rel: CANONICAL, ok: false },
    { n: "a stylesheet", rel: "app/globals.css", ok: false },
    { n: "a JSON fixture", rel: "fixtures/x.json", ok: false },
  ])("AC18-05 — the graph's source predicate: $n", ({ rel, ok }) => {
    expect(isGraphSourceFile(rel)).toBe(ok);
  });

  it("AC18-05a — the walk's extension list and the graph's are ONE list", () => {
    // Two lists drift; this slice adds `.jsx`, and a `.jsx` component that the WALK never yields is
    // invisible no matter how good the graph is. Single owner, asserted.
    expect([...SOURCE_EXT].sort()).toEqual([...GRAPH_SOURCE_EXT].sort());
    expect(GRAPH_SOURCE_EXT).toContain(".jsx");
    expect(CANONICAL_WRITER_MODULE, "the graph's seed IS this file's canonical writer").toBe(CANONICAL);
  });

  it("AC18-05b — fixtures resolve against the SUPPLIED files only, never against the real disk", () => {
    // `lib/query/retrieve.ts` genuinely exists in this repository. If the analysis falls back to the
    // filesystem, every fixture silently acquires the real tree as a resolution host and the
    // synthetic controls stop meaning what they say.
    const rel = ROUTE;
    const r = analyseEntrySurfaces(
      [SEED, WRAP(), { rel, code: `import { w } from "@/lib/wrap";\nimport { retrieve } from "@/lib/query/retrieve";\nexport async function POST(){ await w({}); return retrieve; }` }],
      entryInv(rel)
    );
    const missing = ofKind(r, "unresolved");
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain(rel);
    expect(missing[0].message).toContain("@/lib/query/retrieve");
    expect(missing[0].message, "the location, so the reader can go straight to the line").toContain(":2");
    expect(r.closure).not.toContain("lib/query/retrieve.ts");
  });

  it("AC18-05c — a local reference resolving OUTSIDE the repository root fails", () => {
    const rel = "scripts/tool.ts";
    const r = analyseEntrySurfaces(
      [SEED, WRAP(), { rel, code: `import { w } from "../lib/wrap";\nimport { x } from "../../outside/thing";\nawait w(x);` }],
      entryInv(rel)
    );
    expect(ofKind(r, "unresolved")).toHaveLength(1);
    expect(ofKind(r, "unresolved")[0].message).toContain("../../outside/thing");
    expect(ofKind(r, "unresolved")[0].message).toContain(rel);
  });

  it("AC18-05d — a parse failure is reported, not swallowed", () => {
    const rel = "lib/broken.ts";
    const r = analyseEntrySurfaces([SEED, WRAP(), { rel, code: `import { w } from "@/lib/wrap";\nexport const = ;` }], NO_ENTRIES);
    expect(ofKind(r, "parse")).not.toHaveLength(0);
    expect(ofKind(r, "parse")[0].message).toContain(rel);
  });

  it.each([
    { n: "with no local file of that name", extra: [] as { rel: string; code: string }[] },
    // The dangerous half: a package.json `imports` map could point `#scan` AT A CLASSIFIED WRAPPER.
    // Treating `#` as "external, therefore terminal" would make that edge — and every surface behind
    // it — vanish. This slice does not resolve package.json imports, so it must REFUSE, loudly.
    { n: "when it would map to a local wrapper", extra: [{ rel: "lib/scan.ts", code: `import { w } from "@/lib/wrap";\nexport const scan = w;` }] },
  ])("AC18-05e — a `#…` specifier is refused as an unsupported package alias: $n", ({ extra }) => {
    const rel = ROUTE;
    const r = analyseEntrySurfaces(
      [SEED, WRAP(), ...extra, { rel, code: `import { scan } from "#scan";\nexport async function POST(){ await scan({}); }` }],
      NO_ENTRIES
    );
    expect(ofKind(r, "unsupported-alias")).toHaveLength(1);
    const m = ofKind(r, "unsupported-alias")[0].message;
    expect(m).toContain(rel);
    expect(m).toContain("#scan");
    expect(m).toContain(":1");
  });

  it.each([
    { n: "a bare external package", spec: `import { z } from "zod";` },
    { n: "a scoped external package", spec: `import * as Sentry from "@sentry/nextjs";` },
    { n: "a node builtin, prefixed", spec: `import { join } from "node:path";` },
    { n: "a node builtin, bare", spec: `import { join } from "path";` },
    { n: "a stylesheet", spec: `import "./route.css";` },
    { n: "a JSON asset", spec: `import data from "./data.json";` },
  ])("AC18-05f — a terminal, non-repo dependency passes untouched: $n", ({ spec }) => {
    const rel = ROUTE;
    const r = analyseEntrySurfaces([SEED, WRAP(), { rel, code: `${spec}\nimport { w } from "@/lib/wrap";\nexport async function POST(){ await w({}); }` }], entryInv(rel));
    expect(r.violations.map((v) => v.message)).toEqual([]);
    expect(r.surfaces).toEqual([rel]);
  });

  it("AC18-05g — the alias configuration the graph resolves against is PINNED", () => {
    // A new repo alias would otherwise look like a bare package specifier — terminal, no edge, no
    // failure. Pinning the setting means adding one fails HERE rather than deleting edges in silence.
    const tsconfig = JSON.parse(read("tsconfig.json")) as { compilerOptions: { paths: Record<string, string[]>; moduleResolution: string } };
    expect(tsconfig.compilerOptions.paths).toEqual(PINNED_TS_PATHS);
    expect(tsconfig.compilerOptions.moduleResolution, "the graph is specified against bundler resolution").toBe("bundler");
  });

  it("AC18-05h — an ASSET-LOOKING specifier that resolves to a SOURCE keeps its code edge", () => {
    // Astra adjudication 2. `./x.css` is a perfectly good module name for `./x.css.ts`, so
    // recognising an asset BY EXTENSION before trying local source resolution would delete that
    // edge — and every surface behind it — while reporting nothing at all. Source first, then
    // terminal assets.
    const files = [
      SEED,
      { rel: "lib/theme.css.ts", code: `${IMPORT_CANON}\nexport const theme = async (a) => ${WRITER}(a);` },
      { rel: ROUTE, code: `import { theme } from "@/lib/theme.css";\nexport async function POST(){ await theme({}); }` },
    ];
    const r = analyseEntrySurfaces(files, NO_ENTRIES);
    expect(r.closure, "the .css-spelled specifier must resolve to the .css.ts SOURCE").toContain("lib/theme.css.ts");
    expect(r.surfaces, "and the route behind it is a surface needing a record").toEqual([ROUTE]);
    expect(ofKind(r, "unclassified-entry")).toHaveLength(1);
    expect(diagnostics(r), "a resolvable source is not an unresolved reference").toEqual([]);

    // The twin, in the same criterion: with NO source of that name, the identical spelling is a
    // terminal non-code dependency and must pass clean. Without this half, an analysis that treated
    // every asset as an error would satisfy the assertion above.
    const twin = analyseEntrySurfaces(
      [SEED, WRAP(), { rel: ROUTE, code: `import "@/lib/theme.css";\nimport { w } from "@/lib/wrap";\nexport async function POST(){ await w({}); }` }],
      entryInv(ROUTE)
    );
    expect(twin.violations.map((v) => v.message)).toEqual([]);
    expect(twin.surfaces).toEqual([ROUTE]);
  });

  it("AC18-05i — the `#…` refusal comes FIRST, even when the specifier is spelled as a stylesheet", () => {
    // Order matters and is asserted: `#theme.css` must be refused as an unsupported package alias,
    // not absorbed by asset handling on the strength of its suffix.
    const r = analyseEntrySurfaces(
      [SEED, WRAP(), { rel: ROUTE, code: `import "#theme.css";\nimport { w } from "@/lib/wrap";\nexport async function POST(){ await w({}); }` }],
      entryInv(ROUTE)
    );
    expect(ofKind(r, "unsupported-alias")).toHaveLength(1);
    expect(ofKind(r, "unsupported-alias")[0].message).toContain("#theme.css");
    expect(r.violations.map((v) => v.kind), "the alias must not be swallowed as an asset").toEqual(["unsupported-alias"]);
  });

  // ── AC18-05j: the boundary of the walk is a place edges can vanish, so it FAILS rather than
  // reporting. Astra adjudication 4: a list nobody asserts is exactly a silent graph hole.
  const EXCLUDED_SOURCES = [
    { n: "a type declaration", rel: "lib/kinds.d.ts", spec: "@/lib/kinds", code: `export type Team = { id: string };`, symbol: "Team" },
    { n: "a test source", rel: "lib/helpers.test.ts", spec: "@/lib/helpers.test", code: `export const seed = 1;`, symbol: "seed" },
    { n: "the in-memory PostgREST double", rel: "lib/ingest/fake-supabase.ts", spec: "@/lib/ingest/fake-supabase", code: `export class FakeSupabase {}`, symbol: "FakeSupabase" },
  ];

  it.each(EXCLUDED_SOURCES)("AC18-05j — a RUNTIME reference into an EXCLUDED source fails the guard: $n", ({ rel, spec, code, symbol }) => {
    const route = {
      rel: ROUTE,
      code: `import { w } from "@/lib/wrap";\nimport { ${symbol} } from "${spec}";\nexport async function POST(){ await w({ ${symbol} }); }`,
    };
    const r = analyseEntrySurfaces([SEED, WRAP(), { rel, code }, route], entryInv(ROUTE));
    const refs = ofKind(r, "excluded-ref");
    expect(refs, "the reference must FAIL, not merely be listed").toHaveLength(1);
    expect(refs[0].message).toContain(ROUTE);
    expect(refs[0].message, "the failure must name what it resolved to").toContain(rel);
    expect(refs[0].message).toContain(":2");
    expect(r.excludedRefs.map((e) => e.target)).toEqual([rel]);
    expect(r.closure, "an excluded file never becomes a graph node").not.toContain(rel);

    // The twin: the SAME file referenced TYPE-ONLY carries no runtime edge and must pass clean —
    // otherwise this control is just "any mention of an excluded path fails", which would make
    // ordinary type imports unwritable.
    const twin = analyseEntrySurfaces(
      [
        SEED,
        WRAP(),
        { rel, code },
        { rel: ROUTE, code: `import { w } from "@/lib/wrap";\nimport type { ${symbol} } from "${spec}";\nexport async function POST(){ await w({}); }` },
      ],
      entryInv(ROUTE)
    );
    expect(twin.violations.map((v) => v.message)).toEqual([]);
  });

  // ── AC18-05k/l: the same boundary, reached through the REAL WALK ──────────────────────────────
  //
  // Astra medium 1. AC18-05j hands the excluded file to the analyser directly, which is an input the
  // production path never produces: the walk DROPS excluded roots and excluded files, so by the time
  // the analyser runs, `docs/bridge.css.ts` is not merely excluded — it is invisible. An
  // asset-looking specifier that names it then falls through to the terminal-asset branch and the
  // reference disappears in silence, taking every surface behind it. These two criteria run the
  // whole seam (`analyseTreeAt`) against a throwaway root, which is the only place that gap exists.
  it("AC18-05k — a runtime reference into an EXCLUDED ROOT fails through the REAL discovery seam", () => {
    const bridgeRoute = "app/api/bridge/route.ts";
    // The route is IDENTICAL in both halves below. Only the file behind `@/docs/bridge.css` changes,
    // so the criterion turns on "is there a source there?" and on nothing else about the fixture.
    const route = `import { w } from "@/lib/wrap";\nimport { bridge } from "@/docs/bridge.css";\nexport async function POST(){ await w({ bridge }); }`;
    const inv = entryInv(ANCHOR, bridgeRoute);

    const r = analyseTreeAt(
      fixtureRoot({
        ...MINI_REPO,
        [bridgeRoute]: route,
        // `docs/` is a NOT_WALKED root, so this file never reaches the analyser as a supplied source
        // — and it is a genuine SOURCE that imports the wrapper, not a stylesheet.
        "docs/bridge.css.ts": `import { w } from "@/lib/wrap";\nexport const bridge = w;`,
      }),
      inv
    );

    const refs = ofKind(r, "excluded-ref");
    expect(refs, "an asset-looking specifier naming an excluded SOURCE must FAIL, not terminate as an asset").toHaveLength(1);
    expect(refs[0].message).toContain(bridgeRoute);
    expect(refs[0].message, "the failure must name what it resolved to").toContain("docs/bridge.css.ts");
    expect(refs[0].message).toContain(":2");
    expect(r.excludedRefs.map((e) => `${e.from} -> ${e.target}`)).toEqual([`${bridgeRoute} -> docs/bridge.css.ts`]);
    expect(r.violations.map((v) => v.kind), "exactly this rule fires, and nothing is silently accepted").toEqual(["excluded-ref"]);

    // Resolution EVIDENCE is not ADMISSION. Simply walking `docs/` would satisfy the assertions
    // above and then admit an excluded file as a graph node, a surface and a route into the closure
    // — the wrong fix, pinned here so it cannot pass as the right one.
    expect(r.closure, "an excluded source never becomes a graph node").not.toContain("docs/bridge.css.ts");
    expect(r.surfaces, "and never an entry surface").toEqual([ANCHOR, bridgeRoute].sort());
    expect(r.closure, "the positive wrapper anchor is still discovered").toContain("lib/wrap.ts");

    // The twin: same root shape, same route, same inventory — the target is an ACTUAL stylesheet.
    // Without it, "any reference into a non-walked root fails" would satisfy the half above while
    // making an ordinary CSS import unwritable.
    const twin = analyseTreeAt(
      fixtureRoot({ ...MINI_REPO, [bridgeRoute]: route, "docs/bridge.css": `:root { --brand: #101010; }` }),
      inv
    );
    expect(twin.violations.map((v) => v.message), "a recognised non-code asset is terminal, not a hole").toEqual([]);
    expect(twin.surfaces).toEqual([ANCHOR, bridgeRoute].sort());
  });

  // Not a `docs/` special case: the SAME evidence is owed for every exclusion the walk applies —
  // declarations and test sources under a WALKED root, the PostgREST double, hidden/generated
  // directories, and the named non-walked roots.
  const EXCLUDED_ON_DISK = [
    { n: "a type declaration under a walked root", rel: "lib/kinds.d.ts", spec: "@/lib/kinds", code: `export type Team = { id: string };`, symbol: "Team" },
    { n: "a test source under a walked root", rel: "lib/helpers.test.ts", spec: "@/lib/helpers.test", code: `export const seed = 1;`, symbol: "seed" },
    { n: "the in-memory PostgREST double", rel: "lib/ingest/fake-supabase.ts", spec: "@/lib/ingest/fake-supabase", code: `export class FakeSupabase {}`, symbol: "FakeSupabase" },
    { n: "a HIDDEN generated directory", rel: "lib/.generated/client.ts", spec: "@/lib/.generated/client", code: `export const client = 1;`, symbol: "client" },
    { n: "a NAMED non-walked root", rel: "test/support/seed.ts", spec: "@/test/support/seed", code: `export const support = 1;`, symbol: "support" },
  ];

  it.each(EXCLUDED_ON_DISK)("AC18-05l — an excluded source ON DISK is resolution evidence, and the reference fails: $n", ({ rel, spec, code, symbol }) => {
    const target = ROUTE;
    const inv = entryInv(ANCHOR, target);
    const rootWith = (importLine: string) =>
      fixtureRoot({
        ...MINI_REPO,
        [rel]: code,
        [target]: `import { w } from "@/lib/wrap";\n${importLine}\nexport async function POST(){ await w({}); }`,
      });

    const r = analyseTreeAt(rootWith(`import { ${symbol} } from "${spec}";`), inv);
    const refs = ofKind(r, "excluded-ref");
    expect(refs, "the walk dropping a file must not downgrade the reference to 'unresolved' or to nothing").toHaveLength(1);
    expect(refs[0].message).toContain(target);
    expect(refs[0].message, "the failure must name what it resolved to").toContain(rel);
    expect(refs[0].message).toContain(":2");
    expect(r.violations.map((v) => v.kind)).toEqual(["excluded-ref"]);
    expect(r.closure, "an excluded source never becomes a graph node").not.toContain(rel);
    expect(r.surfaces).toEqual([ANCHOR, target].sort());

    // The twin: the SAME file referenced TYPE-ONLY carries no runtime edge and must pass clean, or
    // this control is just "any mention of an excluded path fails" and ordinary type imports break.
    const twin = analyseTreeAt(rootWith(`import type { ${symbol} } from "${spec}";`), inv);
    expect(twin.violations.map((v) => v.message)).toEqual([]);
  });

  it("AC18-05o — the resolution host is NARROWLY SCOPED: a dependency is never resolution evidence", () => {
    // The bound on the fix, in the same seam that needs it. Resolution evidence exists to explain
    // why a REPOSITORY source could not be followed; answering for `node_modules` would turn "we do
    // not crawl dependencies" into "we do, one candidate at a time", and would report a package file
    // as a source somebody deliberately excluded. It must stay UNRESOLVED — refused, but for the
    // honest reason.
    const dep = "lib/node_modules/dep/index.ts";
    const rel = ROUTE;
    const r = analyseTreeAt(
      fixtureRoot({
        ...MINI_REPO,
        [dep]: `export const dep = 1;`,
        [rel]: `import { w } from "@/lib/wrap";\nimport { dep } from "@/lib/node_modules/dep";\nexport async function POST(){ await w({ dep }); }`,
      }),
      entryInv(ANCHOR, rel)
    );
    expect(r.violations.map((v) => v.kind), "a dependency file is not an excluded repository source").toEqual(["unresolved"]);
    expect(ofKind(r, "unresolved")[0].message).toContain(rel);
    expect(ofKind(r, "unresolved")[0].message).toContain("@/lib/node_modules/dep");
    expect(r.closure).not.toContain(dep);
  });

  it("AC18-05p — the evidence host is OPT-IN: a virtual fixture still never reaches this disk", () => {
    // AC18-05b pins that a virtual fixture cannot resolve a real WALKED source. This is the other
    // half, and it is the one the evidence host could quietly break: `lib/ingest/fake-supabase.ts`
    // genuinely exists here and is genuinely excluded, so a host wired in by DEFAULT would turn every
    // synthetic control's resolution boundary into this repository's tree. Supplying no host means
    // touching no filesystem, and the outcome must therefore be "no analysed source resolves it".
    const rel = ROUTE;
    const r = analyseEntrySurfaces(
      [
        SEED,
        WRAP(),
        {
          rel,
          code: `import { w } from "@/lib/wrap";\nimport { FakeSupabase } from "@/lib/ingest/fake-supabase";\nexport async function POST(){ await w({ FakeSupabase }); }`,
        },
      ],
      entryInv(rel)
    );
    expect(r.violations.map((v) => v.kind), "with no host supplied there is no evidence to have").toEqual(["unresolved"]);
    expect(ofKind(r, "unresolved")[0].message).toContain("@/lib/ingest/fake-supabase");
    expect(r.excludedRefs, "and nothing was read off disk to call excluded").toEqual([]);
  });

  /* ── AC18-05q/r/s: RESOLUTION PRECEDENCE — which candidate wins, decided before admission ───────
   *
   * Astra code round 2. `AC18-05k/l` prove an excluded source is FOUND when nothing else answers the
   * specifier. They cannot see the case where something else does: a resolver that searched the
   * supplied files first, and only asked for evidence when that search came back empty, answered a
   * different question — "which of the files I kept could this name?" — and a LOWER-priority file
   * that happened to survive the walk masked the higher-priority excluded one that actually wins.
   * The reference then read as an ordinary edge into an unrelated module: no diagnostic, and the hole
   * hidden by the very file that should have made it obvious.
   *
   * The three rows below are the whole rule, not just its failing half. Precedence is TypeScript's,
   * applied to the whole repository; the guard's own exclusion policy is applied AFTERWARDS, to
   * whatever won. So an exclusion never wins for BEING an exclusion (05s), and never loses for being
   * one either (05q).
   */

  /**
   * Installed TypeScript's own answer, over a host listing exactly `files` — INDEPENDENT evidence for
   * "which candidate wins", so these criteria assert the compiler's precedence rather than the
   * author's belief about it. Deliberately not the analyser: running that twice would only establish
   * that it agrees with itself, which is the thing in question.
   */
  const PRECEDENCE_VROOT = "/auditfix18-precedence";
  const normAbs = (p: string): string => {
    const out: string[] = [];
    for (const seg of p.split(/[\\/]/)) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return `/${out.join("/")}`;
  };
  const tsResolvesTo = (spec: string, from: string, files: readonly string[]): string | null => {
    const present = new Set(files.map((f) => normAbs(`${PRECEDENCE_VROOT}/${f}`)));
    const host: ts.ModuleResolutionHost = {
      fileExists: (f) => present.has(normAbs(f)),
      readFile: () => undefined,
      directoryExists: () => true,
      getDirectories: () => [],
      getCurrentDirectory: () => PRECEDENCE_VROOT,
      realpath: (p) => p,
      useCaseSensitiveFileNames: true,
    };
    const resolved = ts.resolveModuleName(
      spec,
      `${PRECEDENCE_VROOT}/${from}`,
      {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        allowJs: true,
        allowImportingTsExtensions: true,
        baseUrl: PRECEDENCE_VROOT,
        paths: Object.fromEntries(Object.entries(PINNED_TS_PATHS).map(([k, v]) => [k, [...v]])),
      },
      host
    ).resolvedModule?.resolvedFileName;
    const abs = resolved === undefined ? null : normAbs(resolved);
    return abs !== null && abs.startsWith(`${PRECEDENCE_VROOT}/`) ? abs.slice(PRECEDENCE_VROOT.length + 1) : null;
  };

  const BRIDGE_ROUTE = "app/api/bridge/route.ts";
  const BRIDGE_SPEC = "@/lib/bridge.test";
  /** Higher priority, and the WALK DROPS IT: a `.test.ts` source. */
  const BRIDGE_EXCLUDED = "lib/bridge.test.ts";
  /** Lower priority, and the walk KEEPS it — an unrelated module that merely shares the base name. */
  const BRIDGE_DECOY = "lib/bridge.test/index.ts";
  /**
   * IDENTICAL across both halves below, as in `AC18-05k`: the route keeps its own honest path to the
   * writer through the wrapper, so it is a surface either way and the pair turns on ONE fact — does
   * `lib/bridge.test.ts` exist beside the directory index?
   */
  const BRIDGE_ROUTE_CODE =
    `import { w } from "@/lib/wrap";\nimport { bridge } from "${BRIDGE_SPEC}";\n` +
    `export async function POST(){ await w({ bridge }); }`;

  it("AC18-05q — the WINNING candidate is resolved first, so a surviving lower-priority file cannot mask an excluded one", () => {
    expect(
      tsResolvesTo(BRIDGE_SPEC, BRIDGE_ROUTE, [BRIDGE_EXCLUDED, BRIDGE_DECOY]),
      "the premise: with BOTH on disk, TypeScript names the FILE, not the directory index"
    ).toBe(BRIDGE_EXCLUDED);

    const r = analyseTreeAt(
      fixtureRoot({
        ...MINI_REPO,
        // A genuine route into the writer, behind the exclusion boundary — this is what goes missing.
        [BRIDGE_EXCLUDED]: `export { w as bridge } from "@/lib/wrap";`,
        // Inert ON PURPOSE: it reaches nothing, so a resolver that picked it would report NOTHING AT
        // ALL — the silence the coordinator reproduced, rather than some other violation standing in.
        [BRIDGE_DECOY]: `export const bridge = () => null;`,
        [BRIDGE_ROUTE]: BRIDGE_ROUTE_CODE,
      }),
      entryInv(ANCHOR, BRIDGE_ROUTE)
    );

    const refs = ofKind(r, "excluded-ref");
    expect(refs, "the excluded file WINS resolution, so the reference must FAIL").toHaveLength(1);
    expect(refs[0].message).toContain(BRIDGE_ROUTE);
    expect(refs[0].message, "and the failure must name the file that actually won").toContain(BRIDGE_EXCLUDED);
    expect(
      refs[0].message,
      "not the lower-priority directory index that merely survived the walk"
    ).not.toContain(BRIDGE_DECOY);
    expect(refs[0].message).toContain(":2");
    expect(r.excludedRefs.map((e) => `${e.from} -> ${e.target}`)).toEqual([`${BRIDGE_ROUTE} -> ${BRIDGE_EXCLUDED}`]);
    expect(r.violations.map((v) => v.kind), "exactly this rule fires, and nothing is silently accepted").toEqual([
      "excluded-ref",
    ]);

    // Resolving the excluded target is not ADMITTING it — the AC18-05k distinction, restated for the
    // path where a supplied file was available to take instead.
    expect(r.closure, "the excluded winner never becomes a graph node").not.toContain(BRIDGE_EXCLUDED);
    expect(r.surfaces, "the route keeps its own path to the writer, and the anchor stands").toEqual(
      [ANCHOR, BRIDGE_ROUTE].sort()
    );
    expect(r.closure, "and the wrapper anchor is still discovered").toContain("lib/wrap.ts");
  });

  it("AC18-05r — REMOVING the excluded file lets the unrelated index resolve, with no false excluded-ref", () => {
    // The removal twin, same route and same inventory. Without it, "anything spelled like a test
    // source fails" would satisfy 05q while making the ordinary directory import unwritable.
    expect(tsResolvesTo(BRIDGE_SPEC, BRIDGE_ROUTE, [BRIDGE_DECOY])).toBe(BRIDGE_DECOY);

    const r = analyseTreeAt(
      fixtureRoot({
        ...MINI_REPO,
        [BRIDGE_DECOY]: `export const bridge = () => null;`,
        [BRIDGE_ROUTE]: BRIDGE_ROUTE_CODE,
      }),
      entryInv(ANCHOR, BRIDGE_ROUTE)
    );
    expect(r.violations.map((v) => v.message), "with nothing excluded there, nothing may be refused").toEqual([]);
    expect(
      ofKind(r, "unresolved"),
      "and the supplied index RESOLVES — it is not downgraded to a missing edge either"
    ).toHaveLength(0);
    expect(r.excludedRefs, "no evidence was invented to refuse it with").toEqual([]);
    expect(r.surfaces, "the positive anchor and the route are both discovered").toEqual([ANCHOR, BRIDGE_ROUTE].sort());
  });

  it("AC18-05s — an INCLUDED higher-priority file beats an EXCLUDED index: the fix is not 'exclusions first'", () => {
    // The inverse twin, and the bound on the whole change. Reversing the old ordering into an
    // unconditional excluded-first policy would satisfy 05q and then refuse an ORDINARY included
    // file because some lower-priority excluded name exists beside it. `fixtures/` is a NOT_WALKED
    // root, so `fixtures/index.ts` is evidence-only; the root-level `fixtures.ts` is walked, kept,
    // and outranks it.
    const included = "fixtures.ts";
    const excludedIndex = "fixtures/index.ts";
    const route = "app/api/fixtures/route.ts";
    expect(
      tsResolvesTo("@/fixtures", route, [included, excludedIndex]),
      "the premise: the FILE outranks the directory index here too"
    ).toBe(included);

    const r = analyseTreeAt(
      fixtureRoot({
        ...MINI_REPO,
        [included]: `export { w as gate } from "@/lib/wrap";`,
        [excludedIndex]: `export const gate = () => null;`,
        [route]: `import { gate } from "@/fixtures";\nexport async function POST(){ await gate({}); }`,
      }),
      entryInv(ANCHOR, included, route)
    );
    expect(r.violations.map((v) => v.message), "an included file that WINS must resolve, not be refused").toEqual([]);
    expect(r.excludedRefs).toEqual([]);
    expect(r.closure, "the included winner is a node, and carries the route into the closure").toContain(included);
    expect(r.closure, "the excluded index is never admitted").not.toContain(excludedIndex);
    expect(r.surfaces).toEqual([ANCHOR, included, route].sort());
  });

  // ── AC18-05m/n: an ABSOLUTE path is a local spelling, not a package name (Astra medium 2) ──────
  //
  // The external-terminal branch fires on "not `.` and not `@/`", so `/tmp/bridge.mjs` — a local
  // absolute spelling that no package registry could ever supply — is terminated as an external
  // package: no edge, no diagnostic, and every surface behind it gone. The spec already says an
  // unresolved or outside-root LOCAL code reference fails; these rows are that rule, applied to the
  // spelling the classifier currently does not recognise as local.
  const ABSOLUTE_REFUSED = [
    { n: "a static import", code: `import { bridge } from "/tmp/bridge.mjs";`, spec: "/tmp/bridge.mjs" },
    { n: "a literal dynamic import", code: `export const pending = import("/tmp/bridge.mjs");`, spec: "/tmp/bridge.mjs" },
    { n: "a literal require", code: `export const bridge = require("/tmp/bridge.mjs");`, spec: "/tmp/bridge.mjs" },
    { n: "an export-from declaration", code: `export { bridge } from "/tmp/bridge.mjs";`, spec: "/tmp/bridge.mjs" },
    // Refusing is the contract; RESOLVING absolute paths is not. An absolute spelling of a file that
    // IS in the analysed set must still be refused, or the fix has quietly added a second resolver.
    { n: "an absolute spelling of a file INSIDE the analysed set", code: `import { w as w2 } from "/lib/wrap";`, spec: "/lib/wrap" },
    // The OTHER supported platform's spellings, asserted on THIS one. `path.isAbsolute` answers for
    // the host it runs on, so a POSIX runner calls `C:\tmp\x.mjs` relative and waves it through as a
    // package name — the guard would then lose edges depending on where CI happens to run, which is
    // exactly the silent, environment-dependent hole this criterion exists to close.
    { n: "a Windows drive path, forward slashes", code: `import { bridge } from "C:/tmp/bridge.mjs";`, spec: "C:/tmp/bridge.mjs" },
    { n: "a Windows drive path, backslashes", code: `import { bridge } from "C:\\\\tmp\\\\bridge.mjs";`, spec: "C:\\tmp\\bridge.mjs" },
    { n: "a Windows root-relative path", code: `import { bridge } from "\\\\tmp\\\\bridge.mjs";`, spec: "\\tmp\\bridge.mjs" },
  ];

  it.each(ABSOLUTE_REFUSED)("AC18-05m — an ABSOLUTE specifier is refused, never terminated as a package: $n", ({ code, spec }) => {
    const rel = ROUTE;
    const r = analyseEntrySurfaces(
      [SEED, WRAP(), { rel, code: `import { w } from "@/lib/wrap";\n${code}\nexport async function POST(){ await w({}); }` }],
      entryInv(rel)
    );
    const refused = ofKind(r, "unresolved");
    expect(refused, "an absolute path is a LOCAL reference; treating it as a package erases the edge in silence").toHaveLength(1);
    expect(refused[0].message).toContain(rel);
    expect(refused[0].message).toContain(spec);
    expect(refused[0].message, "the location, so the reader can go straight to the line").toContain(":2");
    expect(r.violations.map((v) => v.kind), "one rule, once — the refusal is not a cascade").toEqual(["unresolved"]);
  });

  it.each([
    { n: "a bare external package", code: `import { z } from "zod";` },
    { n: "a node builtin, prefixed", code: `import { join } from "node:path";` },
    { n: "a node builtin, bare", code: `import { join } from "path";` },
    // The rows that discriminate an over-broad fix: a package SUBPATH contains slashes and looks
    // path-shaped, but it is still a package specifier and must stay terminal.
    { n: "a deep path inside an external package", code: `import { helper } from "zod/lib/helpers.js";` },
    { n: "a deep path inside a SCOPED package", code: `import { init } from "@sentry/nextjs/esm/client.js";` },
    { n: "a literal dynamic import of a package subpath", code: `export const pending = import("@e2b/code-interpreter/dist/index.js");` },
  ])("AC18-05n — a non-local specifier stays terminal: $n", ({ code }) => {
    const rel = ROUTE;
    const r = analyseEntrySurfaces(
      [SEED, WRAP(), { rel, code: `import { w } from "@/lib/wrap";\n${code}\nexport async function POST(){ await w({}); }` }],
      entryInv(rel)
    );
    expect(r.violations.map((v) => v.message), "a package subpath has slashes but is not a path").toEqual([]);
    expect(r.surfaces).toEqual([rel]);
  });

  // ── AC18-06: computed loads, the ONE exception, and staleness ─────────────────────────────────
  const E2B_REL = "lib/actions/sandbox/e2b.ts";
  const e2bFile = (body: string) => ({ rel: E2B_REL, code: body });
  const E2B_OK = `const E2B_MODULE: string = "@e2b/code-interpreter";\nasync function defaultLoader() {\n  return (await import(E2B_MODULE));\n}\nexport const load = defaultLoader;`;

  it.each([
    { n: "a computed import in a file OUTSIDE the closure", files: [{ rel: "app/api/y/route.ts", code: `export async function POST(name){ return import(name); }` }] },
    { n: "a computed require in a file outside the closure", files: [{ rel: "scripts/loader.ts", code: `const p = process.argv[2];\nrequire(p);` }] },
    { n: "a computed import INSIDE the closure", files: [{ rel: ROUTE, code: `import { w } from "@/lib/wrap";\nexport async function POST(name){ await w({}); return import(name); }` }] },
    { n: "a concatenated specifier", files: [{ rel: ROUTE, code: `const BASE = "@/lib/";\nexport async function POST(n){ return import(BASE + n); }` }] },
    { n: "a template specifier with a substitution", files: [{ rel: ROUTE, code: "export async function POST(n){ return import(`@/lib/${n}`); }" }] },
  ])("AC18-06 — a non-literal load is REFUSED: $n", ({ files }) => {
    // Fail-closed EVEN OUTSIDE the closure: a hidden edge that nobody follows is exactly the thing
    // that would prevent its own discovery, so "not currently reachable" cannot be the excuse.
    const r = analyseEntrySurfaces([SEED, WRAP(), ...files], NO_ENTRIES);
    expect(ofKind(r, "refused-load")).toHaveLength(1);
    expect(ofKind(r, "refused-load")[0].message).toContain(files[0].rel);
  });

  it("AC18-06b — the narrowly matched E2B exception passes", () => {
    const r = analyseEntrySurfaces([SEED, WRAP(), e2bFile(E2B_OK)], NO_ENTRIES, { exceptions: COMPUTED_LOAD_EXCEPTIONS });
    expect(r.violations.map((v) => v.message)).toEqual([]);
  });

  it.each([
    { n: "the const now points at a LOCAL wrapper", code: `const E2B_MODULE: string = "@/lib/wrap";\nasync function defaultLoader() {\n  return (await import(E2B_MODULE));\n}` },
    { n: "a SECOND load of the same binding appears", code: `${E2B_OK}\nexport async function again(){ return import(E2B_MODULE); }` },
    { n: "the expression is broadened", code: `const E2B_MODULE: string = "@e2b/code-interpreter";\nasync function defaultLoader(suffix) {\n  return (await import(E2B_MODULE + suffix));\n}` },
    { n: "the load moved to a different function", code: `const E2B_MODULE: string = "@e2b/code-interpreter";\nasync function otherLoader() {\n  return (await import(E2B_MODULE));\n}` },
    { n: "a NEW computed loader tries to borrow the exception", code: `${E2B_OK}\nexport async function local(name){ return import(name); }` },
  ])("AC18-06c — the exception is EXACT, not a file-wide pass: $n", ({ code }) => {
    const r = analyseEntrySurfaces([SEED, WRAP(), e2bFile(code)], NO_ENTRIES, { exceptions: COMPUTED_LOAD_EXCEPTIONS });
    expect(r.violations.map((v) => v.kind)).toContain("refused-load");
  });

  it("AC18-06d — an exception whose load is gone goes STALE (and is not inferred from an empty closure)", () => {
    const gone = analyseEntrySurfaces([SEED, WRAP(), e2bFile(`export const load = null;`)], NO_ENTRIES, { exceptions: COMPUTED_LOAD_EXCEPTIONS });
    expect(ofKind(gone, "stale-exception")).toHaveLength(1);
    expect(ofKind(gone, "stale-exception")[0].message).toContain(E2B_REL);
    // …and the same when the file itself is absent: no closure, no loads, therefore "nothing to
    // except" — an unused exception is a hole nobody is watching, not a clean bill of health.
    const absent = analyseEntrySurfaces([SEED], NO_ENTRIES, { exceptions: COMPUTED_LOAD_EXCEPTIONS });
    expect(ofKind(absent, "stale-exception")).toHaveLength(1);
    // The exception in force against the real tree is exactly the one this fixture models.
    const only: ComputedLoadException[] = [...COMPUTED_LOAD_EXCEPTIONS];
    expect(only).toHaveLength(1);
    expect(only[0].file).toBe(E2B_REL);
    expect(only[0].reason.trim().length, "an exception with no reason is a shrug").toBeGreaterThan(0);
  });

  it.each([
    {
      n: "the classified file is gone",
      files: [SEED, WRAP()],
      inv: entryInv("app/api/v9/removed/route.ts"),
    },
    {
      n: "the file is still here but no longer reaches the writer",
      files: [SEED, WRAP(), { rel: ROUTE, code: `export async function POST(){ return null; }` }],
      inv: entryInv(ROUTE),
    },
    {
      n: "the file is reached but no longer meets the surface predicate",
      files: [SEED, WRAP(), { rel: "lib/x/actions.ts", code: `import { w } from "@/lib/wrap";\nexport const run = w;` }],
      inv: entryInv("lib/x/actions.ts"),
    },
  ])("AC18-06e — a stale entry record fails: $n", ({ files, inv }) => {
    const r = analyseEntrySurfaces(files, inv);
    expect(r.violations.map((v) => v.kind)).toContain("stale-entry");
    expect(r.violations.map((v) => v.message).join("\n")).toContain(Object.keys(inv)[0]);
  });

  it("AC18-06f — removing ONE edge while another path survives is NOT staleness", () => {
    // The positive twin for the row above. A stale check keyed on the WITNESS rather than on
    // reachability would pass every AC18-06e row and then fire on an ordinary refactor that changed
    // nothing about the surface's obligation — a failure nobody can act on except by editing prose.
    const rel = ROUTE;
    const base = [
      SEED,
      WRAP(),
      { rel: "lib/path-a.ts", code: `import { w } from "@/lib/wrap";\nexport const alsoA = w;` },
      { rel: "lib/path-b.ts", code: `import { w } from "@/lib/wrap";\nexport const alsoB = w;` },
    ];
    const viaBoth = { rel, code: `import { alsoA } from "@/lib/path-a";\nimport { alsoB } from "@/lib/path-b";\nexport async function POST(){ await alsoA({}); await alsoB({}); }` };
    const viaOne = { rel, code: `import { alsoB } from "@/lib/path-b";\nexport async function POST(){ await alsoB({}); }` };
    for (const surface of [viaBoth, viaOne]) {
      const r = analyseEntrySurfaces([...base, surface], entryInv(rel));
      expect(r.violations.map((v) => v.message)).toEqual([]);
      expect(r.surfaces).toEqual([rel]);
    }
  });

  // ── AC18-06g/h: the excused load must be the APPROVED TOP-LEVEL CONST, not merely its spelling ─
  //
  // The exception's entire justification is "external package — it can never resolve to a repo
  // module". That claim is true of the top-level `const E2B_MODULE = "@e2b/code-interpreter"` and of
  // nothing else. The matcher compares the argument's SPELLING, the enclosing function's name, the
  // load count and the const's value — none of which establish that the argument identifier RESOLVES
  // to that const. So any binding of the same name that sits closer to the load supplies the real
  // specifier while the untouched top-level const goes on satisfying the allow rule, and a
  // caller-supplied REPO module loads under an exception written for a package. A concrete
  // `defaultLoader(E2B_MODULE: string)` was run through this analyser and produced ZERO violations.
  //
  // Every row below keeps the approved const VERBATIM — asserted, so a later edit cannot turn these
  // into value-mismatch refusals that pass for the wrong reason — and changes exactly one thing:
  // which binding the load's identifier actually refers to.
  const E2B_CONST = `const E2B_MODULE: string = "@e2b/code-interpreter";`;

  it.each([
    {
      n: "a PARAMETER of the excused function shadows the const",
      code: `${E2B_CONST}
async function defaultLoader(E2B_MODULE: string) {
  return (await import(E2B_MODULE));
}
export const load = defaultLoader;`,
    },
    {
      n: "a DESTRUCTURED parameter buries the spelling in a binding pattern",
      code: `${E2B_CONST}
async function defaultLoader({ E2B_MODULE }: { E2B_MODULE: string }) {
  return (await import(E2B_MODULE));
}
export const load = defaultLoader;`,
    },
    {
      n: "a RENAMED destructure binds the spelling to an arbitrary property",
      code: `${E2B_CONST}
async function defaultLoader(opts: { pkg: string }) {
  const { pkg: E2B_MODULE } = opts;
  return (await import(E2B_MODULE));
}
export const load = defaultLoader;`,
    },
    {
      n: "a function-local `const` before the load shadows it",
      code: `${E2B_CONST}
async function defaultLoader(name: string) {
  const E2B_MODULE = name;
  return (await import(E2B_MODULE));
}
export const load = defaultLoader;`,
    },
    {
      // A `let` declared BELOW the load still owns the whole function scope — the reference is a TDZ
      // error, not a read of the outer const. That is the point: textual position cannot decide
      // this, so "the top-level declaration comes first" is never an argument for excusing a load.
      n: "a function-local `let` declared AFTER the load shadows it anyway",
      code: `${E2B_CONST}
async function defaultLoader(name: string) {
  const mod = await import(E2B_MODULE);
  let E2B_MODULE = name;
  return mod;
}
export const load = defaultLoader;`,
    },
    {
      n: "a hoisted `var` declared AFTER the load shadows it anyway",
      code: `${E2B_CONST}
async function defaultLoader(name: string) {
  const mod = await import(E2B_MODULE);
  var E2B_MODULE = name;
  return mod;
}
export const load = defaultLoader;`,
    },
    {
      n: "the ENCLOSING BLOCK binds the name",
      code: `${E2B_CONST}
async function defaultLoader(name: string) {
  if (name) {
    const E2B_MODULE = name;
    return (await import(E2B_MODULE));
  }
  return null;
}
export const load = defaultLoader;`,
    },
    {
      n: "a CATCH parameter binds the name",
      code: `${E2B_CONST}
async function defaultLoader(name: string) {
  try {
    return JSON.parse(name);
  } catch (E2B_MODULE) {
    return (await import(E2B_MODULE));
  }
}
export const load = defaultLoader;`,
    },
    {
      // The function NAME is the only other thing the matcher checks, and it is a spelling too: an
      // inner arrow assigned to `defaultLoader` answers to that name while the load reads the
      // parameter of the function around it. A same-spelled function elsewhere must not stand in as
      // proof that the load sits in the intended binding context.
      n: "a nested arrow answers to `defaultLoader` while an outer parameter supplies the specifier",
      code: `${E2B_CONST}
export function outer(E2B_MODULE: string) {
  const defaultLoader = async () => (await import(E2B_MODULE));
  return defaultLoader;
}`,
    },
  ])("AC18-06g — a BINDING SHADOW of the excepted const is refused: $n", ({ code }) => {
    expect(
      code,
      "the fixture must keep the APPROVED const verbatim, or the refusal below only proves a value mismatch"
    ).toContain(E2B_CONST);

    const r = analyseEntrySurfaces([SEED, WRAP(), e2bFile(code)], NO_ENTRIES, { exceptions: COMPUTED_LOAD_EXCEPTIONS });

    // Pinned by KIND and COUNT, never by "violations is non-empty": the stale exception below fires
    // in the same run, so a criterion that only counted violations would report success while the
    // loader itself stayed excused.
    const refused = ofKind(r, "refused-load");
    expect(refused, "the shadowed load must be REFUSED — the approved const is not what it loads").toHaveLength(1);
    expect(refused[0].message).toContain(E2B_REL);

    // The documented companion under the exact-match contract: the approved exception now matches
    // nothing, so it goes STALE rather than being quietly consumed by a load nobody approved.
    expect(ofKind(r, "stale-exception"), "an exception that fits nothing is stale, not satisfied").toHaveLength(1);
  });

  it.each([
    { n: "the genuine, unshadowed loader", code: E2B_OK },
    {
      // A binding confined to a SIBLING block never reaches the load, so a checker that merely
      // scanned the function subtree for the spelling would refuse a load that is entirely correct.
      n: "a same-spelled binding confined to a disjoint block",
      code: `${E2B_CONST}
async function defaultLoader(flag: boolean) {
  if (flag) {
    const E2B_MODULE = "./sibling";
    void E2B_MODULE;
  }
  return (await import(E2B_MODULE));
}
export const load = defaultLoader;`,
    },
    {
      n: "a same-spelled binding confined to a nested function",
      code: `${E2B_CONST}
async function defaultLoader() {
  const describe = (E2B_MODULE: string) => E2B_MODULE.length;
  void describe;
  return (await import(E2B_MODULE));
}
export const load = defaultLoader;`,
    },
    {
      n: "a same-spelled binding in an unrelated function that holds no load",
      code: `${E2B_CONST}
async function defaultLoader() {
  return (await import(E2B_MODULE));
}
export function describeModule(E2B_MODULE: string) {
  return E2B_MODULE.length;
}
export const load = defaultLoader;`,
    },
    {
      n: "a nearby local whose name merely RESEMBLES the const",
      code: `${E2B_CONST}
async function defaultLoader() {
  const E2B_MODULE_PATH = "./not-a-shadow";
  void E2B_MODULE_PATH;
  return (await import(E2B_MODULE));
}
export const load = defaultLoader;`,
    },
  ])("AC18-06h — a same-spelled binding that never reaches the load keeps the exception: $n", ({ code }) => {
    // The positive twins. Without them, a refusal that fired on the SPELLING anywhere in the file
    // would satisfy every AC18-06g row while breaking the one load the exception exists for.
    const r = analyseEntrySurfaces([SEED, WRAP(), e2bFile(code)], NO_ENTRIES, { exceptions: COMPUTED_LOAD_EXCEPTIONS });
    expect(r.violations.map((v) => v.message)).toEqual([]);
  });

  // ── AC18-06i/j: the exception is for ONE LOADER, not for one identifier ────────────────────────
  //
  // Astra medium 3. Extraction keeps the argument identifier, the enclosing function and the source
  // text, but not WHICH LOADER ran — so `require(E2B_MODULE)` presents the matcher with the same
  // binding, the same function and the same count as the approved `import(E2B_MODULE)` and is
  // excused by an exception written for a dynamic import. The binding-identity work above cannot
  // reach this: the argument genuinely IS the approved const. It is the expression that differs,
  // and `require` is a synchronous CommonJS load with different semantics — not the thing anybody
  // reviewed when the exception was written.
  it("AC18-06i — a computed REQUIRE cannot borrow the import-only E2B exception", () => {
    const asRequire = `${E2B_CONST}
async function defaultLoader() {
  return require(E2B_MODULE);
}
export const load = defaultLoader;`;
    // The approved const is kept VERBATIM, so a refusal here cannot be a value mismatch in disguise.
    expect(asRequire).toContain(E2B_CONST);

    const r = analyseEntrySurfaces([SEED, WRAP(), e2bFile(asRequire)], NO_ENTRIES, { exceptions: COMPUTED_LOAD_EXCEPTIONS });
    const refused = ofKind(r, "refused-load");
    expect(refused, "a require of the approved binding is a DIFFERENT load, and no exception covers it").toHaveLength(1);
    expect(refused[0].message).toContain(E2B_REL);
    expect(refused[0].message, "the refusal must quote the REQUIRE, not some other load in the file").toContain("require(E2B_MODULE)");
    // The documented companion under the exact-match contract: the import the exception was written
    // for is gone, so the exception fits nothing and goes STALE rather than being consumed by a load
    // nobody approved. Pinned by kind AND count — "violations is non-empty" would pass either way.
    expect(ofKind(r, "stale-exception"), "an exception that fits nothing is stale, not satisfied").toHaveLength(1);

    // The twin, in the same criterion: same file, same binding, same function, same count — only the
    // loader kind differs, and the genuine dynamic import stays clean.
    const genuine = analyseEntrySurfaces([SEED, WRAP(), e2bFile(E2B_OK)], NO_ENTRIES, { exceptions: COMPUTED_LOAD_EXCEPTIONS });
    expect(genuine.violations.map((v) => v.message)).toEqual([]);
  });

  it("AC18-06j — a require ALONGSIDE the approved import is refused, and the import keeps its exception", () => {
    // The occurrence count is a property of the APPROVED LOADER, not of the identifier: an unrelated
    // require must not be able to invalidate the reviewed import by inflating its count either.
    const both = `${E2B_OK}\nexport function sync(){ return require(E2B_MODULE); }`;
    const r = analyseEntrySurfaces([SEED, WRAP(), e2bFile(both)], NO_ENTRIES, { exceptions: COMPUTED_LOAD_EXCEPTIONS });
    const refused = ofKind(r, "refused-load");
    expect(refused, "exactly the unapproved load — the reviewed import is not collateral").toHaveLength(1);
    expect(refused[0].message).toContain("require(E2B_MODULE)");
    expect(ofKind(r, "stale-exception"), "the approved dynamic import is still there, so nothing is stale").toHaveLength(0);
  });

  // ── AC18-07: the real tree ────────────────────────────────────────────────────────────────────
  let realEntryCache: EntrySurfaceAnalysis | null = null;
  // Exceptions are passed EXPLICITLY (the default is none): the real tree is the only caller that
  // has any, and naming them here keeps "which loads are excused" a decision at the call site.
  //
  // Through `analyseTreeAt`, i.e. the SAME discovery-to-analysis seam the on-disk fixtures use with
  // an injected root — the whole point of extracting it. A criterion that assembled the file list
  // itself would leave the walk's own behaviour (which files it drops, and what the analysis is
  // then able to say about them) reachable by nothing but this one call.
  const realEntrySurfaces = () =>
    (realEntryCache ??= analyseTreeAt(ROOT, ENTRY_INVENTORY, { exceptions: COMPUTED_LOAD_EXCEPTIONS }));

  it("AC18-07 — the real tree passes, and the discovered surfaces are EXACTLY the reviewed inventory", () => {
    const r = realEntrySurfaces();
    expect(r.violations.map((v) => v.message), "every entry surface must carry a reviewed record").toEqual([]);
    expect(r.surfaces).toEqual(Object.keys(ENTRY_INVENTORY).sort());
    expect(r.closure, "the seed is excluded from the WALK and added explicitly by the graph").toContain(CANONICAL);
  }, REAL_TREE_TIMEOUT_MS);

  it.each([
    { n: "the codebases scan route (the escape that motivated this slice)", rel: "app/api/v1/codebases/route.ts" },
    { n: "the actions route", rel: "app/api/v1/actions/route.ts" },
    { n: "the admin approvals actions", rel: "app/t/[team]/admin/approvals/actions.ts" },
    { n: "the dashboard manual-sync query route", rel: "app/api/dashboard/query/route.ts" },
    { n: "the admin integrations actions (the four 'Run now')", rel: "app/t/[team]/admin/integrations/actions.ts" },
    { n: "the meetings actions", rel: "app/t/[team]/meetings/actions.ts" },
    { n: "the boot instrumentation hook", rel: "instrumentation.ts" },
    { n: "the connectors CLI", rel: "scripts/connectors.ts" },
    { n: "the demo seeder", rel: "scripts/seed-demo.ts" },
  ])("AC18-07b — a KNOWN entry surface is in the DISCOVERED set: $n", ({ rel }) => {
    // Asserted against what the graph found, NOT against the inventory: an inventory that quietly
    // shrank would still satisfy the set-equality above, because equality holds against whatever
    // both sides say. These nine are named independently for exactly that reason.
    expect(realEntrySurfaces().surfaces).toContain(rel);
  }, REAL_TREE_TIMEOUT_MS);

  it("AC18-07c — every discovered surface carries a witness chain that ends at the writer", () => {
    const r = realEntrySurfaces();
    const closure = new Set(r.closure);
    expect(r.surfaces.length, "a loop over an empty set proves nothing").toBeGreaterThan(0);
    for (const surface of r.surfaces) {
      const chain = r.witness[surface];
      expect(chain, `${surface} must have a witness chain`).toBeDefined();
      expect(chain[0], `${surface}'s chain must start at the surface`).toBe(surface);
      expect(chain[chain.length - 1], `${surface}'s chain must end at the writer`).toBe(CANONICAL);
      expect(chain.length, `${surface}'s chain must have at least one edge`).toBeGreaterThan(1);
      expect(new Set(chain).size, `${surface}'s chain must not revisit a file`).toBe(chain.length);
      for (const hop of chain) expect(closure.has(hop), `${hop} must be in the closure`).toBe(true);
    }
  }, REAL_TREE_TIMEOUT_MS);

  it("AC18-07d — every reviewed record uses a declared class and a written reason", () => {
    const records = Object.entries(ENTRY_INVENTORY);
    expect(records.length, "an empty inventory would satisfy every loop below").toBeGreaterThan(0);
    for (const [rel, rec] of records) {
      expect(ENTRY_CLASSES, `${rel} has an undeclared class`).toContain(rec.class);
      expect(rec.reason.trim().length, `${rel}'s reason is too short to be a decision`).toBeGreaterThan(20);
    }
    // Reasons are written per surface, never generated and never directory-wide. Uniqueness is NOT
    // required — two admin actions can honestly share a chain — but one sentence pasted across the
    // whole inventory is the auto-generation tell, and it is the thing this rules out.
    const reasons = new Set(records.map(([, rec]) => rec.reason.trim()));
    if (records.length > 1) expect(reasons.size, "one reason reused for every surface is not a review").toBeGreaterThan(1);
  });
});
