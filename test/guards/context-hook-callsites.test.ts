import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, dirname, relative, resolve as resolvePath } from "node:path";
import ts from "typescript";

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
 * ## What it deliberately does NOT catch — stated, because the limit is the interesting part
 *
 * A NEW ENTRY SURFACE THAT CALLS AN EXISTING, ALREADY-CLASSIFIED WRAPPER. `POST /api/v1/codebases`
 * calls `ingestCodebaseScan`, not `ingestItem`; add a second route calling the same helper and no
 * new direct call site appears and this guard stays green. Closing that needs a whole-program call
 * graph from every route/action entry point — AUDITFIX-18. The entry surfaces known today are
 * listed in the spec's §3e.
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
      "measured 0.8-1.9 min when scheduled; next tick or later via manual sync and the four admin " +
      "'Run now' actions; INDEFINITE when INGEST_POLL_ENABLED=false",
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
  // `known` FIRST — the analysed set. Fixtures are synthetic modules that do not exist on disk, and
  // a disk-only resolver silently failed to follow them, which would have left the barrel controls
  // green-by-construction: passing for the same reason a real barrel would have been missed.
  for (const rel of rels) if (known.has(rel)) return rel;
  for (const rel of rels) {
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
 * ⚠️ FABLE DIFF REVIEW, BLOCKER 1. The previous version's comment claimed "one level is followed by
 * `resolveSpecifier`". That was false: `resolveSpecifier` resolves PATH SPELLINGS, it never reads a
 * re-export. Fable defeated the guard with four lines —
 *   `lib/barrel.ts:  export { ingestItem } from "@/lib/ingest";`
 *   `lib/writer.ts:  import { ingestItem } from "@/lib/barrel"; await ingestItem(...)`
 * — and the guard stayed 25/25 green. Barrels are now FOLLOWED (transitively) rather than refused,
 * which both closes the hole and keeps a legitimate barrel usable.
 */
function writerModules(files: { rel: string; code: string }[], known: ReadonlySet<string>): Set<string> {
  const set = new Set<string>([CANONICAL]);
  const byRel = new Map(files.map((f) => [f.rel, f.code]));
  if (!byRel.has(CANONICAL)) byRel.set(CANONICAL, "");
  let grew = true;
  while (grew) {
    grew = false;
    for (const [rel, code] of byRel) {
      if (set.has(rel)) continue;
      const src = parse(rel, code);
      let exportsWriter = false;
      const visit = (n: ts.Node): void => {
        if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) {
          const target = resolveSpecifier(rel, n.moduleSpecifier.text, known);
          if (target && set.has(target)) {
            // `export * from` re-exports everything; a named clause must actually name the writer.
            if (!n.exportClause) exportsWriter = true;
            else if (ts.isNamedExports(n.exportClause)) {
              for (const el of n.exportClause.elements) {
                if ((el.propertyName?.text ?? el.name.text) === WRITER) exportsWriter = true;
              }
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(src);
      if (exportsWriter) {
        set.add(rel);
        grew = true;
      }
    }
  }
  return set;
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
const parse = (rel: string, code: string) =>
  ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, scriptKind(rel));

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
function bindingsFor(rel: string, src: ts.SourceFile, modules: Set<string>, known: ReadonlySet<string>): Bindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  const declSites = new Set<ts.Node>();
  const isWriterModule = (spec: string) => {
    const t = resolveSpecifier(rel, spec, known);
    return t !== null && modules.has(t);
  };

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
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && isWriterModule(node.moduleSpecifier.text)) {
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            if ((el.propertyName?.text ?? el.name.text) === WRITER) addDirect(el.name.text, el.name);
          }
        } else if (named && ts.isNamespaceImport(named)) addNs(named.name.text, named.name);
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
          if (ts.isObjectBindingPattern(node.name)) {
            for (const el of node.name.elements) {
              const orig = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : undefined;
              const local = ts.isIdentifier(el.name) ? el.name.text : undefined;
              if ((orig ?? local) === WRITER && local) addDirect(local, el.name);
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

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !b.declSites.has(node)) {
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
      calls++;
      if (inAfter) insideAfter++;
    }
    ts.forEachChild(node, (c) => visit(c, nowInAfter));
  };
  visit(src, false);
  return { calls, insideAfter, aliasedAfter };
}

/* ────────────────────────── analysis over the real tree ────────────────────────── */

/**
 * Directories walked, and every top-level directory NOT walked WITH ITS REASON.
 *
 * ⚠️ FABLE DIFF REVIEW, HIGH 2. The previous list was `["lib", "app", "scripts"]`, which silently
 * omitted `components/` — 109 shipped files, several already importing `lib/ingest/*` — plus every
 * ROOT-LEVEL source (`instrumentation.ts`, `proxy.ts`) and every non-`.ts` extension. A guard whose
 * coverage shrinks silently as the repo grows is the failure it exists to prevent, so the two lists
 * below must together account for the ENTIRE top level (asserted by AC9) — a new shipped directory
 * fails the build until someone decides which list it belongs in.
 */
const WALKED = ["app", "components", "lib", "scripts"] as const;
const NOT_WALKED: Record<string, string> = {
  docker: "container bootstrap (.mjs/.sh); calls the drain rather than the writer",
  docs: "prose",
  fixtures: "test data",
  graphiti: "the Python graph sidecar — HTTP-only to the brain",
  ingestion: "the Python connector sidecar — HTTP-only to the brain",
  postgres: "SQL schema + migrations",
  public: "static assets",
  supabase: "legacy SQL, retired backend",
  test: "tests are not writers",
  validation: "evaluation fixtures/reports",
};
const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

const SKIP_FILE = (rel: string) =>
  /\.test\.tsx?$/.test(rel) ||
  rel.endsWith(".d.ts") ||
  rel === CANONICAL ||
  // Not a writer: an in-memory PostgREST double used only by tests.
  rel === "lib/ingest/fake-supabase.ts";

function productionFiles(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (relDir: string) => {
    for (const name of readdirSync(join(ROOT, relDir))) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const rel = `${relDir}/${name}`;
      const st = statSync(join(ROOT, rel));
      if (st.isDirectory()) {
        // Symlinked directories would loop or double-count; visit each real path once.
        const real = relative(ROOT, realpathSync(join(ROOT, rel)));
        if (seen.has(real)) continue;
        seen.add(real);
        walk(rel);
      } else if (SOURCE_EXT.some((e) => rel.endsWith(e)) && !SKIP_FILE(rel)) out.push(rel);
    }
  };
  for (const r of WALKED) walk(r);
  // Root-level sources ship too (`instrumentation.ts`, `proxy.ts`) and the old walk never saw them.
  for (const name of readdirSync(ROOT)) {
    if (SOURCE_EXT.some((e) => name.endsWith(e)) && !SKIP_FILE(name) && statSync(join(ROOT, name)).isFile()) {
      out.push(name);
    }
  }
  return out.sort();
}

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
  const modules = writerModules(files, known);

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

