import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

/** Directories that ship or are a supported operator command. `scripts/` is IN: `npm run dev:seed`
 *  runs `scripts/seed-demo.ts` directly with NO drain (only `docker/bootstrap.mjs` drains), so
 *  excluding it would claim every writer while omitting a supported one. */
const ROOTS = ["lib", "app", "scripts"];
const SKIP_FILE = (rel: string) =>
  rel.endsWith(".test.ts") ||
  rel.endsWith(".test.tsx") ||
  rel === CANONICAL ||
  // Not a writer: an in-memory PostgREST double used only by tests.
  rel === "lib/ingest/fake-supabase.ts";

type Classification = "RECONCILES_AFTER_RESPONSE" | "RECONCILES_INLINE" | "SWEEP_COVERED";

interface Entry {
  class: Classification;
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
    class: "RECONCILES_AFTER_RESPONSE",
    reason: "the workspace CLI push path; reconciling in after() keeps the push from blocking on it",
    latency: "measured 0.0 min median on prod — 41/41 items partitioned inside 60s",
  },
  "lib/meetings/notes.ts": {
    class: "RECONCILES_INLINE",
    reason: "inline ON PURPOSE: without it the uploader's own meeting 404s until the sweep",
    latency: "immediate; `visible:false` is returned when the reconcile did not complete",
  },
  "lib/meetings/merge.ts": {
    class: "RECONCILES_INLINE",
    reason:
      "inline and LOAD-BEARING: it throws and aborts the merge if the reconcile fails, BEFORE " +
      "re-pointing the survivor. Deferring to after() would break that ordering contract",
    latency: "immediate, and a failure aborts the write rather than deferring it",
  },
  "lib/codebases/commits-to-items.ts": {
    class: "SWEEP_COVERED",
    reason:
      "reached only from POST /api/v1/codebases via ingestCodebaseScan. Reconciling at push was " +
      "specced and DECLINED (spec §6b): it needs an admission allocation, not a budget — the route " +
      "admits 60 req/min per key and `recent_commits` has no array maximum",
    latency: "⚠️ 64% of ingested volume; median 8.0-8.8 min, up to one full tick interval",
  },
  "lib/ingest/run.ts": {
    class: "SWEEP_COVERED",
    reason:
      "the four scheduled connector legs. The tick sequences them BEFORE runContextBackfill and the " +
      "sweep's cutoff is taken at STAGE start, so a scheduled leg's items are swept in their own tick",
    latency:
      "measured 0.8-1.9 min when scheduled; next tick or later via manual sync and the four admin " +
      "'Run now' actions; INDEFINITE when INGEST_POLL_ENABLED=false",
  },
  "lib/actions/handlers.ts": {
    class: "SWEEP_COVERED",
    reason:
      "note.create, reached from POST /api/v1/actions (runAction) and the admin approval path — " +
      "an HTTP/admin writer OUTSIDE the scheduler chain, not inside it",
    latency: "⚠️ next tick or later; no backstop when INGEST_POLL_ENABLED=false",
  },
  "scripts/seed-demo.ts": {
    class: "SWEEP_COVERED",
    reason:
      "demo seeding. Drained ONLY under docker/bootstrap.mjs; `npm run dev:seed`, scripts/e2e.sh " +
      "and scripts/dev-test-setup.sh invoke it with no drain",
    latency: "⚠️ undrained on the direct invocations; unreachable indefinitely with the poller off",
  },
};

/* ────────────────────────── canonical module resolution ────────────────────────── */

/** Resolve a module specifier from `fromRel` to a repo-relative path, or null if it is not ours. */
function resolveSpecifier(fromRel: string, spec: string): string | null {
  let abs: string;
  if (spec.startsWith("@/")) abs = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) abs = resolvePath(join(ROOT, dirname(fromRel)), spec);
  else return null; // a bare package specifier is never this repo's module
  for (const cand of [abs, `${abs}.ts`, `${abs}.tsx`, join(abs, "index.ts"), join(abs, "index.tsx")]) {
    try {
      if (statSync(cand).isFile()) return relative(ROOT, cand).split("\\").join("/");
    } catch {
      /* not this candidate */
    }
  }
  return null;
}

/** True when the specifier names the canonical writer module, through ANY spelling of the path. */
const isCanonical = (fromRel: string, spec: string) => resolveSpecifier(fromRel, spec) === CANONICAL;

