import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

/**
 * AIO-1208 (docs/design/aio1208-route-auth-inventory.md) — the App Router route-file
 * authentication inventory. Development-only: this is a build-failing CHECK, never a runtime
 * authorization layer. It parses route source with the TypeScript compiler API; it never executes it.
 *
 * ## What the build enforces — exactly this and no more
 *
 *   Every explicitly exported HTTP method handler in every `route.ts` under `app/` has a classification
 *   row keyed by `(path, method)`. A PROTECTED row pins the exact SET of registered guard entry
 *   points the handler genuinely INVOKES (a call expression, in its executed body or in a local
 *   function it explicitly calls). A PUBLIC row is a method-specific documented protocol exception.
 *
 * A guard is identified by MODULE EXPORT IDENTITY, not spelling: the callee must resolve lexically
 * to a named import (or the destructured `await import(...)`) of the registered owner module. A
 * same-spelled local, a shadowing parameter, an import that is never called, a comment, a string,
 * a type reference, and a nested function that is merely defined all count for nothing.
 *
 * ## The bound (do not read more into a green run than this)
 *
 * This pins WHICH registered entry points a handler calls. It does not prove that every branch is
 * dominated by the guard, that the guard's verdict is honoured, or that a registered owner cannot
 * become permissive — the runtime denial tests named in each registration's `evidence` carry that.
 * Only syntactically obvious dead code is rejected (`if (false) …`, a statement after an
 * unconditional `return`/`throw`); arbitrary path feasibility is out of scope. The seven
 * `getSessionUser` routes' inline active-same-team membership predicate is NOT proven here.
 * Pages, framework metadata endpoints and Server Actions are not route-file handlers and are not
 * scanned.
 */

export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
const HTTP_METHOD_NAMES: ReadonlySet<string> = new Set(HTTP_METHODS);
const isHttpMethod = (name: string): name is HttpMethod => HTTP_METHOD_NAMES.has(name);

/** Next's default `pageExtensions` (installed docs: api-reference/config/next-config-js/pageExtensions). */
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx)$/;
const NEXT_CONFIG_FILES = ["next.config.ts", "next.config.mts", "next.config.js", "next.config.mjs", "next.config.cjs"];
const TREE_ROOTS = ["app", "pages", "src"];

// ---------------------------------------------------------------------------------------------
// Policy shapes
// ---------------------------------------------------------------------------------------------

export interface GuardRegistration {
  /** Owner module, repo-relative without extension — the identity half a spelling cannot fake. */
  module: string;
  exportName: string;
  /** For `owner.member(...)` entries such as `governedActionHttp.status`. */
  member?: string;
  /** An authorization predicate that never authenticates by itself (must be co-invoked). */
  coGuardOnly?: boolean;
  /** The authority chain a reviewer should read. */
  owner: string;
  /** Why this entry point is trusted as a guard. */
  reason: string;
  /** Tests that execute the owner and assert a real denial. Paths must exist. */
  evidence: readonly string[];
}

export interface ProtectedRoute {
  path: string;
  method: HttpMethod;
  /** The EXACT set of registered guard names the handler must invoke. */
  guards: readonly string[];
}

export interface PublicException {
  path: string;
  method: HttpMethod;
  reason: string;
  /** The credential/protocol boundary that stands in for a session or key. */
  protocol: string;
  evidence: readonly string[];
}

export interface RouteAuthPolicy {
  guards: Readonly<Record<string, GuardRegistration>>;
  protectedRoutes: readonly ProtectedRoute[];
  publicExceptions: readonly PublicException[];
}

/** The slice of the repository the checker reads. Mutation tests supply an in-memory copy. */
export interface RepoView {
  /** Route sources keyed by repo-relative posix path. */
  routeSources: ReadonlyMap<string, string>;
  exists(path: string): boolean;
  read(path: string): string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

export interface RoutingTree {
  /** Repo-relative posix file paths under app/, pages/ and src/. */
  files: readonly string[];
  directories: readonly string[];
  nextConfigs: ReadonlyMap<string, string>;
}

/** Walk the real filesystem (so untracked source is included) — reads only. */
export function readRoutingTree(root: string = REPO_ROOT): RoutingTree {
  const files: string[] = [];
  const directories: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      if (name === "node_modules" || name === ".next") continue;
      const child = `${rel}/${name}`;
      if (statSync(join(root, child)).isDirectory()) {
        directories.push(child);
        walk(child);
      } else files.push(child);
    }
  };
  for (const top of TREE_ROOTS) {
    const abs = join(root, top);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    directories.push(top);
    walk(top);
  }
  const nextConfigs = new Map<string, string>();
  for (const name of NEXT_CONFIG_FILES) {
    if (existsSync(join(root, name))) nextConfigs.set(name, readFileSync(join(root, name), "utf8"));
  }
  return { files, directories, nextConfigs };
}