const realFiles = () => productionFiles().map((rel) => ({ rel, code: read(rel) }));

/* ────────────────────────────── the criteria ────────────────────────────── */

const IMPORT_CANON = `import { ${WRITER} } from "@/lib/ingest";`;
const NO_INVENTORY: Record<string, Entry> = {};
const classified = (rel: string, cls: Classification, sites = 1): Record<string, Entry> => ({
  [rel]: { sites, class: cls, reason: "fixture", latency: "fixture" },
});

describe("§11 context-partition — the WRITER INVENTORY (AUDITFIX-2)", () => {
  it("AC3 — the real tree passes, and the discovered inventory is EXACT", () => {
    const { violations, sites } = analyse(realFiles(), INVENTORY);
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
  });

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
  const CONTROLS: { n: string; files: { rel: string; code: string }[]; inv: Record<string, Entry>; kind: Violation["kind"] | null }[] = [
    { n: "1 canonical named import + call", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "2 aliased import", files: [{ rel: "lib/f.ts", code: `import { ${WRITER} as writeItem } from "@/lib/ingest";\nawait writeItem(a);` }], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "3 namespace member call", files: [{ rel: "lib/f.ts", code: `import * as ingest from "@/lib/ingest";\nawait ingest.${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "4 RELATIVE specifier (the escape already in this tree)", files: [{ rel: "scripts/f.ts", code: `import { ${WRITER} } from "../lib/ingest";\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "5 explicit /index specifier", files: [{ rel: "lib/f.ts", code: `import { ${WRITER} } from "@/lib/ingest/index";\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "6 dynamic-import destructure", files: [{ rel: "lib/f.ts", code: `const { ${WRITER} } = await import("@/lib/ingest");\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "7 direct alias", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nconst write = ${WRITER};\nawait write(a);` }], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "8 computed namespace key", files: [{ rel: "lib/f.ts", code: `import * as ingest from "@/lib/ingest";\nawait ingest["${WRITER}"](a);` }], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "9 RECONCILES_AFTER_RESPONSE whose reconcile is only a comment", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\n// reconcileItemContext(db, t, id)\nawait ${WRITER}(a);` }], inv: classified("lib/f.ts", "RECONCILES_AFTER_RESPONSE"), kind: "shape" },
    { n: "10 stored in an object literal", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nconst box = { w: ${WRITER} };\nawait box.w(a);` }], inv: NO_INVENTORY, kind: "refused" },
    { n: "11 stale entry — classified file with no call", files: [{ rel: "lib/f.ts", code: `export const x = 1;` }], inv: classified("lib/f.ts", "SWEEP_COVERED"), kind: "stale" },
    // ── Fable's demonstrated defeats ──────────────────────────────────────────────────────────
    { n: "12 FABLE B1 — re-export barrel", files: [
        { rel: "lib/barrel.ts", code: `export { ${WRITER} } from "@/lib/ingest";` },
        { rel: "lib/w.ts", code: `import { ${WRITER} } from "@/lib/barrel";\nawait ${WRITER}(a);` },
      ], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "13 FABLE B1b — barrel via a specifier containing no 'ingest'", files: [
        { rel: "lib/ingest/barrel.ts", code: `export { ${WRITER} } from "./index";` },
        { rel: "lib/w.ts", code: `import { ${WRITER} } from "@/lib/ingest/barrel";\nawait ${WRITER}(a);` },
      ], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "14 FABLE B1c — export * barrel", files: [
        { rel: "lib/star.ts", code: `export * from "@/lib/ingest";` },
        { rel: "lib/w.ts", code: `import { ${WRITER} } from "@/lib/star";\nawait ${WRITER}(a);` },
      ], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "15 FABLE B2 — two-step dynamic import", files: [{ rel: "lib/f.ts", code: `const mod = await import("@/lib/ingest");\nconst { ${WRITER} } = mod;\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "16 FABLE B2b — require() destructure", files: [{ rel: "lib/f.ts", code: `const { ${WRITER} } = require("../lib/ingest");\nawait ${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "17 FABLE B2c — import = require()", files: [{ rel: "lib/f.ts", code: `import ingest = require("@/lib/ingest");\nawait ingest.${WRITER}(a);` }], inv: NO_INVENTORY, kind: "unclassified" },
    { n: "18 FABLE B3 — comma-expression indirect call", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nawait (0, ${WRITER})(a);` }], inv: NO_INVENTORY, kind: "refused" },
    { n: "19 FABLE B3b — .call/.apply", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nawait ${WRITER}.call(null, a);` }], inv: NO_INVENTORY, kind: "refused" },
    { n: "20 FABLE B3c — passed as an argument", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nregister(${WRITER});` }], inv: NO_INVENTORY, kind: "refused" },
    { n: "21 namespace passed as a value", files: [{ rel: "lib/f.ts", code: `import * as ingest from "@/lib/ingest";\nregister(ingest);` }], inv: NO_INVENTORY, kind: "refused" },
    // ── Two rules added in the Fable fold whose mutations SURVIVED: nothing pinned them ────────
    { n: "22 the per-entry site COUNT is wrong (a new call site appeared)", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nawait ${WRITER}(a);\nawait ${WRITER}(b);` }], inv: classified("lib/f.ts", "SWEEP_COVERED", 1), kind: "stale" },
    { n: "23 `after` imported under another name — the shape check cannot judge it", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nimport { after as later } from "next/server";\nawait ${WRITER}(a);\nlater(async () => { await reconcileItemContext(db, t, id); });` }], inv: classified("lib/f.ts", "RECONCILES_AFTER_RESPONSE"), kind: "shape" },
    // ── Positive twins: without these, a guard that always failed would pass every row above ────
    { n: "T1 FABLE H1 — a LOCAL function of the same name, used as a VALUE", files: [{ rel: "lib/f.ts", code: `function ${WRITER}(x: string){ return x; }\nexport const registry = { ${WRITER} };` }], inv: NO_INVENTORY, kind: null },
    { n: "T2 a dynamic import of another module, no call", files: [{ rel: "lib/f.ts", code: `const { other } = await import("@/lib/other");` }], inv: NO_INVENTORY, kind: null },
    { n: "T3 canonical import used only in a TYPE position", files: [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\ntype F = typeof ${WRITER};\nexport const z: F | null = null;` }], inv: NO_INVENTORY, kind: null },
    { n: "T4 a namespace's OTHER exports are not our business", files: [{ rel: "lib/f.ts", code: `import * as ingest from "@/lib/ingest";\nawait ingest.somethingElse(a);` }], inv: NO_INVENTORY, kind: null },
    { n: "T5 a barrel that re-exports something else entirely", files: [
        { rel: "lib/other-barrel.ts", code: `export { helper } from "@/lib/other";` },
        { rel: "lib/w.ts", code: `import { helper } from "@/lib/other-barrel";\nhelper();` },
      ], inv: NO_INVENTORY, kind: null },
  ];

  it.each(CONTROLS)("AC2 — control $n", ({ files, inv, kind }) => {
    const { violations } = analyse(files, inv);
    if (kind === null) expect(violations.map((v) => v.message)).toEqual([]);
    else expect(violations.map((v) => v.kind)).toContain(kind);
  });

  it("AC9 — the walked + not-walked lists account for the ENTIRE top level", () => {
    // Fable HIGH 2: the previous roots list silently omitted `components/` (109 shipped files).
    // Coverage must not shrink as the repo grows, so a NEW top-level directory fails here until
    // someone decides which list it belongs in.
    const actual = readdirSync(ROOT)
      .filter((n) => !n.startsWith(".") && n !== "node_modules" && statSync(join(ROOT, n)).isDirectory())
      .sort();
    expect(actual).toEqual([...WALKED, ...Object.keys(NOT_WALKED)].sort());
  });

  it("AC10 — the walk actually reaches components/ and the root-level sources", () => {
    // Set-equality (AC3) proves the INVENTORY is exact; it cannot prove the walk is wide, because a
    // narrower walk finds the same seven writers. This is the coverage half, asserted separately.
    const files = productionFiles();
    expect(files.some((f) => f.startsWith("components/")), "components/ must be walked").toBe(true);
    expect(files, "root-level server sources must be walked").toContain("instrumentation.ts");
    expect(files.length).toBeGreaterThan(500);
  });

  it("AC4 — a stale classification fails even when the tree is otherwise clean", () => {
    const { violations } = analyse(realFiles(), { ...INVENTORY, "lib/gone.ts": { sites: 1, class: "SWEEP_COVERED", reason: "r", latency: "l" } });
    expect(violations.map((v) => v.kind)).toEqual(["stale"]);
    expect(violations[0].message).toContain("lib/gone.ts");
  });

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
      [{ rel: "lib/f.ts", code: `${IMPORT_CANON}\nlet w = ${WRITER};\nw = somethingElse;\nawait w(a);` }],
      NO_INVENTORY
    );
    expect(violations.some((v) => v.kind === "refused" && v.message.startsWith("REFUSED:"))).toBe(true);
  });

  it("AC8 — no re-export barrel exists today, so the walk sees the real module", () => {
    // If one ever appears, `bindingsFor` refuses a SECOND level rather than missing it silently.
    // Asserted here because otherwise that branch is unreachable and therefore untested.
    const barrels = productionFiles().filter(
      (rel) => /^lib\/ingest\//.test(rel) && rel !== CANONICAL && /export\s[^;]*\sfrom\s+["'][^"']*ingest/.test(read(rel))
    );
    expect(barrels, "a new lib/ingest barrel needs the second-level refusal exercised").toEqual([]);
  });
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