/* ────────────────────────────── the walk ────────────────────────────── */

interface Bindings {
  /** Local names bound to the writer itself. */
  direct: Set<string>;
  /** Local names bound to the canonical module namespace. */
  namespaces: Set<string>;
  /** Constructs we cannot decide — the guard FAILS on these rather than guessing. */
  refused: string[];
}

const parse = (rel: string, code: string) =>
  ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/**
 * The SUPPORTED binding forms, and the refusal for everything else.
 *
 * Supported: named import (incl. alias), namespace import, `const {ingestItem} = await import(...)`,
 * and a DIRECT alias (`const write = ingestItem`).
 *
 * REFUSED — reassignment, conditional aliases, storage in an object/array, chained aliases through
 * an unsupported form. "Local rebinding" is not decidable in general, so the undecidable cases are
 * named and fail rather than being silently dropped. A fail-closed branch nobody tests is the branch
 * that quietly becomes fail-open, so control 10 exercises this one.
 */
function bindingsFor(rel: string, src: ts.SourceFile): Bindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  const refused: string[] = [];
  const at = (n: ts.Node) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;

  const visit = (node: ts.Node): void => {
    // `import … from "…"` / `export … from "…"`
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (isCanonical(rel, node.moduleSpecifier.text)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            // `{ ingestItem }` or `{ ingestItem as write }` — propertyName is the ORIGINAL.
            if ((el.propertyName?.text ?? el.name.text) === WRITER) direct.add(el.name.text);
          }
        } else if (named && ts.isNamespaceImport(named)) {
          namespaces.add(named.name.text);
        }
      }
    }
    // A re-export barrel. One level is followed by resolveSpecifier; a barrel that re-exports a
    // barrel is REFUSED rather than silently unseen. None exists today (asserted by AC8).
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const target = resolveSpecifier(rel, node.moduleSpecifier.text);
      if (target && target !== CANONICAL && /^lib\/ingest\//.test(target)) {
        const inner = readFileSync(join(ROOT, target), "utf8");
        if (/export\s[^;]*\sfrom\s/.test(inner) && new RegExp(`\\b${WRITER}\\b`).test(inner)) {
          refused.push(`${at(node)} re-export barrel chains through ${target} — cannot see through a second level`);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      // `const { ingestItem } = await import("@/lib/ingest")`
      const awaited = ts.isAwaitExpression(init) ? init.expression : init;
      if (
        ts.isCallExpression(awaited) &&
        awaited.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteralLike(awaited.arguments[0]) &&
        isCanonical(rel, (awaited.arguments[0] as ts.StringLiteral).text)
      ) {
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const orig = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : undefined;
            const local = ts.isIdentifier(el.name) ? el.name.text : undefined;
            if ((orig ?? local) === WRITER && local) direct.add(local);
          }
        } else if (ts.isIdentifier(node.name)) {
          namespaces.add(node.name.text);
        }
      }
      // `const write = ingestItem` — a DIRECT alias of an already-known binding.
      if (ts.isIdentifier(init) && direct.has(init.text) && ts.isIdentifier(node.name)) {
        direct.add(node.name.text);
      }
      // Undecidable carriers of a known binding.
      //
      // ⚠️ FOUND BY THIS TEST ON ITS FIRST RUN, and the bug was mine: a naive scan refused
      // `lib/actions/handlers.ts`, whose `const noteCreate = { type, async execute() { … } }`
      // object literal CONTAINS a method that calls the writer. Containing a function that CALLS
      // it is not STORING the binding, so the scan must stop at every function boundary — and the
      // identifier must appear as a VALUE, not as a callee.
      const carriesWriter = (e: ts.Expression): boolean => {
        let found = false;
        const scan = (n: ts.Node) => {
          if (
            ts.isFunctionDeclaration(n) ||
            ts.isFunctionExpression(n) ||
            ts.isArrowFunction(n) ||
            ts.isMethodDeclaration(n) ||
            ts.isGetAccessor(n) ||
            ts.isSetAccessor(n)
          ) {
            return; // a nested function's body is not this literal's value
          }
          if (
            ts.isIdentifier(n) &&
            (direct.has(n.text) || n.text === WRITER) &&
            !(ts.isCallExpression(n.parent) && n.parent.expression === n)
          ) {
            found = true;
          }
          ts.forEachChild(n, scan);
        };
        scan(e);
        return found;
      };
      if (
        !ts.isIdentifier(init) &&
        (ts.isObjectLiteralExpression(init) ||
          ts.isArrayLiteralExpression(init) ||
          ts.isConditionalExpression(init) ||
          ts.isBinaryExpression(init)) &&
        carriesWriter(init)
      ) {
        refused.push(`${at(node)} unsupported ${WRITER} binding (${ts.SyntaxKind[init.kind]}) — import it directly or classify the file explicitly`);
      }
    }
    // Reassignment of a known binding.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      direct.has(node.left.text)
    ) {
      refused.push(`${at(node)} reassigns the ${WRITER} binding \`${node.left.text}\` — undecidable`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return { direct, namespaces, refused };
}

/** Direct call sites of the writer in this file, as `file:line` strings. */
function callSites(rel: string, src: ts.SourceFile, b: Bindings): string[] {
  const hits: string[] = [];
  const at = (n: ts.Node) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      if (ts.isIdentifier(c) && b.direct.has(c.text)) hits.push(at(node));
      else if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && b.namespaces.has(c.expression.text) && c.name.text === WRITER) {
        hits.push(at(node));
      } else if (
        ts.isElementAccessExpression(c) &&
        ts.isIdentifier(c.expression) &&
        b.namespaces.has(c.expression.text) &&
        ts.isStringLiteralLike(c.argumentExpression) &&
        c.argumentExpression.text === WRITER
      ) {
        hits.push(at(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return hits;
}

/** Does this module await `reconcileItemContext`, and is that call inside an `after(...)` callback? */
function reconcileShape(src: ts.SourceFile): { calls: number; insideAfter: number } {
  let calls = 0;
  let insideAfter = 0;
  const visit = (node: ts.Node, inAfter: boolean): void => {
    let nowInAfter = inAfter;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "after") nowInAfter = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "reconcileItemContext") {
      calls++;
      if (inAfter) insideAfter++;
    }
    ts.forEachChild(node, (c) => visit(c, nowInAfter));
  };
  visit(src, false);
  return { calls, insideAfter };
}

/* ────────────────────────── analysis over the real tree ────────────────────────── */

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (relDir: string) => {
    for (const name of readdirSync(join(ROOT, relDir))) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const rel = `${relDir}/${name}`;
      const st = statSync(join(ROOT, rel));
      if (st.isDirectory()) walk(rel);
      else if ((rel.endsWith(".ts") || rel.endsWith(".tsx")) && !SKIP_FILE(rel)) out.push(rel);
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
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

  for (const f of files) {
    const src = parse(f.rel, f.code);
    const b = bindingsFor(f.rel, src);
    for (const r of b.refused) violations.push({ kind: "refused", message: `REFUSED: ${r}` });
    const hits = callSites(f.rel, src, b);
    if (hits.length === 0) continue;
    sites[f.rel] = hits.length;

    const entry = inventory[f.rel];
    if (!entry) {
      violations.push({
        kind: "unclassified",
        message:
          `${f.rel} calls ${WRITER} (${hits.join(", ")}) but is not classified. Add it to INVENTORY ` +
          `with a class and a REASON — do not silence this.`,
      });
      continue;
    }
    if (!entry.reason.trim()) {
      violations.push({ kind: "unclassified", message: `${f.rel} has an empty rationale` });
    }
    const shape = reconcileShape(src);
    if (entry.class === "RECONCILES_AFTER_RESPONSE" && shape.insideAfter === 0) {
      violations.push({ kind: "shape", message: `${f.rel} is RECONCILES_AFTER_RESPONSE but has no reconcileItemContext inside an after() callback` });
    }
    if (entry.class === "RECONCILES_INLINE") {
      if (shape.calls === 0) {
        violations.push({ kind: "shape", message: `${f.rel} is RECONCILES_INLINE but never calls reconcileItemContext` });
      } else if (shape.calls === shape.insideAfter) {
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
const classified = (rel: string, cls: Classification): Record<string, Entry> => ({
  [rel]: { class: cls, reason: "fixture", latency: "fixture" },
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
  const CONTROLS: { n: string; rel: string; code: string; inv: Record<string, Entry>; kind: Violation["kind"] | null }[] = [
    { n: "1 canonical named import + call", rel: "lib/f.ts", code: `${IMPORT_CANON}\nawait ${WRITER}(a);`, inv: NO_INVENTORY, kind: "unclassified" },
    { n: "2 aliased import", rel: "lib/f.ts", code: `import { ${WRITER} as writeItem } from "@/lib/ingest";\nawait writeItem(a);`, inv: NO_INVENTORY, kind: "unclassified" },
    { n: "3 namespace member call", rel: "lib/f.ts", code: `import * as ingest from "@/lib/ingest";\nawait ingest.${WRITER}(a);`, inv: NO_INVENTORY, kind: "unclassified" },
    { n: "4 RELATIVE specifier (the escape already in this tree)", rel: "scripts/f.ts", code: `import { ${WRITER} } from "../lib/ingest";\nawait ${WRITER}(a);`, inv: NO_INVENTORY, kind: "unclassified" },
    { n: "5 explicit /index specifier", rel: "lib/f.ts", code: `import { ${WRITER} } from "@/lib/ingest/index";\nawait ${WRITER}(a);`, inv: NO_INVENTORY, kind: "unclassified" },
    { n: "6 dynamic-import destructure", rel: "lib/f.ts", code: `const { ${WRITER} } = await import("@/lib/ingest");\nawait ${WRITER}(a);`, inv: NO_INVENTORY, kind: "unclassified" },
    { n: "7 direct alias", rel: "lib/f.ts", code: `${IMPORT_CANON}\nconst write = ${WRITER};\nawait write(a);`, inv: NO_INVENTORY, kind: "unclassified" },
    { n: "8 computed namespace key", rel: "lib/f.ts", code: `import * as ingest from "@/lib/ingest";\nawait ingest["${WRITER}"](a);`, inv: NO_INVENTORY, kind: "unclassified" },
    { n: "9 RECONCILES_AFTER_RESPONSE whose reconcile is only a comment", rel: "lib/f.ts", code: `${IMPORT_CANON}\n// reconcileItemContext(db, t, id)\nawait ${WRITER}(a);`, inv: classified("lib/f.ts", "RECONCILES_AFTER_RESPONSE"), kind: "shape" },
    { n: "10 undecidable binding (object carrier)", rel: "lib/f.ts", code: `${IMPORT_CANON}\nconst box = { w: ${WRITER} };\nawait box.w(a);`, inv: NO_INVENTORY, kind: "refused" },
    { n: "11 stale entry — classified file with no call", rel: "lib/f.ts", code: `export const x = 1;`, inv: classified("lib/f.ts", "SWEEP_COVERED"), kind: "stale" },
    // Positive twins — without these, a guard that always failed would pass every row above.
    { n: "T1 a LOCAL function of the same name, no canonical import", rel: "lib/f.ts", code: `function ${WRITER}(a){return a}\nawait ${WRITER}(1);`, inv: NO_INVENTORY, kind: null },
    { n: "T2 a dynamic import of another module, no call", rel: "lib/f.ts", code: `const { other } = await import("@/lib/other");`, inv: NO_INVENTORY, kind: null },
    { n: "T3 canonical import used only in a TYPE position", rel: "lib/f.ts", code: `${IMPORT_CANON}\ntype F = typeof ${WRITER};\nexport const z: F | null = null;`, inv: NO_INVENTORY, kind: null },
    // T4 pins the FUNCTION-BOUNDARY stop in `carriesWriter`, whose own mutation SURVIVED without it:
    // the callee-exclusion alone already spares `lib/actions/handlers.ts`, so the boundary rule had
    // no distinct property pinned and was effectively untested. Here the writer appears as a
    // non-callee VALUE inside a function inside an object literal — a shape the callee check does
    // NOT spare. Only the boundary stop keeps this from being a false REFUSAL.
    { n: "T4 writer referenced as a value inside a nested function", rel: "lib/f.ts", code: `${IMPORT_CANON}\nconst registry = { register: () => track(${WRITER}) };\nexport default registry;`, inv: NO_INVENTORY, kind: null },
  ];

  it.each(CONTROLS)("AC2 — control $n", ({ rel, code, inv, kind }) => {
    const { violations } = analyse([{ rel, code }], inv);
    if (kind === null) {
      expect(violations.map((v) => v.message)).toEqual([]);
    } else {
      expect(violations.map((v) => v.kind)).toContain(kind);
    }
  });

  it("AC4 — a stale classification fails even when the tree is otherwise clean", () => {
    const { violations } = analyse(realFiles(), { ...INVENTORY, "lib/gone.ts": { class: "SWEEP_COVERED", reason: "r", latency: "l" } });
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