function mentionsPageExtensions(name: string, source: string): boolean {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, false);
  let found = false;
  const visit = (node: ts.Node) => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === "pageExtensions") found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Decide which files are route handlers under THIS repository's contract (`route.ts` under `app/`),
 * and refuse every shape that would let a handler exist outside it.
 */
export function inspectRoutingTree(tree: RoutingTree): { routeFiles: string[]; problems: string[] } {
  const routeFiles: string[] = [];
  const problems: string[] = [];
  for (const path of [...tree.files].sort()) {
    if (/^(src\/)?pages\/api(\/|\.[a-z]+$)/.test(path)) {
      problems.push(`${path}: Pages Router API route — an alternate routing tree is outside the route-auth inventory`);
      continue;
    }
    if (path.startsWith("src/app/")) {
      problems.push(`${path}: src/app routing tree — the route-auth inventory covers app/ only`);
      continue;
    }
    if (!path.startsWith("app/")) continue;
    const match = ROUTE_FILE.exec(posix.basename(path));
    if (!match) continue;
    if (match[1] === "ts") routeFiles.push(path);
    else
      problems.push(
        `${path}: non-.ts route file — Next serves it, but this repository's inventory covers route.ts only`,
      );
  }
  for (const dir of tree.directories) {
    if (dir === "pages/api" || dir === "src/pages/api" || dir === "src/app")
      problems.push(`${dir}/: alternate routing tree present — outside the route-auth inventory`);
  }
  for (const [name, source] of tree.nextConfigs) {
    if (mentionsPageExtensions(name, source))
      problems.push(`${name}: pageExtensions is customized — update the route discovery contract first`);
  }
  return { routeFiles, problems };
}

export function loadRepoView(root: string = REPO_ROOT): { repo: RepoView; treeProblems: string[] } {
  const { routeFiles, problems } = inspectRoutingTree(readRoutingTree(root));
  const routeSources = new Map<string, string>();
  for (const path of routeFiles) routeSources.set(path, readFileSync(join(root, path), "utf8"));
  return {
    repo: {
      routeSources,
      exists: (path) => existsSync(join(root, path)),
      read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined),
    },
    treeProblems: problems,
  };
}

// ---------------------------------------------------------------------------------------------
// Source analysis
// ---------------------------------------------------------------------------------------------

type Resolution =
  | { kind: "import"; module: string; exportName: string }
  | { kind: "function"; fn: ts.FunctionLikeDeclaration }
  | { kind: "opaque" };
const OPAQUE: Resolution = { kind: "opaque" };

export interface RouteAnalysis {
  /** Per exported method: the import identities (`module#export[.member]`) it genuinely invokes. */
  methods: Map<HttpMethod, ReadonlySet<string>>;
  problems: string[];
}

export function normalizeModuleSpecifier(specifier: string, fromPath: string): string {
  let resolved: string;
  if (specifier.startsWith("@/")) resolved = specifier.slice(2);
  else if (specifier.startsWith(".")) resolved = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  else return specifier;
  return resolved.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "").replace(/\/index$/, "");
}

const identityOf = (module: string, exportName: string, member?: string) =>
  `${module}#${exportName}${member ? `.${member}` : ""}`;

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return (name.elements as readonly ts.ArrayBindingElement[]).flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function dynamicImportSpecifier(initializer: ts.Expression | undefined): string | undefined {
  if (!initializer || !ts.isAwaitExpression(initializer)) return undefined;
  const call = initializer.expression;
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
  const [specifier] = call.arguments;
  return call.arguments.length === 1 && ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
}

/** `true`/`false` only for conditions that are constant by SYNTAX; anything else is unknown. */
function staticTruth(expression: ts.Expression): boolean | undefined {
  let node = expression;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isNumericLiteral(node)) return Number(node.text) !== 0;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = staticTruth(node.operand);
    return inner === undefined ? undefined : !inner;
  }
  return undefined;
}

