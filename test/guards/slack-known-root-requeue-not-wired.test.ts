import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { PR743_PINNED_PATHS } from "./slack-aggregate-pagination-pr743-paths";

/**
 * AIO-1170 AC-02 — boundary guard for the inactive known-root requeue packet
 * (`docs/design/slack-known-root-requeue-spec.md` §3, §13; KR-14).
 *
 * `test/guards/slack-source-not-wired.test.ts` already keeps both modules unreachable from every
 * execution entry. This file guards what reachability cannot see:
 *
 *  1. OUTSIDE IMPORTS. Nothing in the application outside the packet imports either module, by any
 *     spelling, type-only imports included. An unreferenced library file importing the preparer is
 *     not reachable from an entry point today, and is exactly one import away from being so.
 *  2. DEPENDENCIES. The two modules import only what the specification lets them use. No provider
 *     transport, no pool, no transaction opener, no ingest entry, no ledger or channel writer, no
 *     integration management. Local secret resolution through the selection helper is allowed.
 *  3. WRITES. The existing enqueue helper is the packet's only queue writer. Neither module carries
 *     DML or DDL of its own, opens a transaction, races a statement or calls out.
 *  4. OWNERSHIP. Every path of the packet is outside the pinned PR 743 inventory.
 *
 * Self-contained on purpose: the shared entry-surface helper is one of the PR 743 paths.
 */

const ROOT = join(import.meta.dirname, "..", "..");

const PAGE = "lib/ingest/slack-known-root-page.ts";
const REQUEUE = "lib/ingest/slack-known-root-requeue.ts";
const PACKET_MODULES: readonly string[] = [PAGE, REQUEUE];

/** Every path the accepted specification allows this packet to add or change. */
const PACKET_PATHS: readonly string[] = [
  PAGE,
  REQUEUE,
  "test/slack-known-root-requeue.test.ts",
  "test/datamechanics/slack-known-root-requeue.datamechanics.test.ts",
  "test/guards/slack-known-root-requeue-not-wired.test.ts",
  "test/guards/slack-source-not-wired.test.ts",
  "docs/design/slack-known-root-requeue-spec.md",
  "docs/design/slack-timeline-build-record.md",
];

/** The repository files each module may import directly. Anything else is a boundary change. */
const ALLOWED_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  [PAGE]: ["lib/db/types.ts", "lib/ingest/sources/slack-message-evidence.ts"],
  [REQUEUE]: [
    PAGE,
    "lib/db/types.ts",
    // Only the error CLASS, for the classifier's known-identity rule. See NAMED_ONLY below.
    "lib/db/pg/tx.ts",
    "lib/ingest/slack-namespace-gate.ts",
    "lib/ingest/slack-source-binding.ts",
    "lib/ingest/slack-thread-state.ts",
    "lib/ingest/sources/slack-namespace.ts",
    "lib/ingest/sources/slack-message-evidence.ts",
  ],
};

/** Bare package specifiers either module may name. */
const ALLOWED_PACKAGES: readonly string[] = ["server-only"];

/** Dependencies of which only these VALUE names may be imported (type-only names are free). */
const NAMED_ONLY: Readonly<Record<string, readonly string[]>> = {
  // The sole production queue writer of this packet.
  "lib/ingest/slack-thread-state.ts": ["enqueueSlackThread"],
  // Never `runPgClientTransaction`, `withTransaction` or a session helper.
  "lib/db/pg/tx.ts": ["TransactionExecutionError"],
};

// ── imports ──────────────────────────────────────────────────────────────────

interface ImportEdge {
  specifier: string;
  /** Value names imported; `*` for a namespace, default, side-effect, dynamic or require import. */
  values: string[];
}

