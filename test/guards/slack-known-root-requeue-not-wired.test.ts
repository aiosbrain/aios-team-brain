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
    // The LEGACY channel path prefix lives with the normalizer, not with the scoped namespace.
    "lib/ingest/sources/slack-normalize.ts",
    "lib/ingest/sources/slack-message-evidence.ts",
  ],
};

/** Bare package specifiers either module may name. */
const ALLOWED_PACKAGES: readonly string[] = ["server-only"];

/**
 * Dependencies of which only these VALUE names may be imported (type-only names are free). Each list
 * is exactly what the accepted specification names for that module; a namespace, default,
 * side-effect, dynamic or re-exporting import of any of them is refused outright.
 */
const NAMED_ONLY: Readonly<Record<string, readonly string[]>> = {
  // The sole production queue writer of this packet.
  "lib/ingest/slack-thread-state.ts": ["enqueueSlackThread"],
  // Never `runPgClientTransaction`, `withTransaction` or a session helper.
  "lib/db/pg/tx.ts": ["TransactionExecutionError"],
  // §5.1 step 1: the LOCKED readiness check. Never the invalidator, the blocked-gate writer or the
  // readiness producer — preparation observes a gate, it does not move one.
  "lib/ingest/slack-namespace-gate.ts": ["lockReadySlackNamespaceGate"],
  // §5.1 step 2: the selection lock, which also resolves the effective token locally. Never a
  // binder, an identity recorder, a blocker or a delay: preparation changes no binding.
  "lib/ingest/slack-source-binding.ts": ["lockSlackSelection"],
  // §5.3 and §5.4: the scoped path builder, and nothing that parses a path back into ids.
  "lib/ingest/sources/slack-namespace.ts": ["scopedSlackItemPath"],
  // §5.4: the legacy channel path prefix — exported by the normalizer, which is where it really
  // lives. Never the normalizer itself, its participant reader or anything else it exports.
  "lib/ingest/sources/slack-normalize.ts": ["slackChannelPathPrefix"],
  // §5.3 and §6: the existing exact timestamp parser.
  "lib/ingest/sources/slack-message-evidence.ts": ["parseSlackTimestamp"],
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

/**
 * Data and schema writes, wherever they appear in a string of SQL. `UPDATE` is matched in every
 * spelling that reaches a SET list — `update t set`, `update only t set`, `update t x set`,
 * `update t as x set` — and `CREATE` for every object kind that persists or runs code. Transaction
 * control is NOT here: those words are ordinary English, and are judged by statement below.
 */
const DML_OR_DDL = /\b(?:insert\s+into|delete\s+from|update\s+(?:only\s+)?[a-z_."]+(?:\s+(?:as\s+)?[a-z_"]+)?\s+set\b|merge\s+into|truncate\b|alter\s+table|drop\s+table|create\s+(?:or\s+replace\s+)?(?:table|index|unique|function|procedure|trigger|view|materialized|temp|temporary|unlogged)\b)/i;

/**
 * SQL text with its comments removed, so that neither a leading comment nor one placed between two
 * keywords can hide what a statement does. (A `--` inside a string constant is cut too; that can
 * only shorten what is examined after it, and never invents a violation.)
 */
function withoutSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** The only settings the packet may change, and only for the current transaction (§7.3). */
const TIMEOUT_SETTINGS: readonly string[] = ["statement_timeout", "lock_timeout"];

/**
 * The top-level arguments of a call whose opening parenthesis ends just before `from`, as source
 * text, or null when the call is not closed inside this string. Quotes and nested parentheses are
 * respected, so `coalesce($1, '0')` is one argument.
 */