export function analyzeRouteSource(path: string, source: string): RouteAnalysis {
  const methods = new Map<HttpMethod, ReadonlySet<string>>();
  const problems: string[] = [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const parseDiagnostics = (file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (!Array.isArray(parseDiagnostics)) {
    problems.push(`${path}: parse diagnostics unavailable — cannot prove the route source parsed`);
    return { methods, problems };
  }
  if (parseDiagnostics.length > 0) {
    problems.push(`${path}: parse error — route source cannot be inventoried`);
    return { methods, problems };
  }

  // ---- lexical resolution -------------------------------------------------------------------

  const fromImport = (declaration: ts.ImportDeclaration, name: string): Resolution[] => {
    const clause = declaration.importClause;
    if (!clause || !ts.isStringLiteral(declaration.moduleSpecifier)) return [];
    const found: Resolution[] = [];
    if (clause.name?.text === name) found.push(OPAQUE);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) found.push(OPAQUE);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.name.text !== name) continue;
        found.push(
          clause.isTypeOnly || element.isTypeOnly
            ? OPAQUE
            : {
                kind: "import",
                module: normalizeModuleSpecifier(declaration.moduleSpecifier.text, path),
                exportName: (element.propertyName ?? element.name).text,
              },
        );
      }
    }
    return found;
  };

  const fromVariableList = (list: ts.VariableDeclarationList, name: string): Resolution[] => {
    const isConst = (list.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;
    const found: Resolution[] = [];
    for (const declaration of list.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        if (declaration.name.text !== name) continue;
        const initializer = declaration.initializer;
        found.push(
          isConst && initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
            ? { kind: "function", fn: initializer }
            : OPAQUE,
        );
        continue;
      }
      if (!bindingNames(declaration.name).includes(name)) continue;
      const specifier = dynamicImportSpecifier(declaration.initializer);
      if (!isConst || specifier === undefined || !ts.isObjectBindingPattern(declaration.name)) {
        found.push(OPAQUE);
        continue;
      }
      const element = declaration.name.elements.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
      );
      const exported = element && !element.dotDotDotToken && !element.initializer
        ? element.propertyName ?? element.name
        : undefined;
      found.push(
        exported && (ts.isIdentifier(exported) || ts.isStringLiteral(exported))
          ? { kind: "import", module: normalizeModuleSpecifier(specifier, path), exportName: exported.text }
          : OPAQUE,
      );
    }
    return found;
  };

  const fromStatements = (statements: readonly ts.Statement[], name: string): Resolution[] => {
    const found: Resolution[] = [];
    for (const statement of statements) {
      if (ts.isImportDeclaration(statement)) found.push(...fromImport(statement, name));
      else if (ts.isVariableStatement(statement)) found.push(...fromVariableList(statement.declarationList, name));
      else if (ts.isFunctionDeclaration(statement)) {
        if (statement.name?.text === name) found.push(statement.body ? { kind: "function", fn: statement } : OPAQUE);
      } else if (
        (ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement) ||
          ts.isImportEqualsDeclaration(statement)) &&
        statement.name &&
        ts.isIdentifier(statement.name) &&
        statement.name.text === name
      )
        found.push(OPAQUE);
    }
    return found;
  };

  /** `var` hoists to the enclosing function: find it in nested blocks without crossing functions. */
  const hoistedVar = (root: ts.Node, name: string): Resolution[] => {
    const found: Resolution[] = [];
    const visit = (node: ts.Node) => {
      if (node !== root && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
      if (
        ts.isVariableDeclarationList(node) &&
        (node.flags & ts.NodeFlags.BlockScoped) === 0 &&
        node.declarations.some((declaration) => bindingNames(declaration.name).includes(name))
      )
        found.push(OPAQUE);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
  };

  const declaredIn = (scope: ts.Node, name: string): Resolution[] => {
    if (ts.isSourceFile(scope)) return [...fromStatements(scope.statements, name), ...hoistedVar(scope, name)];
    if (ts.isBlock(scope) || ts.isModuleBlock(scope)) return fromStatements(scope.statements, name);
    if (ts.isCaseBlock(scope))
      return fromStatements(scope.clauses.flatMap((clause) => [...clause.statements]), name);
    if (ts.isCatchClause(scope))
      return scope.variableDeclaration && bindingNames(scope.variableDeclaration.name).includes(name) ? [OPAQUE] : [];
    if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope))
      return scope.initializer && ts.isVariableDeclarationList(scope.initializer)
        ? fromVariableList(scope.initializer, name)
        : [];
    if (ts.isClassLike(scope)) return scope.name?.text === name ? [OPAQUE] : [];
    if (ts.isFunctionLike(scope)) {
      const found: Resolution[] = [];
      for (const parameter of scope.parameters) if (bindingNames(parameter.name).includes(name)) found.push(OPAQUE);
      if (ts.isFunctionExpression(scope) && scope.name?.text === name) found.push(OPAQUE);
      const body = (scope as ts.FunctionLikeDeclaration).body;
      if (body) found.push(...hoistedVar(body, name));
      return found;
    }
    return [];
  };

  /** Nearest enclosing declaration of `id`; two declarations in one scope are ambiguous → opaque. */
  const resolve = (id: ts.Identifier): Resolution | undefined => {
    for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
      const found = declaredIn(scope, id.text);
      if (found.length === 1) return found[0];
      if (found.length > 1) return OPAQUE;
    }
    return undefined;
  };

  // ---- executed-body traversal --------------------------------------------------------------

  const collect = (fn: ts.FunctionLikeDeclaration, invoked: Set<string>, followed: Set<ts.Node>) => {
    if (followed.has(fn)) return; // cycle protection
    followed.add(fn);

    const recordCall = (call: ts.CallExpression) => {
      const callee = call.expression;
      if (ts.isIdentifier(callee)) {
        const target = resolve(callee);
        if (target?.kind === "import") invoked.add(identityOf(target.module, target.exportName));
        else if (target?.kind === "function") collect(target.fn, invoked, followed);
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const target = resolve(callee.expression);
        if (target?.kind === "import")
          invoked.add(identityOf(target.module, target.exportName, callee.name.text));
      }
    };

    const visit = (node: ts.Node) => {
      // A nested function or class is a DEFINITION; it runs only if explicitly called (see recordCall).
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
      if (ts.isBlock(node)) {
        for (const statement of node.statements) {
          visit(statement);
          if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break;
        }
        return;
      }
      if (ts.isIfStatement(node)) {
        visit(node.expression);
        const truth = staticTruth(node.expression);
        if (truth !== false) visit(node.thenStatement);
        if (truth !== true && node.elseStatement) visit(node.elseStatement);
        return;
      }
      if (ts.isWhileStatement(node)) {
        visit(node.expression);
        if (staticTruth(node.expression) !== false) visit(node.statement);
        return;
      }
      if (ts.isConditionalExpression(node)) {
        visit(node.condition);
        const truth = staticTruth(node.condition);
        if (truth !== false) visit(node.whenTrue);
        if (truth !== true) visit(node.whenFalse);
        return;
      }
      if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
          visit(node.left);
          const truth = staticTruth(node.left);
          const skipped =
            (operator === ts.SyntaxKind.AmpersandAmpersandToken && truth === false) ||
            (operator === ts.SyntaxKind.BarBarToken && truth === true);
          if (!skipped) visit(node.right);
          return;
        }
      }
      if (ts.isCallExpression(node)) recordCall(node);
      ts.forEachChild(node, visit);
    };

    if (fn.body) visit(fn.body);
  };

  // ---- exported method handlers -------------------------------------------------------------

  const handlers = new Map<HttpMethod, ts.FunctionLikeDeclaration>();
  const declare = (name: HttpMethod, fn: ts.FunctionLikeDeclaration) => {
    if (handlers.has(name)) problems.push(`${path} ${name}: unsupported export shape — declared more than once`);
    handlers.set(name, fn);
  };
  const unsupported = (name: string, shape: string) =>
    problems.push(`${path} ${name}: unsupported export shape (${shape}) — export the handler as a function`);

  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (!clause) {
        problems.push(
          `${path}: unsupported export shape (export * from) — re-exported HTTP methods cannot be inventoried`,
        );
      } else if (ts.isNamespaceExport(clause)) {
        if (isHttpMethod(clause.name.text)) unsupported(clause.name.text, "namespace re-export");
      } else {
        for (const specifier of clause.elements) {
          if (!specifier.isTypeOnly && isHttpMethod(specifier.name.text))
            unsupported(specifier.name.text, statement.moduleSpecifier ? "re-export" : "export specifier");
        }
      }
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) continue;
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text;
      if (!name || !isHttpMethod(name)) continue;
      if (statement.body) declare(name, statement);
      else unsupported(name, "overload signature");
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          for (const name of bindingNames(declaration.name))
            if (isHttpMethod(name)) unsupported(name, "destructured export");
          continue;
        }
        const name = declaration.name.text;
        if (!isHttpMethod(name)) continue;
        const initializer = declaration.initializer;
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)))
          declare(name, initializer);
        else unsupported(name, "exported binding is not a function literal");
      }
    } else if (
      (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) &&
      statement.name &&
      ts.isIdentifier(statement.name) &&
      isHttpMethod(statement.name.text)
    ) {
      unsupported(statement.name.text, "not a function");
    }
  }

  for (const [name, fn] of handlers) {
    const invoked = new Set<string>();
    collect(fn, invoked, new Set());
    methods.set(name, invoked);
  }
  if (handlers.size === 0 && problems.length === 0)
    problems.push(`${path}: no exported HTTP method handler — a route file must be classifiable`);
  return { methods, problems };
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