/** Every import of a source file, read from the compiler's syntax tree — never from a text pattern. */
function importsOf(file: string, source: string): ImportEdge[] {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const edges: ImportEdge[] = [];
  const text = (node: ts.Node | undefined): string | null =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = text(node.moduleSpecifier);
      if (specifier !== null) {
        const clause = node.importClause;
        const values: string[] = [];
        if (!clause) values.push("*"); // side-effect import
        else if (!clause.isTypeOnly) {
          if (clause.name) values.push("*"); // default import
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) values.push("*");
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if (!element.isTypeOnly) values.push((element.propertyName ?? element.name).text);
            }
          }
        }
        edges.push({ specifier, values });
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = text(node.moduleSpecifier);
      if (specifier !== null) edges.push({ specifier, values: node.isTypeOnly ? [] : ["*"] });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = text(node.moduleReference.expression);
      if (specifier !== null) edges.push({ specifier, values: ["*"] });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = text(node.argument.literal);
      if (specifier !== null) edges.push({ specifier, values: [] });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const dynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(callee) && callee.text === "require";
      if (dynamicImport || requireCall) {
        const specifier = text(node.arguments[0]);
        if (specifier !== null) edges.push({ specifier, values: ["*"] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return edges;
}

/** A `@/…` or relative specifier as a repo-relative file of the tree, or null for a package. */
function resolve(tree: ReadonlyMap<string, string>, fromRel: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? normalize(specifier.slice(2)) : specifier.startsWith(".") ? join(dirname(fromRel), specifier) : null;
  if (base === null) return null;
  const stem = base.replace(/\.(?:js|mjs|cjs|jsx)$/, "");
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${stem}.ts`, `${stem}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((candidate) => tree.has(candidate)) ?? null;
}

/** `importer → module` for every import of a packet module from outside the packet. */
function outsideImporters(tree: ReadonlyMap<string, string>): string[] {
  const edges: string[] = [];
  for (const [file, source] of tree) {
    if (PACKET_MODULES.includes(file)) continue;
    for (const edge of importsOf(file, source)) {
      const target = resolve(tree, file, edge.specifier);
      if (target !== null && PACKET_MODULES.includes(target)) edges.push(`${file} → ${target}`);
    }
  }
  return [...new Set(edges)].sort();
}

/** Every import of one packet module that its allowlist does not cover. */
function dependencyViolations(tree: ReadonlyMap<string, string>, module: string): string[] {
  const violations: string[] = [];
  const allowed = ALLOWED_DEPENDENCIES[module] ?? [];
  for (const edge of importsOf(module, tree.get(module) ?? "")) {
    const target = resolve(tree, module, edge.specifier);
    if (target === null) {
      const relativeOrAlias = edge.specifier.startsWith(".") || edge.specifier.startsWith("@/");
      if (relativeOrAlias) violations.push(`${module}: unresolved import ${edge.specifier}`);
      else if (!ALLOWED_PACKAGES.includes(edge.specifier)) violations.push(`${module}: package ${edge.specifier}`);
      continue;
    }
    if (!allowed.includes(target)) {
      violations.push(`${module}: imports ${target}`);
      continue;
    }
    const names = NAMED_ONLY[target];
    if (names) {
      for (const value of edge.values) {
        if (!names.includes(value)) violations.push(`${module}: imports ${value} from ${target}`);
      }
    }
  }
  return violations.sort();
}

// ── writes and effects ───────────────────────────────────────────────────────

const DML_OR_DDL = /\b(?:insert\s+into|delete\s+from|update\s+[a-z_."]+\s+set|merge\s+into|truncate|alter\s+table|drop\s+table|create\s+(?:table|index|unique)|savepoint|begin\b|commit\b|rollback\b)/i;

/** Identifiers that open a transaction, reach a pool, call out, or abandon a running statement. */
const FORBIDDEN_IDENTIFIERS: readonly string[] = [
  "fetch", "getPool", "runSql", "adminClient", "runContextTransaction", "transactionCapability",
  "runPgClientTransaction", "withTransaction", "AbortController", "AbortSignal", "XMLHttpRequest", "WebSocket",
];

/** What a module's own code does that the packet may not: read from the syntax tree, comments excluded. */
function effectViolations(file: string, source: string): string[] {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const violations = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const match = DML_OR_DDL.exec(node.text);
      if (match) violations.add(`${file}: SQL "${match[0].toLowerCase().replace(/\s+/g, " ")}"`);
    } else if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.includes(node.text)) {
      violations.add(`${file}: ${node.text}`);
    } else if (ts.isPropertyAccessExpression(node)) {
      const owner = ts.isIdentifier(node.expression) ? node.expression.text : null;
      if (owner === "Promise" && node.name.text === "race") violations.add(`${file}: Promise.race`);
      if (node.name.text === "transaction" || node.name.text === "optionalAudit") violations.add(`${file}: .${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return [...violations].sort();
}

/** The names a module exports, from its syntax tree. */
function exportedNames(file: string, source: string): string[] {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const names: string[] = [];
  for (const statement of syntax.statements) {
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) {
      if (statement.name) names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }
  return names.sort();
}

// ── the real tree ────────────────────────────────────────────────────────────

let REAL_TREE: Map<string, string> | null = null;

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
      else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p)) tree.set(relative(ROOT, p), readFileSync(p, "utf8"));
    }
  };
  for (const dir of ["app", "lib", "scripts", "components"]) walk(join(ROOT, dir));
  for (const name of readdirSync(ROOT)) {
    const p = join(ROOT, name);
    if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name) && !name.startsWith(".") && statSync(p).isFile()) tree.set(name, readFileSync(p, "utf8"));
  }
  REAL_TREE = tree;
  return tree;
}

const stubs = (): [string, string][] => PACKET_MODULES.map((module): [string, string] => [module, ""]);

describe("the known-root requeue packet stays inside its boundary", () => {
  it("exists as two modules exporting the accepted interfaces", () => {
    const tree = readTree();
    for (const module of PACKET_MODULES) expect(tree.has(module), `${module} exists`).toBe(true);
    expect(tree.size, "the tree scan is not vacuous").toBeGreaterThan(500);
    expect(exportedNames(PAGE, tree.get(PAGE) ?? "")).toEqual(expect.arrayContaining([
      "readSlackKnownRootItemPage", "createSlackKnownRootExecution", "SlackKnownRootValidationError", "SlackKnownRootDeadlineError",
    ]));
    expect(exportedNames(REQUEUE, tree.get(REQUEUE) ?? "")).toEqual(expect.arrayContaining([
      "prepareSlackKnownRootRequeue", "classifySlackKnownRootPreparationFailure", "tallySlackKnownRootPage",
    ]));
  });

  it("owns only paths outside the pinned PR 743 inventory", () => {
    expect(new Set(PACKET_PATHS).size).toBe(PACKET_PATHS.length);
    expect(PR743_PINNED_PATHS, "the pinned inventory is loaded").toHaveLength(226);
    const pinned = new Set(PR743_PINNED_PATHS);
    expect(PACKET_PATHS.filter((path) => pinned.has(path))).toEqual([]);
    // Negative control: the files a careless "small shared fix" would touch ARE in that inventory.
    for (const owned of ["lib/db/types.ts", "lib/db/pg/tx.ts", "lib/ingest/index.ts", "postgres/schema.sql", "test/datamechanics/helpers.ts"]) {
      expect(pinned.has(owned), `${owned} is PR 743's`).toBe(true);
    }
    for (const path of PACKET_PATHS.filter((p) => !p.startsWith("docs/"))) expect(existsSync(join(ROOT, path)), `${path} exists`).toBe(true);
  });

  it("is imported by nothing in the application outside the packet", () => {
    expect(outsideImporters(readTree())).toEqual([]);
  });

  it("sees an outside import in every spelling, type-only included (negative control)", () => {
    const importer = "lib/ingest/slack-known-root-sweep.ts";
    const spellings: [string, string][] = [
      [`import { prepareSlackKnownRootRequeue } from "./slack-known-root-requeue";`, REQUEUE],
      [`import { readSlackKnownRootItemPage } from "@/lib/ingest/slack-known-root-page";`, PAGE],
      [`import type { SlackKnownRootEntry } from "./slack-known-root-page";`, PAGE],
      [`export { tallySlackKnownRootPage } from "./slack-known-root-requeue";`, REQUEUE],
      [`export * from "./slack-known-root-page";`, PAGE],
      [`const m = await import("./slack-known-root-requeue");`, REQUEUE],
      [`const m = require("@/lib/ingest/slack-known-root-requeue");`, REQUEUE],
      [`type P = typeof import("./slack-known-root-page");`, PAGE],
      [`import "./slack-known-root-requeue.js";`, REQUEUE],
      [`import {\n  classifySlackKnownRootPreparationFailure,\n} from\n  "./slack-known-root-requeue";`, REQUEUE],
    ];
    for (const [source, target] of spellings) {
      expect(outsideImporters(new Map([...stubs(), [importer, source]])), source).toEqual([`${importer} → ${target}`]);
    }
    // Not imports: a comment, a string that merely names the module, and the packet's own internal edge.
    const inert = new Map([
      ...stubs(),
      [REQUEUE, `import type { SlackKnownRootEntry } from "./slack-known-root-page";`],
      [importer, `// import { x } from "./slack-known-root-requeue";\nconst name = "./slack-known-root-page";\nimport { y } from "./slack-known-rooted";`],
      ["lib/ingest/slack-known-rooted.ts", ""],
    ]);
    expect(outsideImporters(inert)).toEqual([]);
  });

  it("imports only the dependencies the specification allows", () => {
    const tree = readTree();
    for (const dependency of Object.values(ALLOWED_DEPENDENCIES).flat()) expect(tree.has(dependency), `${dependency} exists`).toBe(true);
    for (const module of PACKET_MODULES) expect(dependencyViolations(tree, module), module).toEqual([]);
  });

  it("refuses a provider, pool, transaction, ingest or writer dependency, and any queue writer but enqueue (negative control)", () => {
    const base: [string, string][] = [
      [PAGE, ""],
      ...[
        "lib/db/types.ts", "lib/db/pg/tx.ts", "lib/db/pg/pool.ts", "lib/ingest/index.ts", "lib/ingest/slack-thread-state.ts",
        "lib/ingest/slack-namespace-gate.ts", "lib/ingest/slack-source-binding.ts", "lib/ingest/sources/slack-page-request.ts",
        "lib/ingest/slack-message-ledger.ts", "lib/ingest/slack-channel-state.ts", "lib/integrations/manage.ts",
        "lib/projects/context/transaction.ts",
      ].map((file): [string, string] => [file, ""]),
    ];
    const violationsOf = (source: string): string[] => dependencyViolations(new Map([...base, [REQUEUE, source]]), REQUEUE);

    // The intended shape is clean.
    expect(violationsOf([
      `import "server-only";`,
      `import type { TransactionSession } from "@/lib/db/types";`,
      `import { TransactionExecutionError } from "@/lib/db/pg/tx";`,
      `import { enqueueSlackThread, type SlackThreadScope } from "./slack-thread-state";`,
      `import type { SlackThreadClaim } from "./slack-thread-state";`,
      `import { lockReadySlackNamespaceGate } from "./slack-namespace-gate";`,
      `import { lockSlackSelection } from "./slack-source-binding";`,
      `import type { SlackKnownRootEntry } from "./slack-known-root-page";`,
    ].join("\n"))).toEqual([]);

    const refused: [string, string][] = [
      [`import { slackReservedRequest } from "./sources/slack-page-request";`, `${REQUEUE}: imports lib/ingest/sources/slack-page-request.ts`],
      [`import { getPool } from "@/lib/db/pg/pool";`, `${REQUEUE}: imports lib/db/pg/pool.ts`],
      [`import { transactionCapability } from "@/lib/projects/context/transaction";`, `${REQUEUE}: imports lib/projects/context/transaction.ts`],
      [`import { ingestItem } from "@/lib/ingest";`, `${REQUEUE}: imports lib/ingest/index.ts`],
      [`import { reconcileCompleteSlackThreadEvidence } from "./slack-message-ledger";`, `${REQUEUE}: imports lib/ingest/slack-message-ledger.ts`],
      [`const state = await import("./slack-channel-state");`, `${REQUEUE}: imports lib/ingest/slack-channel-state.ts`],
      [`const manage = require("@/lib/integrations/manage");`, `${REQUEUE}: imports lib/integrations/manage.ts`],
      [`import { Pool } from "pg";`, `${REQUEUE}: package pg`],
      [`import { request } from "node:https";`, `${REQUEUE}: package node:https`],
      [`import { x } from "./slack-known-root-missing";`, `${REQUEUE}: unresolved import ./slack-known-root-missing`],
      // The queue: enqueue is the only writer; a claim, a release or the whole namespace is not allowed.
      [`import { enqueueSlackThread, claimSlackThread } from "./slack-thread-state";`, `${REQUEUE}: imports claimSlackThread from lib/ingest/slack-thread-state.ts`],
      [`import * as threads from "./slack-thread-state";`, `${REQUEUE}: imports * from lib/ingest/slack-thread-state.ts`],
      [`export { releaseSlackThreadForRetry } from "./slack-thread-state";`, `${REQUEUE}: imports * from lib/ingest/slack-thread-state.ts`],
      // The transaction module: its error class only, never an opener.
      [`import { TransactionExecutionError, withTransaction } from "@/lib/db/pg/tx";`, `${REQUEUE}: imports withTransaction from lib/db/pg/tx.ts`],
    ];
    for (const [source, violation] of refused) expect(violationsOf(source), source).toEqual([violation]);
    // The page module has the narrower allowlist: it may not take the queue writer at all.
    expect(dependencyViolations(new Map([...base, [PAGE, `import { enqueueSlackThread } from "./slack-thread-state";`]]), PAGE)).toEqual([
      `${PAGE}: imports lib/ingest/slack-thread-state.ts`,
    ]);
  });

  it("carries no DML or DDL of its own, opens no transaction, races no statement and calls out to nothing", () => {
    const tree = readTree();
    for (const module of PACKET_MODULES) expect(effectViolations(module, tree.get(module) ?? ""), module).toEqual([]);
  });

  it("sees a direct write, a transaction, a race or a provider call in module code, and ignores comments (negative control)", () => {
    const of = (source: string): string[] => effectViolations(REQUEUE, source);
    // Reads, row locks and transaction-local timeout settings are what the packet is allowed.
    expect(of([
      "// This module never runs `insert into slack_sync_threads` itself, and never calls fetch().",
      "/* update items set … is the publisher's; delete from slack_sync_threads is the acknowledger's. */",
      "const LOCK = `select id from items where team_id = $1 and id = $2 for update`;",
      "const TIMEOUT = `select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`;",
      "const WITNESS = `select observed_at from slack_messages where team_id = $1 and deleted_at is null`;",
      "await session.executeSql(LOCK, [teamId, itemId]);",
    ].join("\n"))).toEqual([]);

    const refused: [string, string][] = [
      ["await session.executeSql(`insert into slack_sync_threads (team_id) values ($1)`, [teamId]);", `${REQUEUE}: SQL "insert into"`],
      ["const sql = 'update slack_sync_threads set due_at = now()';", `${REQUEUE}: SQL "update slack_sync_threads set"`],
      ["const sql = `delete from slack_sync_threads where team_id = ${'$'}1`;", `${REQUEUE}: SQL "delete from"`],
      ["const sql = `update items set member_id = null where id = $1`;", `${REQUEUE}: SQL "update items set"`],
      ["const sql = `create index concurrently on slack_messages (root_ts)`;", `${REQUEUE}: SQL "create index"`],
      ["const sql = `savepoint known_root`;", `${REQUEUE}: SQL "savepoint"`],
      ["await fetch(`https://slack.com/api/conversations.replies`);", `${REQUEUE}: fetch`],
      ["const client = await getPool().connect();", `${REQUEUE}: getPool`],
      ["await transactionCapability(db).transaction(async () => undefined);", `${REQUEUE}: .transaction`],
      ["await session.optionalAudit(async () => 1, 0);", `${REQUEUE}: .optionalAudit`],
      ["await Promise.race([statement, deadline]);", `${REQUEUE}: Promise.race`],
      ["const controller = new AbortController();", `${REQUEUE}: AbortController`],
    ];
    for (const [source, violation] of refused) expect(of(source), source).toContain(violation);
  });
});