function callArguments(text: string, from: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let position = from; position < text.length; position++) {
    const char = text[position];
    if (quoted) {
      current += char;
      if (char === "'") quoted = false;
    } else if (char === "'") {
      quoted = true;
      current += char;
    } else if (char === "(") {
      depth++;
      current += char;
    } else if (char === ")") {
      if (depth === 0) return [...args, current];
      depth--;
      current += char;
    } else if (char === "," && depth === 0) {
      args.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  return null;
}

/**
 * What one string of SQL does that the packet may not, beyond DML and DDL: change a setting for the
 * SESSION (or any setting but its two timeouts), take a table lock, or run a procedural block. The
 * transaction-local timeout forms — `set_config('statement_timeout' | 'lock_timeout', …, true)` and
 * `SET LOCAL` of those two — are the only setting changes allowed. A `set_config` whose arguments
 * cannot be read in full from the string is refused: what cannot be shown local is not assumed so.
 */
function sqlEffectViolations(text: string): string[] {
  const found: string[] = [];
  const call = /set_config\s*\(/gi;
  for (let match = call.exec(text); match !== null; match = call.exec(text)) {
    const args = callArguments(text, match.index + match[0].length);
    if (args === null) {
      found.push("unverifiable set_config");
      continue;
    }
    const setting = /^'([a-z_.]+)'$/i.exec((args[0] ?? "").trim())?.[1]?.toLowerCase();
    if (args.length !== 3 || setting === undefined || !TIMEOUT_SETTINGS.includes(setting)) found.push("set_config of another setting");
    else if (args[2].trim().toLowerCase() !== "true") found.push("session-level set_config");
  }
  for (const statement of text.split(";")) {
    const head = statement.trim().toLowerCase();
    if (/^set\s/.test(head)) {
      if (/^set\s+local\s/.test(head)) {
        if (!/^set\s+local\s+(?:statement_timeout|lock_timeout)\b/.test(head)) found.push("SET LOCAL of another setting");
      } else {
        found.push("session-level SET");
      }
    }
    if (/^reset\s/.test(head)) found.push("RESET");
    if (/^lock\s/.test(head)) found.push("LOCK");
    if (/^do(?:\s|\$)/.test(head)) found.push("DO block");
    // Transaction control, judged as a STATEMENT: the bare keyword, or the keyword followed by one
    // of the words SQL allows after it. "the commit outcome is unknown" and "begin again later" are
    // sentences, not statements, and are left alone.
    const control = /^(begin|commit|rollback|end|abort)(?:\s+(?:transaction|work|isolation|read|deferrable|not|and|to|prepared)\b[\s\S]*)?$/.exec(head);
    if (control) found.push(`"${control[1]}"`);
    if (/^start\s+transaction\b/.test(head)) found.push('"start transaction"');
    if (/^savepoint\s+[a-z_][a-z0-9_]*$/.test(head)) found.push('"savepoint"');
    if (/^release\s+(?:savepoint\s+)?[a-z_][a-z0-9_]*$/.test(head)) found.push('"release savepoint"');
    // A read that writes its result somewhere, a bulk transfer, and a procedure call.
    if (/^(?:select|with|table)\b[\s\S]*\binto\s+(?:temp\s+|temporary\s+|unlogged\s+|table\s+|strict\s+)*[a-z_."]+/.test(head)) found.push("SELECT INTO");
    if (/^copy\s+(?:\([\s\S]*\)|[a-z_."]+(?:\s*\([^)]*\))?)\s+(?:from|to)\b/.test(head)) found.push("COPY");
    if (/^call\s+[a-z_."]+\s*\(/.test(head)) found.push("CALL");
  }
  return found;
}

/** The one function of the packet that may hold the caller's own, undecorated session. */
const RAW_SESSION_OWNERS: readonly string[] = ["runSlackKnownRootOperation"];

/**
 * `file: function lets its raw session escape` for every exported function that does anything with
 * a `TransactionSession` parameter except hand it, as the first argument, to the decorator.
 *
 * The caller's session enters the packet only through an exported function, and it is the RAW one:
 * no deadline admission, no refreshed timeouts, a working `db` and `optionalAudit`. Everything else
 * in the packet — its helpers and every dependency — must be given the decorated session the
 * decorator builds. Structurally that means the raw parameter may appear in exactly one place. Using
 * it directly, aliasing it, closing over it, or passing it to a helper or a dependency is an escape.
 * A non-exported helper's own session parameter is the decorated one and is not examined here.
 */
function rawSessionEscapes(file: string, source: string): string[] {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const escapes = new Set<string>();
  const exportedFunctions: [string, ts.FunctionLikeDeclaration][] = [];
  for (const statement of syntax.statements) {
    const exported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) exportedFunctions.push([statement.name.text, statement]);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer;
        if (ts.isIdentifier(declaration.name) && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
          exportedFunctions.push([declaration.name.text, value]);
        }
      }
    }
  }
  for (const [name, declared] of exportedFunctions) {
    if (RAW_SESSION_OWNERS.includes(name) || !declared.body) continue;
    for (const parameter of declared.parameters) {
      if (!ts.isIdentifier(parameter.name) || !parameter.type || parameter.type.getText(syntax) !== "TransactionSession") continue;
      const raw = parameter.name.text;
      const visit = (node: ts.Node): void => {
        // A nested function that declares the same name has a session of its own.
        if (ts.isFunctionLike(node) && node.parameters.some((inner) => ts.isIdentifier(inner.name) && inner.name.text === raw)) return;
        if (ts.isIdentifier(node) && node.text === raw) {
          const parent = node.parent;
          const isName = (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node) ||
            (ts.isBindingElement(parent) && parent.propertyName === node);
          const handedToOwner = ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) &&
            RAW_SESSION_OWNERS.includes(parent.expression.text) && parent.arguments[0] === node;
          if (!isName && !handedToOwner && !ts.isVoidExpression(parent)) escapes.add(`${file}: ${name} lets its raw session escape`);
        }
        ts.forEachChild(node, visit);
      };
      visit(declared.body);
    }
  }
  return [...escapes].sort();
}

/**
 * True when the module's own top level carries the side-effect import `import "server-only"`. A
 * dynamic import, a `require`, a type import or a comment is not that statement: the marker has to be
 * the plain static import a client bundle fails on.
 */
function importsServerOnly(file: string, source: string): boolean {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  return syntax.statements.some((statement) =>
    ts.isImportDeclaration(statement) && statement.importClause === undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "server-only");
}

/** Identifiers that open a transaction, reach a pool, call out, or abandon a running statement. */
const FORBIDDEN_IDENTIFIERS: readonly string[] = [
  "fetch", "getPool", "runSql", "adminClient", "runContextTransaction", "transactionCapability",
  "runPgClientTransaction", "withTransaction", "AbortController", "AbortSignal", "XMLHttpRequest", "WebSocket",
];

/**
 * The capabilities of a session or client that reach past `executeSql`: the PostgREST-shaped builder
 * (`db`, and `rpc` on it), the savepoint helper, and a transaction opener. Every statement of this
 * packet goes through `executeSql`, where the DML check above can see its text; through any of these
 * four a write or a remote function call would be invisible to it.
 */
const SESSION_SURFACES: readonly string[] = ["db", "rpc", "optionalAudit", "transaction"];

/** True when the first statement of a member's body is `throw`: it does nothing else when used. */
function throwsFirst(body: ts.Node | undefined): boolean {
  return body !== undefined && ts.isBlock(body) && body.statements.length > 0 && ts.isThrowStatement(body.statements[0]);
}

/**
 * The ONE place a surface name may appear as an identifier: naming a member that fails closed —
 * `get db() { throw … }`, `optionalAudit() { throw … }`, `optionalAudit: () => { throw … }` — or a
 * member of a type. That is how the packet's decorated session refuses those capabilities. Reading
 * one, binding one, passing one on, or defining one that does anything but throw is a violation.
 */
function isFailClosedDefinition(name: ts.Identifier): boolean {
  const parent = name.parent;
  if (parent === undefined) return false;
  if ((ts.isGetAccessorDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === name) return throwsFirst(parent.body);
  if (ts.isPropertyAssignment(parent) && parent.name === name) {
    const value = parent.initializer;
    return (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) && throwsFirst(value.body);
  }
  return (ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) && parent.name === name;
}

/** What a module's own code does that the packet may not: read from the syntax tree, comments excluded. */
function effectViolations(file: string, source: string): string[] {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations = new Set<string>();
  const namesASession = (node: ts.Node): boolean => /session|client/i.test(node.getText(syntax));
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // Comments are removed first: one before a statement, or between two keywords, hides nothing.
      const sql = withoutSqlComments(node.text);
      const match = DML_OR_DDL.exec(sql);
      if (match) violations.add(`${file}: SQL "${match[0].toLowerCase().replace(/\s+/g, " ")}"`);
      for (const effect of sqlEffectViolations(sql)) violations.add(`${file}: SQL ${effect}`);
      // A surface named by a string — `session["db"]`, `Reflect.get(session, "rpc")`, a key held in a
      // variable — is the same access. A string in a TYPE position (`Pick<…, "db">`) reads nothing.
      if (SESSION_SURFACES.includes(node.text) && !ts.isLiteralTypeNode(node.parent)) violations.add(`${file}: "${node.text}" as a key`);
    } else if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.includes(node.text)) {
      violations.add(`${file}: ${node.text}`);
    } else if (ts.isIdentifier(node) && SESSION_SURFACES.includes(node.text)) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) violations.add(`${file}: .${node.text}`);
      else if (!isFailClosedDefinition(node)) violations.add(`${file}: ${node.text} outside a fail-closed definition`);
    } else if (ts.isPropertyAccessExpression(node)) {
      const owner = ts.isIdentifier(node.expression) ? node.expression.text : null;
      if (owner === "Promise" && node.name.text === "race") violations.add(`${file}: Promise.race`);
    } else if (ts.isElementAccessExpression(node)) {
      // A key that is not a literal cannot be shown to avoid a surface: on a session it is refused.
      const key = node.argumentExpression;
      const literalKey = ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) || ts.isNumericLiteral(key);
      if (!literalKey && namesASession(node.expression)) violations.add(`${file}: computed access on a session`);
    } else if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && namesASession(node.expression)) {
      // Spreading a session copies its builder and its savepoint helper into the copy.
      violations.add(`${file}: spread of a session`);
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

/**
 * `file: name` for every name a named-only allowlist permits that its dependency does not actually
 * export, and `file: missing` for a dependency that is not in the tree. An allowlist entry nothing
 * can satisfy is not a harmless extra: it describes an import the module cannot make, and hides
 * that the helper it meant lives somewhere the allowlist does not permit.
 */
function unsatisfiableAllowlistNames(tree: ReadonlyMap<string, string>, namedOnly: Readonly<Record<string, readonly string[]>>): string[] {
  const problems: string[] = [];
  for (const [file, names] of Object.entries(namedOnly)) {
    const source = tree.get(file);
    if (source === undefined) {
      problems.push(`${file}: missing`);
      continue;
    }
    const exported = new Set(exportedNames(file, source));
    for (const name of names) if (!exported.has(name)) problems.push(`${file}: ${name}`);
  }
  return problems.sort();
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
    for (const packetModule of PACKET_MODULES) expect(tree.has(packetModule), `${packetModule} exists`).toBe(true);
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
    for (const packetModule of PACKET_MODULES) expect(dependencyViolations(tree, packetModule), packetModule).toEqual([]);
  });

  it("permits by name only what each dependency really exports", () => {
    const tree = readTree();
    // Every named-only dependency is an allowed dependency of at least one packet module…
    const allowed = new Set(Object.values(ALLOWED_DEPENDENCIES).flat());
    for (const dependency of Object.keys(NAMED_ONLY)) expect(allowed.has(dependency), `${dependency} is an allowed dependency`).toBe(true);
    // …and every name its allowlist permits is an actual export of that file in the real tree. A
    // name the file does not export is an import the module could never make.
    expect(unsatisfiableAllowlistNames(tree, NAMED_ONLY)).toEqual([]);
    for (const names of Object.values(NAMED_ONLY)) expect(names.length, "no allowlist is empty").toBeGreaterThan(0);
    // Stated outright for the two path helpers, whose modules were once confused.
    expect(exportedNames("lib/ingest/sources/slack-namespace.ts", tree.get("lib/ingest/sources/slack-namespace.ts") ?? "")).toContain("scopedSlackItemPath");
    expect(exportedNames("lib/ingest/sources/slack-namespace.ts", tree.get("lib/ingest/sources/slack-namespace.ts") ?? "")).not.toContain("slackChannelPathPrefix");
    expect(exportedNames("lib/ingest/sources/slack-normalize.ts", tree.get("lib/ingest/sources/slack-normalize.ts") ?? "")).toContain("slackChannelPathPrefix");
  });

  it("reports an allowlist name its dependency does not export, and a dependency that does not exist (negative control)", () => {
    const tree = new Map<string, string>([
      ["lib/a.ts", "export function real(): void {}\nexport const ALSO_REAL = 1;\nfunction internal(): void {}\nexport class RealClass {}"],
      ["lib/b.ts", "export async function onlyThis(): Promise<void> {}"],
    ]);
    // Satisfiable: every permitted name is exported by its file.
    expect(unsatisfiableAllowlistNames(tree, { "lib/a.ts": ["real", "ALSO_REAL", "RealClass"], "lib/b.ts": ["onlyThis"] })).toEqual([]);
    // The recurrence this exists to stop: a name permitted from the wrong module.
    expect(unsatisfiableAllowlistNames(tree, { "lib/a.ts": ["real", "onlyThis"], "lib/b.ts": ["onlyThis"] })).toEqual(["lib/a.ts: onlyThis"]);
    // A declared-but-unexported name, a misspelling, and a file that is not there.
    expect(unsatisfiableAllowlistNames(tree, { "lib/a.ts": ["internal", "Real"], "lib/c.ts": ["anything"] })).toEqual([
      "lib/a.ts: Real", "lib/a.ts: internal", "lib/c.ts: missing",
    ]);
  });

  it("refuses a provider, pool, transaction, ingest or writer dependency, and any queue writer but enqueue (negative control)", () => {
    const base: [string, string][] = [
      [PAGE, ""],
      ...[
        "lib/db/types.ts", "lib/db/pg/tx.ts", "lib/db/pg/pool.ts", "lib/ingest/index.ts", "lib/ingest/slack-thread-state.ts",
        "lib/ingest/slack-namespace-gate.ts", "lib/ingest/slack-source-binding.ts", "lib/ingest/sources/slack-page-request.ts",
        "lib/ingest/slack-message-ledger.ts", "lib/ingest/slack-channel-state.ts", "lib/integrations/manage.ts",
        "lib/projects/context/transaction.ts", "lib/ingest/sources/slack-namespace.ts", "lib/ingest/sources/slack-normalize.ts",
        "lib/ingest/sources/slack-message-evidence.ts",
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
      // Types of the gate and the binding are free; the two path builders and the exact parser are
      // named, each from the module that really exports it.
      `import type { SlackNamespaceReadyLockResult } from "./slack-namespace-gate";`,
      `import { lockSlackSelection as lockSelection, type SlackSelection } from "./slack-source-binding";`,
      `import { scopedSlackItemPath } from "./sources/slack-namespace";`,
      `import { slackChannelPathPrefix } from "./sources/slack-normalize";`,
      `import { parseSlackTimestamp } from "./sources/slack-message-evidence";`,
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

    // The namespace gate and the source binding: the locked read each offers, and no writer of either.
    const GATE = "lib/ingest/slack-namespace-gate.ts";
    const BINDING = "lib/ingest/slack-source-binding.ts";
    const writers: [string, string, string][] = [
      ["./slack-namespace-gate", "invalidateSlackNamespaceGate", GATE],
      ["./slack-namespace-gate", "ensureBlockedSlackNamespaceGate", GATE],
      ["./slack-namespace-gate", "prepareNewSlackChannelNamespace", GATE],
      ["./slack-source-binding", "blockSlackBinding", BINDING],
      ["./slack-source-binding", "bindSlackSelection", BINDING],
      ["./slack-source-binding", "recordSlackWorkspaceIdentity", BINDING],
      ["./slack-source-binding", "recordSlackAppIdentity", BINDING],
      ["./slack-source-binding", "delaySlackBinding", BINDING],
    ];
    for (const [specifier, name, file] of writers) {
      const expected = [`${REQUEUE}: imports ${name} from ${file}`];
      // Alone, beside the permitted lock, and renamed on the way in: the exported name is what counts.
      expect(violationsOf(`import { ${name} } from "${specifier}";`), name).toEqual(expected);
      const permitted = file === GATE ? "lockReadySlackNamespaceGate" : "lockSlackSelection";
      expect(violationsOf(`import { ${permitted}, ${name} } from "${specifier}";`), name).toEqual(expected);
      expect(violationsOf(`import { ${name} as harmless } from "${specifier}";`), name).toEqual(expected);
    }
    const wholesale: [string, string][] = [
      [`import * as gate from "./slack-namespace-gate";`, `${REQUEUE}: imports * from ${GATE}`],
      [`const gate = await import("./slack-namespace-gate");`, `${REQUEUE}: imports * from ${GATE}`],
      [`export * from "./slack-source-binding";`, `${REQUEUE}: imports * from ${BINDING}`],
      [`const binding = require("@/lib/ingest/slack-source-binding");`, `${REQUEUE}: imports * from ${BINDING}`],
      [`import "./slack-source-binding";`, `${REQUEUE}: imports * from ${BINDING}`],
      // Not a writer, and still not named by the specification: an unlisted helper is refused too.
      [`import { readSlackBinding } from "./slack-source-binding";`, `${REQUEUE}: imports readSlackBinding from ${BINDING}`],
      [`import { slackTokenFingerprint } from "./slack-source-binding";`, `${REQUEUE}: imports slackTokenFingerprint from ${BINDING}`],
      // The path module's builders only — nothing that turns a path back into provider ids.
      [`import { scopedSlackItemPath, parseScopedSlackItemPath } from "./sources/slack-namespace";`, `${REQUEUE}: imports parseScopedSlackItemPath from lib/ingest/sources/slack-namespace.ts`],
      [`import { projectSlackMessageEvidence } from "./sources/slack-message-evidence";`, `${REQUEUE}: imports projectSlackMessageEvidence from lib/ingest/sources/slack-message-evidence.ts`],
    ];
    for (const [source, violation] of wholesale) expect(violationsOf(source), source).toEqual([violation]);

    // The path helpers, each from the module that really exports it and nothing else from either.
    const NAMESPACE = "lib/ingest/sources/slack-namespace.ts";
    const NORMALIZE = "lib/ingest/sources/slack-normalize.ts";
    const pathHelpers: [string, string][] = [
      // The normalizer is allowed for ONE name. Its own entry point, its participant reader and its
      // constant are not that name — alone, beside the permitted prefix, renamed, or wholesale.
      [`import { normalizeThread } from "./sources/slack-normalize";`, `${REQUEUE}: imports normalizeThread from ${NORMALIZE}`],
      [`import { slackChannelPathPrefix, normalizeThread } from "./sources/slack-normalize";`, `${REQUEUE}: imports normalizeThread from ${NORMALIZE}`],
      [`import { normalizeThread as prefix } from "./sources/slack-normalize";`, `${REQUEUE}: imports normalizeThread from ${NORMALIZE}`],
      [`import { threadParticipants } from "./sources/slack-normalize";`, `${REQUEUE}: imports threadParticipants from ${NORMALIZE}`],
      [`import { REDACTED_MESSAGE } from "./sources/slack-normalize";`, `${REQUEUE}: imports REDACTED_MESSAGE from ${NORMALIZE}`],
      [`import * as normalize from "./sources/slack-normalize";`, `${REQUEUE}: imports * from ${NORMALIZE}`],
      [`const normalize = await import("./sources/slack-normalize");`, `${REQUEUE}: imports * from ${NORMALIZE}`],
      // The legacy prefix is NOT a namespace export: asking the namespace module for it is refused,
      // as are that module's parser and its scoped channel prefix.
      [`import { slackChannelPathPrefix } from "./sources/slack-namespace";`, `${REQUEUE}: imports slackChannelPathPrefix from ${NAMESPACE}`],
      [`import { scopedSlackItemPath, parseSlackItemPath } from "./sources/slack-namespace";`, `${REQUEUE}: imports parseSlackItemPath from ${NAMESPACE}`],
      [`import { scopedSlackChannelPathPrefix } from "./sources/slack-namespace";`, `${REQUEUE}: imports scopedSlackChannelPathPrefix from ${NAMESPACE}`],
      // …and the scoped builder is not a normalizer export.
      [`import { scopedSlackItemPath } from "./sources/slack-normalize";`, `${REQUEUE}: imports scopedSlackItemPath from ${NORMALIZE}`],
    ];
    for (const [source, violation] of pathHelpers) expect(violationsOf(source), source).toEqual([violation]);
    // The page module may not take the normalizer at all.
    expect(dependencyViolations(new Map([...base, [PAGE, `import { slackChannelPathPrefix } from "./sources/slack-normalize";`]]), PAGE)).toEqual([
      `${PAGE}: imports ${NORMALIZE}`,
    ]);
    // The page module has the narrower allowlist: it may not take the queue writer at all.
    expect(dependencyViolations(new Map([...base, [PAGE, `import { enqueueSlackThread } from "./slack-thread-state";`]]), PAGE)).toEqual([
      `${PAGE}: imports lib/ingest/slack-thread-state.ts`,
    ]);
  });

  it("carries no DML or DDL of its own, opens no transaction, races no statement and calls out to nothing", () => {
    const tree = readTree();
    for (const packetModule of PACKET_MODULES) expect(effectViolations(packetModule, tree.get(packetModule) ?? ""), packetModule).toEqual([]);
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

  // RED at the source-reviewed checkpoint: neither module carries the import yet. Both read a
  // decrypted token's fingerprint or hold a transaction session; neither may reach a client bundle.
  // One case per module, so each is reported on its own and neither hides the other.
  it.each(PACKET_MODULES)("marks %s server-only with an explicit top-level import", (packetModule) => {
    const source = readTree().get(packetModule);
    expect(source, `${packetModule} exists`).toBeDefined();
    expect(importsServerOnly(packetModule, source ?? ""), `${packetModule} imports "server-only"`).toBe(true);
  });

  it("accepts only the plain static side-effect import as the server-only marker (negative control)", () => {
    const marked = (source: string): boolean => importsServerOnly(PAGE, source);
    expect(marked(`import "server-only";\nimport type { TransactionSession } from "@/lib/db/types";`)).toBe(true);
    expect(marked(`import type { TransactionSession } from "@/lib/db/types";\nimport 'server-only';\nexport const x = 1;`)).toBe(true);
    const unmarked: string[] = [
      ``,
      `import type { TransactionSession } from "@/lib/db/types";\nexport const x = 1;`,
      `// import "server-only";\nexport const x = 1;`,
      `/* import "server-only"; */\nexport const x = 1;`,
      `const marker = 'import "server-only";';`,
      `await import("server-only");`,
      `require("server-only");`,
      `import serverOnly from "server-only";`,
      `import * as marker from "server-only";`,
      `import type {} from "server-only";`,
      `import "server-only-ish";`,
      `import "client-only";`,
      `function load(): void { import("server-only"); }`,
      `export * from "server-only";`,
    ];
    for (const source of unmarked) expect(marked(source), source).toBe(false);
    // The marker is an allowed package of both modules: requiring it cannot trip the dependency check.
    expect(ALLOWED_PACKAGES).toContain("server-only");
    expect(dependencyViolations(new Map([[PAGE, `import "server-only";`]]), PAGE)).toEqual([]);
  });

  it("refuses a session-level setting, any setting but the two timeouts, a table lock and a procedural block in module SQL (negative control)", () => {
    const of = (source: string): string[] => effectViolations(REQUEUE, source);
    const sql = (text: string): string => `const statement = ${JSON.stringify(text)};`;

    // What the packet is allowed: both timeouts, for the current transaction only, in either
    // spelling; row locks; and the existing enqueue helper as its one writer.
    expect(of([
      "const APPLY = `select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`;",
      "const NESTED = `select set_config('lock_timeout', coalesce($1, '250'), true)`;",
      "const LOCAL = `set local statement_timeout = 500`;",
      "const LOCAL_LOCK = `SET LOCAL lock_timeout TO '250ms'`;",
      "const ROW_LOCK = `select id from items where team_id = $1 and id = $2 for update`;",
      "const READ = `select name, setting from pg_settings where name in ('statement_timeout', 'lock_timeout')`;",
      "const WORDS = ['lock_timeout', 'deadlock', 'statement_timeout', 'not_due'];",
      "await decorated.executeSql(APPLY, [String(statementMs), String(lockMs)]);",
      "const enqueued = await enqueueSlackThread(decorated, { teamId, workspaceId, channelId, rootTs }, { dueAt });",
    ].join("\n"))).toEqual([]);

    const refused: [string, string][] = [
      // A setting that outlives the transaction stays on a POOLED connection for whoever is next.
      ["select set_config('statement_timeout', $1, false)", "session-level set_config"],
      ["select set_config('lock_timeout', '250', FALSE)", "session-level set_config"],
      ["select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, false)", "session-level set_config"],
      ["select set_config('statement_timeout', $1, $3)", "session-level set_config"],
      ["select set_config('statement_timeout', $1)", "set_config of another setting"],
      ["select set_config('search_path', $1, true)", "set_config of another setting"],
      ["select set_config('role', 'postgres', true)", "set_config of another setting"],
      ["select set_config($1, $2, true)", "set_config of another setting"],
      ["select set_config('statement_timeout', $1, true", "unverifiable set_config"],
      ["set statement_timeout = 0", "session-level SET"],
      ["SET lock_timeout TO '5s'", "session-level SET"],
      ["set session statement_timeout = 0", "session-level SET"],
      ["  \n  set search_path to public", "session-level SET"],
      ["select 1; set statement_timeout = 0", "session-level SET"],
      ["set transaction isolation level serializable", "session-level SET"],
      ["set local search_path to public", "SET LOCAL of another setting"],
      ["set local role postgres", "SET LOCAL of another setting"],
      ["reset statement_timeout", "RESET"],
      // A table lock is neither a row lock nor one of the authority locks the specification names.
      ["lock table slack_sync_threads in access exclusive mode", "LOCK"],
      ["LOCK TABLE items IN SHARE MODE", "LOCK"],
      ["select 1; lock slack_messages", "LOCK"],
      // A procedural block hides whatever it does from every check above.
      ["do $$ begin perform pg_sleep(1); end $$", "DO block"],
      ["DO $body$ declare n int; begin n := 1; end $body$", "DO block"],
      ["select 1;\n do language plpgsql $$ begin null; end $$", "DO block"],
    ];
    for (const [text, effect] of refused) expect(of(sql(text)), text).toContain(`${REQUEUE}: SQL ${effect}`);
    // The same statements split across a template's pieces are still read piece by piece.
    expect(of("const statement = `select set_config('statement_timeout', ${value}, false)`;"))
      .toContain(`${REQUEUE}: SQL unverifiable set_config`);
    expect(of("const statement = `${prefix}; lock table items`;")).toContain(`${REQUEUE}: SQL LOCK`);
    // Not SQL effects: an upsert's `do nothing`, a timeout NAME, and words that merely contain one.
    expect(of(sql("insert into t (a) values ($1) on conflict do nothing"))).toEqual([`${REQUEUE}: SQL "insert into"`]);
    expect(of(sql("select 'set statement_timeout' as words, lock_timeout from pg_settings"))).toEqual([]);
  });

  it("sees a write, a procedure, a bulk transfer or transaction control behind a comment or an unusual spelling, and leaves ordinary sentences alone (negative control)", () => {
    const of = (source: string): string[] => effectViolations(REQUEUE, source);
    const sql = (text: string): string => `const statement = ${JSON.stringify(text)};`;

    const refused: [string, string][] = [
      // UPDATE in every spelling that reaches a SET list.
      ["update only items set member_id = null where id = $1", `SQL "update only items set"`],
      ["update slack_sync_threads t set due_at = now() where t.team_id = $1", `SQL "update slack_sync_threads t set"`],
      ["update slack_sync_threads as t set attempts = 0", `SQL "update slack_sync_threads as t set"`],
      ["UPDATE ONLY public.items AS i SET path = $2", `SQL "update only public.items as i set"`],
      ["with moved as (update items i set path = $2 where id = $1 returning id) select id from moved", `SQL "update items i set"`],
      // A comment before the statement, or between its keywords, hides nothing.
      ["-- restore the queue\nupdate slack_sync_threads set due_at = now()", `SQL "update slack_sync_threads set"`],
      ["/* housekeeping */ delete from slack_sync_threads where team_id = $1", `SQL "delete from"`],
      ["update /* quietly */ items -- really\n set kind = 'x'", `SQL "update items set"`],
      ["insert /* x */ into slack_sync_threads (team_id) values ($1)", `SQL "insert into"`],
      ["-- note; still one statement\n  set statement_timeout = 0", "SQL session-level SET"],
      ["/* a */ -- b\n /* c */ lock table items", "SQL LOCK"],
      ["  -- first\n  do $$ begin null; end $$", "SQL DO block"],
      ["/* tx */ commit", `SQL "commit"`],
      // A read that writes its result, a bulk transfer, a procedure call, and code that persists.
      ["select id into temp table found from items where team_id = $1", "SQL SELECT INTO"],
      ["select * into backup_threads from slack_sync_threads", "SQL SELECT INTO"],
      ["with x as (select 1 as n) select n into unlogged y from x", "SQL SELECT INTO"],
      ["copy slack_sync_threads to stdout", "SQL COPY"],
      ["copy items (id, path) from stdin", "SQL COPY"],
      ["copy (select id from items) to program 'cat'", "SQL COPY"],
      ["call requeue_known_roots($1)", "SQL CALL"],
      ["CALL public.sweep()", "SQL CALL"],
      ["create function requeue() returns void language sql as 'select 1'", `SQL "create function"`],
      ["create or replace function requeue() returns void language sql as 'select 1'", `SQL "create or replace function"`],
      ["create procedure sweep() language sql as 'select 1'", `SQL "create procedure"`],
      ["create temp table found as select 1", `SQL "create temp"`],
      // Transaction control, as a statement.
      ["begin", `SQL "begin"`],
      ["BEGIN ISOLATION LEVEL SERIALIZABLE", `SQL "begin"`],
      ["select 1; commit", `SQL "commit"`],
      ["rollback to savepoint known_root", `SQL "rollback"`],
      ["commit and chain", `SQL "commit"`],
      ["end transaction", `SQL "end"`],
      ["start transaction read only", `SQL "start transaction"`],
      ["release savepoint known_root", `SQL "release savepoint"`],
    ];
    for (const [text, violation] of refused) expect(of(sql(text)), text).toContain(`${REQUEUE}: ${violation}`);

    // The same words in ordinary strings that are not statements: error text, category names, and
    // the read and lock forms the packet is allowed.
    const untouched: string[] = [
      "the commit outcome is unknown",
      "slack known-root: nothing was committed before the rollback",
      "begin again on a later sweep",
      "end of the key range",
      "a call to the provider is never made here",
      "copy the entry before the first await",
      "an update is never issued; the helper sets nothing but a pending row",
      "commit_unknown",
      "select the settings to restore",
      "select id::text as id from items where team_id = $1::uuid order by id limit $2",
      "select 1 as pending from slack_sync_threads where team_id = $1 limit 1",
      "select i.kind from items i where i.id = $1 for update",
      "select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
      "set local lock_timeout = '250ms'",
      "-- the scoped channel row, locked\nselect public_state from slack_sync_channels where team_id = $1 for update",
    ];
    for (const text of untouched) expect(of(sql(text)), text).toEqual([]);
    // …and the packet's one write stays the existing helper, called on the decorated session.
    expect(of("const enqueued = await enqueueSlackThread(decorated, { teamId, workspaceId, channelId, rootTs }, { dueAt });")).toEqual([]);
  });

  it("lets the caller's raw session reach nothing but the decorator", () => {
    const tree = readTree();
    for (const packetModule of PACKET_MODULES) expect(rawSessionEscapes(packetModule, tree.get(packetModule) ?? ""), packetModule).toEqual([]);
    // Non-vacuity over the real tree: both exported primitives do take a raw session, and the
    // decorator that owns it is where the real tree says it is.
    for (const [packetModule, primitive] of [[PAGE, "readSlackKnownRootItemPage"], [REQUEUE, "prepareSlackKnownRootRequeue"]] as const) {
      expect(tree.get(packetModule) ?? "").toMatch(new RegExp(`export async function ${primitive}\\(\\s*session: TransactionSession`));
    }
    expect(exportedNames(PAGE, tree.get(PAGE) ?? "")).toContain("runSlackKnownRootOperation");
  });

  it("sees a raw session used directly, aliased, closed over, or handed to a helper or a dependency (negative control)", () => {
    const escapesOf = (body: string): string[] => rawSessionEscapes(REQUEUE, [
      "export async function prepareSlackKnownRootRequeue(session: TransactionSession, input: Input, execution: Execution): Promise<Result> {",
      body,
      "}",
      "async function prepareLocated(decorated: TransactionSession, entry: Entry): Promise<Result> {",
      "  const gate = await lockReadySlackNamespaceGate(decorated, entry);",
      "  await decorated.executeSql(QUEUE_SQL, []);",
      "  return enqueueSlackThread(decorated, entry.scope, {});",
      "}",
    ].join("\n"));
    const escape = [`${REQUEUE}: prepareSlackKnownRootRequeue lets its raw session escape`];

    // The intended shape: the raw session goes to the decorator and nowhere else; the helper and the
    // dependencies are handed the DECORATED one, which this check does not restrict.
    expect(escapesOf("  return runSlackKnownRootOperation(session, execution, (decorated) => prepareLocated(decorated, entry));")).toEqual([]);
    expect(escapesOf("  void session;\n  return runSlackKnownRootOperation<Result>(session, execution, async (decorated) => prepareLocated(decorated, entry));")).toEqual([]);
    // A nested function that declares the same name has its own session.
    expect(escapesOf("  return runSlackKnownRootOperation(session, execution, (session) => prepareLocated(session, entry));")).toEqual([]);

    const escaping: string[] = [
      "  return enqueueSlackThread(session, entry.scope, {});",
      "  const selected = await lockSlackSelection(session, { teamId, integrationId });",
      "  const gate = await lockReadySlackNamespaceGate(session, entry);",
      "  return prepareLocated(session, entry);",
      "  await session.executeSql(QUEUE_SQL, []);",
      "  const raw = session;\n  return runSlackKnownRootOperation(raw, execution, work);",
      "  const { executeSql } = session;",
      "  return runSlackKnownRootOperation(session, execution, (decorated) => prepareLocated(session, entry));",
      "  return runSlackKnownRootOperation(session, execution, () => helper({ session }));",
      "  return runSlackKnownRootOperation(wrapped, execution, work, session);",
      "  return someOtherRunner(session, execution, work);",
      "  return runSlackKnownRootOperation(decorate(session), execution, work);",
    ];
    for (const body of escaping) expect(escapesOf(body), body).toEqual(escape);

    // An exported arrow function is an entry point as well; the decorator itself is the one owner.
    expect(rawSessionEscapes(REQUEUE, "export const prepare = async (session: TransactionSession): Promise<void> => { await session.executeSql('select 1'); };"))
      .toEqual([`${REQUEUE}: prepare lets its raw session escape`]);
    expect(rawSessionEscapes(PAGE, [
      "export async function runSlackKnownRootOperation<T>(session: TransactionSession, execution: Execution, operation: Operation<T>): Promise<T> {",
      "  const original = originalExecutor(session);",
      "  return operation(decorate(original));",
      "}",
    ].join("\n"))).toEqual([]);
  });

  it("refuses every way past executeSql — the builder, rpc, the savepoint helper and a transaction — by property, key or destructuring (negative control)", () => {
    const of = (source: string): string[] => effectViolations(REQUEUE, source);
    const outside = (name: string): string => `${REQUEUE}: ${name} outside a fail-closed definition`;

    // The intended decorated session is clean: `db` and `optionalAudit` are DEFINED, and each only throws.
    expect(of([
      "const decorated: TransactionSession = {",
      "  get db(): never { throw new SlackKnownRootSessionError(); },",
      "  executeSql,",
      "  async optionalAudit<T>(): Promise<T> { throw new SlackKnownRootSessionError(); },",
      "};",
      "const alsoClosed = { optionalAudit: () => { throw new SlackKnownRootSessionError(); }, db: function () { throw new SlackKnownRootSessionError(); } };",
      "type OnlyExecute = Omit<TransactionSession, \"db\" | \"optionalAudit\">;",
      "interface Refusing { db: never; optionalAudit(): never }",
      "const rows = result.rows[0];",
      "const copy = { ...cursor };",
    ].join("\n"))).toEqual([]);

    // Each prohibited surface, by each access form. None of these is vacuous: every row names the
    // exact violation, and the clean sample above shows the same checker returning nothing.
    const refused: [string, string][] = [
      // Property access — direct, and builder-mediated DML and RPC behind it.
      ["await session.db.from(\"slack_sync_threads\").insert({ team_id: teamId });", `${REQUEUE}: .db`],
      ["await session.db.from(\"items\").update({ member_id: null }).eq(\"id\", itemId);", `${REQUEUE}: .db`],
      ["await session.db.rpc(\"bump_slack_generation\", { team: teamId });", `${REQUEUE}: .rpc`],
      ["await client.rpc(\"bump_slack_generation\");", `${REQUEUE}: .rpc`],
      ["await session.optionalAudit(() => write(), null);", `${REQUEUE}: .optionalAudit`],
      ["await capability.transaction(async (inner) => inner.executeSql(text));", `${REQUEUE}: .transaction`],
      ["const builder = session?.db;", `${REQUEUE}: .db`],
      // Element access and any other string key.
      ["await session[\"db\"].from(\"items\").delete();", `${REQUEUE}: "db" as a key`],
      ["await session['rpc'](\"bump\");", `${REQUEUE}: "rpc" as a key`],
      ["await session[`optionalAudit`](() => write(), null);", `${REQUEUE}: "optionalAudit" as a key`],
      ["await capability[\"transaction\"](run);", `${REQUEUE}: "transaction" as a key`],
      ["const builder = Reflect.get(session, \"db\");", `${REQUEUE}: "db" as a key`],
      ["const key = \"rpc\"; await client[key](\"bump\");", `${REQUEUE}: "rpc" as a key`],
      ["await session[surface].from(\"items\");", `${REQUEUE}: computed access on a session`],
      // Destructuring, in a declaration, a parameter and an assignment, renamed or not.
      ["const { db } = session;", outside("db")],
      ["const { db: builder } = session;", outside("db")],
      ["const { rpc } = client;", outside("rpc")],
      ["function run({ optionalAudit }: TransactionSession): void { void optionalAudit; }", outside("optionalAudit")],
      ["const { transaction } = capability;", outside("transaction")],
      ["({ db: builder } = session);", outside("db")],
      ["({ transaction } = capability);", outside("transaction")],
      // Handing one on, or copying a whole session.
      ["const passthrough = { db: session.db, executeSql };", `${REQUEUE}: .db`],
      ["const passthrough = { db: inner, executeSql };", outside("db")],
      ["const passthrough = { db, executeSql };", outside("db")],
      ["const copied = { ...session, executeSql: decorated };", `${REQUEUE}: spread of a session`],
      ["function helper(db: DbClient): void { void db; }", outside("db")],
      // A definition that does anything but throw is not fail-closed.
      ["const open = { get db() { return inner.db; }, executeSql };", outside("db")],
      ["const open = { optionalAudit(operation) { return operation(); } };", outside("optionalAudit")],
      ["const open = { optionalAudit: (operation) => operation() };", outside("optionalAudit")],
      ["const open = { get db() { log(); throw new Error(); } };", outside("db")],
    ];
    for (const [source, violation] of refused) expect(of(source), source).toContain(violation);
    // Every one of the four surfaces was refused in every one of the three access forms.
    for (const surface of ["db", "rpc", "optionalAudit", "transaction"]) {
      const violations = refused.filter(([source]) => source.includes(surface)).flatMap(([source]) => of(source));
      expect(violations, `${surface} by property`).toContain(`${REQUEUE}: .${surface}`);
      expect(violations, `${surface} by key`).toContain(`${REQUEUE}: "${surface}" as a key`);
      expect(violations, `${surface} by destructuring`).toContain(outside(surface));
    }
  });
});