/** A registration is stale once its owner module stops exporting the entry point it names. */
function ownerDeclares(path: string, source: string, guard: GuardRegistration): boolean {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const exported = file.statements.some((statement) => {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return false;
    if (ts.isFunctionDeclaration(statement)) return statement.name?.text === guard.exportName;
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.some((declaration) =>
        bindingNames(declaration.name).includes(guard.exportName),
      );
    return false;
  });
  if (!exported || !guard.member) return exported;
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === guard.member
    )
      found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const keyOf = (path: string, method: string) => `${path} ${method}`;

/** Every violation as a `path METHOD: reason` line. Diagnostics carry paths, methods and symbols only. */
export function checkRouteAuth(repo: RepoView, policy: RouteAuthPolicy): string[] {
  const failures: string[] = [];
  const guardNames = Object.keys(policy.guards);

  // -- registrations: an explicit trust decision, coupled to evidence that still exists.
  const guardByIdentity = new Map<string, string>();
  for (const name of guardNames) {
    const guard = policy.guards[name];
    const identity = identityOf(guard.module, guard.exportName, guard.member);
    if (guardByIdentity.has(identity)) failures.push(`guard ${name}: duplicate registration of ${identity}`);
    guardByIdentity.set(identity, name);
    if (!guard.reason.trim()) failures.push(`guard ${name}: empty reason`);
    if (!guard.owner.trim()) failures.push(`guard ${name}: empty owner`);
    const modulePath = `${guard.module}.ts`;
    const ownerSource = repo.read(modulePath);
    if (ownerSource === undefined) failures.push(`guard ${name}: stale registration — ${modulePath} does not exist`);
    else if (!ownerDeclares(modulePath, ownerSource, guard))
      failures.push(`guard ${name}: stale registration — ${modulePath} no longer exports it`);
    if (guard.evidence.length === 0) failures.push(`guard ${name}: no denial evidence registered`);
    for (const evidence of guard.evidence)
      if (!repo.exists(evidence)) failures.push(`guard ${name}: stale evidence path ${evidence}`);
  }

  // -- discovery
  if (repo.routeSources.size === 0) failures.push("no App Router route files discovered — the inventory must be non-empty");
  const discovered = new Map<string, string[]>();
  for (const path of [...repo.routeSources.keys()].sort()) {
    const analysis = analyzeRouteSource(path, repo.routeSources.get(path) ?? "");
    failures.push(...analysis.problems);
    for (const [method, invoked] of analysis.methods) {
      discovered.set(
        keyOf(path, method),
        guardNames.filter((name) => {
          const guard = policy.guards[name];
          return invoked.has(identityOf(guard.module, guard.exportName, guard.member));
        }),
      );
    }
  }

  // -- classification: discovery keys and registry keys must match EXACTLY.
  const classified = new Map<string, "protected" | "public">();
  const usedGuards = new Set<string>();
  const classify = (key: string, as: "protected" | "public"): boolean => {
    const prior = classified.get(key);
    if (prior === undefined) {
      classified.set(key, as);
      return true;
    }
    failures.push(prior === as ? `${key}: duplicate classification` : `${key}: classified as both protected and public`);
    return false;
  };

  for (const row of policy.protectedRoutes) {
    const key = keyOf(row.path, row.method);
    if (!classify(key, "protected")) continue;
    const expected = [...new Set(row.guards)];
    const unknown = expected.filter((name) => !Object.hasOwn(policy.guards, name));
    for (const name of unknown) failures.push(`${key}: unknown guard "${name}" in its expected set`);
    for (const name of expected) usedGuards.add(name);
    if (expected.length === 0) failures.push(`${key}: empty expected guard set`);
    else if (unknown.length === 0 && expected.every((name) => policy.guards[name].coGuardOnly))
      failures.push(`${key}: ${expected.join(", ")} alone is never sufficient authentication`);
    const invoked = discovered.get(key);
    if (!invoked) {
      failures.push(`${key}: stale registry row — no such exported handler`);
      continue;
    }
    const missing = expected.filter((name) => !invoked.includes(name));
    const unexpected = invoked.filter((name) => !expected.includes(name));
    if (invoked.length === 0)
      failures.push(`${key}: no registered authentication invocation (expected ${expected.join(", ")})`);
    else if (missing.length > 0) failures.push(`${key}: missing expected guard invocation: ${missing.join(", ")}`);
    if (unexpected.length > 0)
      failures.push(
        `${key}: unexpected registered guard invocation: ${unexpected.join(", ")} — review and update its registry row`,
      );
  }

  for (const exception of policy.publicExceptions) {
    const key = keyOf(exception.path, exception.method);
    if (!classify(key, "public")) continue;
    if (!exception.reason.trim()) failures.push(`${key}: public exception has an empty reason`);
    if (!exception.protocol.trim()) failures.push(`${key}: public exception has an empty protocol description`);
    if (exception.evidence.length === 0) failures.push(`${key}: public exception has no evidence`);
    for (const evidence of exception.evidence)
      if (!repo.exists(evidence)) failures.push(`${key}: stale evidence path ${evidence}`);
    if (!discovered.has(key)) failures.push(`${key}: stale public exception — no such exported handler`);
  }

  for (const [key, invoked] of discovered) {
    if (classified.has(key)) continue;
    failures.push(
      invoked.length === 0
        ? `${key}: no registered authentication invocation — unclassified handler; add an expected-guard row or a public protocol exception`
        : `${key}: unclassified handler invoking ${invoked.join(", ")} — add an expected-guard row`,
    );
  }

  for (const name of guardNames)
    if (!usedGuards.has(name)) failures.push(`guard ${name}: unused registration — remove it`);

  return failures;
}

// ---------------------------------------------------------------------------------------------
// The registry (checked-in test policy — the source of truth for classification)
// ---------------------------------------------------------------------------------------------

const WRAPPER_EVIDENCE = "test/auth-wrapper-evidence.test.ts";

export const REGISTERED_GUARDS = {
  authenticateApiKey: {
    module: "lib/api/auth",
    exportName: "authenticateApiKey",
    owner: "lib/api/auth.ts",
    reason: "Member API-key bearer: key lookup, constant-time secret compare, active owner, team header match.",
    evidence: ["test/api-auth-team-header.test.ts", "test/http/auth.http.test.ts", WRAPPER_EVIDENCE],
  },
  authenticateAgentToken: {
    module: "lib/api/auth",
    exportName: "authenticateAgentToken",
    owner: "lib/api/auth.ts → lib/access/agent-tokens.ts",
    reason: "Delegated agent-token bearer: token verification plus team match before any principal is returned.",
    evidence: [
      "test/datamechanics/access-agent-tokens.datamechanics.test.ts",
      "test/http/agent-tokens.http.test.ts",
      WRAPPER_EVIDENCE,
    ],
  },
  getSessionUser: {
    module: "lib/auth/session",
    exportName: "getSessionUser",
    owner: "lib/auth/session.ts → lib/auth/pg-session.ts",
    reason: "Signed session cookie → identity. Identity only: team membership is the calling route's inline check.",
    evidence: [WRAPPER_EVIDENCE],
  },
  currentMember: {
    module: "lib/auth/guard",
    exportName: "currentMember",
    owner: "lib/auth/guard.ts",
    reason: "Session → active same-team membership with membership-derived posture.",
    evidence: [WRAPPER_EVIDENCE],
  },
  canAccessAdmin: {
    module: "lib/auth/admin-access",
    exportName: "canAccessAdmin",
    coGuardOnly: true,
    owner: "lib/auth/admin-access.ts",
    reason: "Admin authorization predicate (role ∧ team posture). Never authentication by itself.",
    evidence: ["test/admin-access.test.ts"],
  },
  resolveChatOwner: {
    module: "lib/chat/session",
    exportName: "resolveChatOwner",
    owner: "lib/chat/session.ts",
    reason: "Session → active same-team owner pair that scopes every conversation read/write.",
    evidence: [WRAPPER_EVIDENCE, "test/dashboard-conversation-auth.test.ts"],
  },
  gatewayAdminContext: {
    module: "lib/gateway/admin-http",
    exportName: "gatewayAdminContext",
    owner: "lib/gateway/admin-http.ts → lib/gateway/admin-persistence.ts:authorizeGatewayAdmin",
    reason: "Session → active admin with Everyone posture in the addressed team, or a fixed refusal Response.",
    evidence: [
      "test/gateway/gateway-admin-consumers.test.ts",
      "test/gateway/gateway-admin-routes.test.ts",
      "test/datamechanics/gateway-approval.datamechanics.test.ts",
      "test/http/gateway-approval-enabled.http.test.ts",
    ],
  },
  authenticateGatewayRequest: {
    module: "lib/gateway/http",
    exportName: "authenticateGatewayRequest",
    owner: "lib/gateway/http.ts → lib/gateway/persistence.ts:authenticateGatewayServiceCredential",
    reason: "Gateway service credential plus exact executor/companion/contract version headers.",
    evidence: [WRAPPER_EVIDENCE, "test/http/gateway-approval-enabled.http.test.ts"],
  },
  authorizeGraphProxy: {
    module: "lib/llm/graph-proxy",
    exportName: "authorizeGraphProxy",
    owner: "lib/llm/graph-proxy.ts",
    reason: "Shared-secret bearer for the internal graph LLM proxy; absent/weak/wrong secrets refuse.",
    evidence: ["test/graph-llm-proxy.test.ts"],
  },
  "governedActionHttp.submit": {
    module: "lib/actions/governed/http",
    exportName: "governedActionHttp",
    member: "submit",
    owner: "lib/actions/governed/http.ts → lib/api/auth.ts:authenticateApiKey",
    reason: "Wrapper authenticates the member API key before dispatching the governed submit service.",
    evidence: ["test/actions/governed-http-body.test.ts", "test/http/actions-durable.http.test.ts"],
  },
  "governedActionHttp.status": {
    module: "lib/actions/governed/http",
    exportName: "governedActionHttp",
    member: "status",
    owner: "lib/actions/governed/http.ts → lib/api/auth.ts:authenticateApiKey",
    reason: "Wrapper authenticates the member API key before dispatching the governed status service.",
    evidence: ["test/actions/governed-http-body.test.ts", "test/http/actions-durable.http.test.ts"],
  },
  stagingBuildMetadataResponse: {
    module: "lib/staging/build-metadata",
    exportName: "stagingBuildMetadataResponse",
    owner: "lib/staging/build-metadata.ts",
    reason: "Independent service-token check before any build metadata is returned. NOT a public route.",
    evidence: ["test/staging-build-metadata.test.ts"],
  },
} as const satisfies Record<string, GuardRegistration>;

type GuardName = keyof typeof REGISTERED_GUARDS;

const row = (path: string, method: HttpMethod, ...guards: GuardName[]): ProtectedRoute => ({
  path: `app/${path}/route.ts`,
  method,
  guards,
});

const GATEWAY_ADMIN = "api/internal/executor-gateway/v1/admin/[teamSlug]";
const GATEWAY = "api/internal/executor-gateway/v1";

/** One row per protected `(path, method)`. A new handler needs a new, reviewed row. */
export const PROTECTED_ROUTES: readonly ProtectedRoute[] = [
  row("api/auth/slack/start", "GET", "authenticateApiKey"),
  row("api/auth/slack/status", "GET", "authenticateApiKey"),

  // Session identity + an INLINE active same-team membership check this scanner does not prove.
  row("api/brain/arcs/recompute", "POST", "getSessionUser"),
  row("api/brain/arcs", "POST", "getSessionUser"),
  row("api/brain/events", "GET", "getSessionUser"),
  row("api/brain/facts", "GET", "getSessionUser"),
  row("api/dashboard/query", "POST", "getSessionUser"),
  row("api/dashboard/team-work", "GET", "getSessionUser"),
  row("api/dashboard/timeline", "GET", "getSessionUser"),

  // Traced through the called local `resolveAdminTeam` — that name is not itself an authority.
  row("api/dashboard/access/inspect", "GET", "getSessionUser", "canAccessAdmin"),
  row("api/dashboard/access/inspect", "POST", "getSessionUser", "canAccessAdmin"),
  row("api/dashboard/social/media/[id]", "GET", "currentMember", "canAccessAdmin"),

  row("api/dashboard/conversations/[id]", "GET", "resolveChatOwner"),
  row("api/dashboard/conversations/[id]", "PATCH", "resolveChatOwner"),
  row("api/dashboard/conversations/[id]", "DELETE", "resolveChatOwner"),
  row("api/dashboard/conversations/[id]/run", "GET", "resolveChatOwner"),
  row("api/dashboard/conversations", "GET", "resolveChatOwner"),

  // The nine managed-gateway admin operations.
  row(`${GATEWAY_ADMIN}/approvals`, "GET", "gatewayAdminContext"),
  row(`${GATEWAY_ADMIN}/approvals/[approvalId]/decision`, "POST", "gatewayAdminContext"),
  row(`${GATEWAY_ADMIN}/policies`, "GET", "gatewayAdminContext"),
  row(`${GATEWAY_ADMIN}/policies`, "POST", "gatewayAdminContext"),
  row(`${GATEWAY_ADMIN}/policies/[policyId]`, "PATCH", "gatewayAdminContext"),
  row(`${GATEWAY_ADMIN}/policies/[policyId]`, "DELETE", "gatewayAdminContext"),
  row(`${GATEWAY_ADMIN}/service-identities/[serviceIdentityId]/credentials`, "GET", "gatewayAdminContext"),
  row(`${GATEWAY_ADMIN}/service-identities/[serviceIdentityId]/credentials`, "POST", "gatewayAdminContext"),
  row(
    `${GATEWAY_ADMIN}/service-identities/[serviceIdentityId]/credentials/[credentialId]/revoke`,
    "POST",
    "gatewayAdminContext",
  ),

  row(`${GATEWAY}/authorize-and-redeem`, "POST", "authenticateGatewayRequest"),
  row(`${GATEWAY}/executions/[executionId]/resume-claim`, "POST", "authenticateGatewayRequest"),
  row(`${GATEWAY}/record-outcome`, "POST", "authenticateGatewayRequest"),
  row(`${GATEWAY}/resolve-lease`, "POST", "authenticateGatewayRequest"),

  row("api/internal/llm/v1/chat/completions", "POST", "authorizeGraphProxy"),
  row("api/internal/llm/v1/embeddings", "POST", "authorizeGraphProxy"),
  row("api/internal/staging-build-metadata", "GET", "stagingBuildMetadataResponse"),

  row("api/v1/actions/[action_id]", "GET", "governedActionHttp.status"),
  row("api/v1/actions", "POST", "authenticateApiKey"),
  row("api/v1/actions/submit", "POST", "governedActionHttp.submit"),
  row("api/v1/attribution", "GET", "authenticateApiKey"),
  row("api/v1/codebases/[slug]/debt-intake-events", "POST", "authenticateApiKey"),
  row("api/v1/codebases", "POST", "authenticateApiKey"),
  row("api/v1/company-graph", "GET", "authenticateApiKey"),
  row("api/v1/conversations/[id]", "GET", "authenticateApiKey"),
  row("api/v1/conversations", "GET", "authenticateApiKey"),
  row("api/v1/costs", "POST", "authenticateApiKey"),
  row("api/v1/decisions", "GET", "authenticateApiKey"),
  // Dual-credential handlers: member key OR delegated agent token, each on its own branch.
  row("api/v1/evidence/search", "POST", "authenticateApiKey", "authenticateAgentToken"),
  row("api/v1/graph-query", "POST", "authenticateApiKey"),
  row("api/v1/identities/resolve", "GET", "authenticateApiKey"),
  row("api/v1/integrations", "GET", "authenticateApiKey"),
  row("api/v1/items/[id]", "GET", "authenticateApiKey"),
  row("api/v1/items", "POST", "authenticateApiKey"),
  row("api/v1/items", "GET", "authenticateApiKey", "authenticateAgentToken"),
  row("api/v1/me", "GET", "authenticateApiKey"),
  row("api/v1/me/slack-token", "GET", "authenticateApiKey"),
  row("api/v1/me/slack-token", "POST", "authenticateApiKey"),
  row("api/v1/me/slack-token", "DELETE", "authenticateApiKey"),
  row("api/v1/members/invite", "POST", "authenticateApiKey"),
  row("api/v1/members", "GET", "authenticateApiKey"),
  row("api/v1/metrics", "POST", "authenticateApiKey"),
  row("api/v1/okf-bundle", "GET", "authenticateApiKey"),
  row("api/v1/pm-sync/health", "GET", "authenticateApiKey"),
  row("api/v1/projects", "GET", "authenticateApiKey"),
  row("api/v1/query", "POST", "authenticateApiKey", "authenticateAgentToken"),
  row("api/v1/subscriptions", "POST", "authenticateApiKey"),
  row("api/v1/tasks", "GET", "authenticateApiKey"),
  row("api/v1/timeline", "GET", "authenticateApiKey"),
  row("api/v1/work-events", "POST", "authenticateApiKey"),
];

/**
 * Public-by-design protocol endpoints. Exact path AND method; no directory or wildcard entries.
 * An exception never declares verifier-free success safe — its evidence still proves refusal.
 */
export const PUBLIC_EXCEPTIONS: readonly PublicException[] = [
  {
    path: "app/api/auth/login/route.ts",
    method: "POST",
    reason: "Obtains a session by proving a password; it cannot require a pre-existing session.",
    protocol: "loginWithPassword before signSession; rate limited; uniform 401 for every credential failure.",
    evidence: ["test/http/auth.http.test.ts", "test/datamechanics/login.datamechanics.test.ts"],
  },
  {
    path: "app/api/auth/request-magic-link/route.ts",
    method: "POST",
    reason: "Pre-login delivery request.",
    protocol: "Uniform response for known and unknown emails; rate limited; never sets a session.",
    evidence: ["test/request-magic-link-route.test.ts", "test/http/auth.http.test.ts"],
  },
  {
    path: "app/auth/confirm/route.ts",
    method: "GET",
    reason: "The browser redeems an emailed single-use token before any session exists.",
    protocol: "redeemMagicToken must return a valid, unexpired, unused token before signSession.",
    evidence: ["test/http/auth.http.test.ts", "test/datamechanics/login.datamechanics.test.ts"],
  },
  {
    path: "app/api/auth/slack/callback/route.ts",
    method: "GET",
    reason: "An OAuth browser redirect cannot carry a member API bearer.",
    protocol: "consumeSlackOAuthState verifies the signed single-use member/team binding before exchange or write.",
    evidence: ["test/slack-oauth-state.test.ts", "test/datamechanics/slack-oauth.datamechanics.test.ts"],
  },
  {
    path: "app/api/health/route.ts",
    method: "GET",
    reason: "Platform readiness is public.",
    protocol: "Only {ok,commit} without a token; detailed staging evidence stays token-authenticated.",
    evidence: ["test/staging-health.test.ts"],
  },
  {
    path: "app/auth/dev-login/route.ts",
    method: "GET",
    reason: "Deliberate local-development login.",
    protocol: "Production hard-off, exact opt-in and local-authority checks; no credential in this protocol.",
    evidence: [
      "test/dev-login-route.test.ts",
      "test/datamechanics/dev-login.datamechanics.test.ts",
      "test/http/dev-login.dev-http.test.ts",
      "test/http/dev-login-build-cli.ts",
    ],
  },
];

export const ROUTE_AUTH_POLICY: RouteAuthPolicy = {
  guards: REGISTERED_GUARDS,
  protectedRoutes: PROTECTED_ROUTES,
  publicExceptions: PUBLIC_EXCEPTIONS,
};
