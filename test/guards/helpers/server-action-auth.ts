import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  isBodyBearingFunction,
  PINNED_TS_PATHS,
  prologueHasUseServer,
  type BodyBearingFunction,
} from "../entry-surface-graph";
import { normalizeModuleSpecifier, REPO_ROOT } from "./api-route-auth";

/**
 * AIO-1217 — the Server Action authority inventory. Development-only: a build-failing CHECK, never
 * a runtime authorization layer. It parses source with the TypeScript compiler API; it never
 * executes it, never resolves an import and never opens a module to follow one.
 *
 * ## What the build enforces — exactly this and no more
 *
 *   DISCOVERY. Every supported-extension source file under an explicitly supplied root is parsed,
 *   untracked files included. A file whose directive prologue carries `"use server"` is an action
 *   module; each of its runtime exports is an action keyed by `(repository path, export name)`.
 *   A `"use server"` prologue inside any block-bodied function is an INLINE action and is refused
 *   outright — there is no registration form for one yet. The prologue predicate is the existing
 *   `entry-surface-graph.ts:prologueHasUseServer`, reused, not re-derived.
 *
 *   CLASSIFICATION. Discovered keys and registered keys must match exactly. A protected row pins
 *   the exact SET of registered owners its export genuinely invokes, by module export identity.
 *
 *   COMPLETION. An async owner is credited only where its promise is completed by one of three
 *   syntactic forms: `await owner(…)`, `return owner(…)` (a concise arrow body included), or a
 *   direct element of an array literal that is the sole argument of a directly awaited, unshadowed
 *   `Promise.all`. A sync owner is credited by the call alone. A local helper is followed only when
 *   it is explicitly called, and a helper that needs completion — it is `async`, or it hands an
 *   async owner's promise back through `return` — is credited only when its own call is completed
 *   the same way. Each registration's sync/async mode is checked against the owner's declaration
 *   before any call to it can count.
 *
 * Lexical identity follows the AIO-1208 route inventory's rules (`helpers/api-route-auth.ts`): a
 * callee resolves to a named import or a const-destructured `await import("literal")` of the
 * registered owner module. A same-spelled local, a shadowing parameter, an import never called, a
 * comment, a string, a type reference, a nested function merely defined, and every generator count
 * for nothing. That resolver is private to the route helper's closure, so the rules are restated
 * here rather than shared; only its pure `normalizeModuleSpecifier` is imported. The route helper,
 * its registrations and its credit policy are unchanged.
 *
 * ## The bound (do not read more into a green run than this)
 *
 * This pins WHICH registered owners an export invokes and that the invocation is syntactically
 * completed. It does not prove that the guard dominates every branch, that its verdict is honoured,
 * that its arguments are the authenticated ones, or that a returned scope constrains downstream
 * work — executing tests carry those. Dead code is pruned for the same small syntactic subset as
 * AIO-1208: a literal-constant `if`/`while`/ternary/`&&`/`||`, and statements after an
 * unconditional `return`/`throw` in the same block. Not admitted, by design: a promise stored and
 * awaited later, `.then`, a ternary or `??` around the call, `Promise.all` over anything but a
 * literal array, every other combinator, `owner.member(…)` calls, a const alias of an import, and
 * an IIFE. Discovery is a conservative source inventory, not proof a file is bundled or reachable
 * over the wire.
 */

export { REPO_ROOT };

// ---------------------------------------------------------------------------------------------
// Filesystem discovery
// ---------------------------------------------------------------------------------------------

export const SERVER_ACTION_SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;

/** First-party roots reviewed as places an action may live. A directive elsewhere is unclassified. */
export const REVIEWED_ACTION_ROOTS = ["app", "src", "pages", "components", "lib"] as const;

export interface PinnedExclusion {
  name: string;
  reason: string;
}

export interface ExclusionPolicy {
  /** Repository-root entry names never entered, matched before any symlink classification. */
  rootNames: readonly PinnedExclusion[];
  /** Root-level generated-file name prefixes. */
  rootFilePrefixes: readonly PinnedExclusion[];
  /** Exact root-relative directories below `ingestion/`. */
  nestedPaths: readonly PinnedExclusion[];
  /** Directory names excluded at any depth strictly below `under`. */
  nestedNames: readonly (PinnedExclusion & { under: string })[];
}

/**
 * The pinned non-product roots. Each is a NAME match at the repository root only: a nested
 * `app/node_modules` or `app/build` is first-party source and is walked. Adding a name here hides
 * source from the inventory, so the test pins this list literally.
 */
export const SERVER_ACTION_EXCLUSIONS: ExclusionPolicy = {
  rootNames: [
    { name: "node_modules", reason: "dependency tree" },
    { name: ".next", reason: "framework build output" },
    { name: ".git", reason: "Git metadata (a worktree's gitlink file included)" },
    { name: ".context", reason: "task-recovery storage (common .git/info/exclude)" },
    { name: "coverage", reason: "test output" },
    { name: "out", reason: "build output" },
    { name: "build", reason: "build output" },
    { name: ".yarn", reason: "package-manager state" },
    { name: ".vercel", reason: "deploy tool state" },
    { name: ".pnp", reason: "package-manager state" },
    { name: ".aios", reason: "local tool state" },
    { name: "supabase", reason: "local stack" },
    { name: "tmp", reason: "customer scratch" },
    { name: ".staging-pair-artifacts", reason: "operational evidence" },
    { name: ".staging-ops-reaper-checks", reason: "operational evidence" },
  ],
  rootFilePrefixes: [{ name: ".pnp.", reason: "root-generated package-manager loader files" }],
  nestedPaths: [
    { name: "ingestion/.venv", reason: "Python virtualenv (ingestion/.gitignore)" },
    { name: "ingestion/.pytest_cache", reason: "pytest cache (ingestion/.gitignore)" },
  ],
  nestedNames: [{ under: "ingestion", name: "__pycache__", reason: "Python bytecode cache (ingestion/.gitignore)" }],
};

const NEVER_EXCLUDED_ROOTS: ReadonlySet<string> = new Set([...REVIEWED_ACTION_ROOTS, "scripts", "test"]);

/** Structural drift in an exclusion policy. The exact pinned names are asserted by the test. */
export function exclusionPolicyProblems(policy: ExclusionPolicy): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const entry = (kind: string, name: string, reason: string) => {
    const key = `${kind}:${name}`;
    if (seen.has(key)) problems.push(`exclusion ${name}: duplicate ${kind} entry`);
    seen.add(key);
    if (!name.trim()) problems.push(`exclusion: empty ${kind} name`);
    if (!reason.trim()) problems.push(`exclusion ${name}: empty reason`);
  };
  for (const { name, reason } of policy.rootNames) {
    entry("root", name, reason);
    if (name.includes("/")) problems.push(`exclusion ${name}: a root exclusion is a single name, not a path`);
    if (NEVER_EXCLUDED_ROOTS.has(name)) problems.push(`exclusion ${name}: a first-party source root cannot be excluded`);
  }
  for (const { name, reason } of policy.rootFilePrefixes) entry("root-file-prefix", name, reason);
  for (const { name, reason } of policy.nestedPaths) {
    entry("nested", name, reason);
    if (!/^ingestion\/[^/]+$/.test(name))
      problems.push(`exclusion ${name}: nested exclusions are pinned to direct children of ingestion/`);
  }
  for (const { under, name, reason } of policy.nestedNames) {
    entry("nested-name", `${under}/**/${name}`, reason);
    if (under !== "ingestion") problems.push(`exclusion ${under}/**/${name}: nested name exclusions are pinned to ingestion/`);
  }
  return problems;
}

const hasSourceExtension = (name: string): boolean => SERVER_ACTION_SOURCE_EXT.some((ext) => name.endsWith(ext));

function exclusionFor(policy: ExclusionPolicy, parent: string, name: string): string | undefined {
  const rel = parent ? `${parent}/${name}` : name;
  if (!parent) {
    const root = policy.rootNames.find((entry) => entry.name === name);
    if (root) return root.reason;
    const prefix = policy.rootFilePrefixes.find((entry) => name.startsWith(entry.name));
    if (prefix) return prefix.reason;
  }
  const nested = policy.nestedPaths.find((entry) => entry.name === rel);
  if (nested) return nested.reason;
  return policy.nestedNames.find((entry) => entry.name === name && rel.startsWith(`${entry.under}/`))?.reason;
}

export interface DiscoveredTree {
  /** Supported-extension source keyed by root-relative posix path. */
  sources: Map<string, string>;
  problems: string[];
  /** Entries skipped by pinned name or as `.env*`, never read. */
  skipped: { path: string; reason: string }[];
}

/**
 * Walk the real filesystem under an explicitly supplied `root` — reads only, never an ancestor.
 *
 * Order per entry: (1) pinned exclusion by NAME, before the entry is classified, so a symlinked
 * root `node_modules` is skipped without its target being visited; (2) a non-directory `.env*`
 * entry is skipped without being read or probed; (3) a symlink is never followed — one that is
 * source-named is diagnosed without probing, and any other has its target TYPE probed once (a
 * `stat`, no read) only to tell a directory link, which is diagnosed, from an unrelated file link,
 * which is ignored; (4) a directory is entered; (5) a supported-extension file is read; every
 * other file is skipped unread.
 */
export function discoverSourceTree(root: string, policy: ExclusionPolicy = SERVER_ACTION_EXCLUSIONS): DiscoveredTree {
  const tree: DiscoveredTree = { sources: new Map(), problems: [], skipped: [] };
  const walk = (parent: string) => {
    const entries = readdirSync(parent ? join(root, parent) : root, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = parent ? `${parent}/${entry.name}` : entry.name;
      const excluded = exclusionFor(policy, parent, entry.name);
      if (excluded) {
        tree.skipped.push({ path: rel, reason: excluded });
        continue;
      }
      if (entry.name.startsWith(".env") && !entry.isDirectory()) {
        tree.skipped.push({ path: rel, reason: "environment file — never read" });
        continue;
      }
      if (entry.isSymbolicLink()) {
        if (hasSourceExtension(entry.name)) {
          tree.problems.push(`${rel}: symlinked source file — not followed; a first-party source link must be reviewed`);
          continue;
        }
        let directory = false;
        try {
          directory = statSync(join(root, rel)).isDirectory();
        } catch {
          directory = false; // dangling link: nothing to inventory
        }
        if (directory)
          tree.problems.push(`${rel}/: symlinked directory — not followed; a first-party directory link must be reviewed`);
        continue;
      }
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && hasSourceExtension(entry.name)) tree.sources.set(rel, readFileSync(join(root, rel), "utf8"));
    }
  };
  walk("");
  return tree;
}

/** The slice of the repository the checker reads. Mutation tests supply an in-memory copy. */
export interface ActionRepoView {
  /** Every discovered supported-extension source, keyed by root-relative posix path. */
  sources: ReadonlyMap<string, string>;
  discoveryProblems: readonly string[];
  exists(path: string): boolean;
  read(path: string): string | undefined;
}

export function loadActionRepoView(root: string = REPO_ROOT, policy: ExclusionPolicy = SERVER_ACTION_EXCLUSIONS): ActionRepoView {
  const tree = discoverSourceTree(root, policy);
  return {
    sources: tree.sources,
    discoveryProblems: tree.problems,
    exists: (path) => existsSync(join(root, path)),
    read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined),
  };
}

const isRootRelative = (path: string): boolean =>
  !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

// ---------------------------------------------------------------------------------------------
// Directive discovery
// ---------------------------------------------------------------------------------------------

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(path: string, source: string): { file: ts.SourceFile; problem?: string } {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const diagnostics = (file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (!Array.isArray(diagnostics)) return { file, problem: "parse diagnostics unavailable — cannot prove the source parsed" };
  if (diagnostics.length > 0) return { file, problem: "parse error — first-party source cannot be inventoried" };
  return { file };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

const lineOf = (file: ts.SourceFile, node: ts.Node): number =>
  file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

export interface InlineDirective {
  path: string;
  /** The body-bearing syntax form, e.g. `ArrowFunction`, `MethodDeclaration`, `Constructor`. */
  form: string;
  name: string;
  line: number;
}

export interface SourceScan {
  parseProblem?: string;
  moduleDirective: boolean;
  inline: readonly InlineDirective[];
}

function functionName(node: BodyBearingFunction): string {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const own = ts.isArrowFunction(node) ? undefined : node.name;
  if (own && (ts.isIdentifier(own) || ts.isStringLiteral(own) || ts.isPrivateIdentifier(own))) return own.text;
  const parent = node.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && ts.isIdentifier(parent.name))
    return parent.name.text;
  return "<anonymous>";
}

const scanCache = new Map<string, SourceScan>();

/**
 * Where a file carries a `"use server"` directive prologue: at module level, and in every
 * block-bodied function, method, constructor and accessor at any depth. Memoised on
 * (path, content): the real tree is ~1,600 files and the mutants re-scan it with one file changed.
 */
export function scanSource(path: string, source: string): SourceScan {
  const key = `${path.length}:${path}${source}`;
  const cached = scanCache.get(key);
  if (cached) return cached;
  const { file, problem } = parse(path, source);
  const inline: InlineDirective[] = [];
  let scan: SourceScan;
  if (problem) scan = { parseProblem: problem, moduleDirective: false, inline };
  else {
    const visit = (node: ts.Node) => {
      // An arrow's body is a ConciseBody: `isBlock` carries an expression body out, as the existing detector does.
      if (isBodyBearingFunction(node) && node.body && ts.isBlock(node.body) && prologueHasUseServer(node.body.statements))
        inline.push({ path, form: ts.SyntaxKind[node.kind], name: functionName(node), line: lineOf(file, node) });
      ts.forEachChild(node, visit);
    };
    visit(file);
    scan = { moduleDirective: prologueHasUseServer(file.statements), inline };
  }
  scanCache.set(key, scan);
  return scan;
}

// ---------------------------------------------------------------------------------------------
// Policy shapes
// ---------------------------------------------------------------------------------------------

export type CompletionMode = "sync" | "async";

export interface OwnerRegistration {
  /** Owner module: the repo-relative path of `<module>.ts`, without the extension. */
  module: string;
  exportName: string;
  /** Verified against the owner's declaration before any call to it is credited. */
  mode: CompletionMode;
  /** A predicate or scope resolver that never authenticates by itself (must be co-invoked). */
  coGuardOnly?: boolean;
  /** The authority chain a reviewer should read. */
  owner: string;
  reason: string;
}

/** A test file and the literal titles of the cases in it that execute the action and assert refusal. */
export interface EvidenceRef {
  path: string;
  cases: readonly string[];
}

export interface ProtectedAction {
  path: string;
  exportName: string;
  /** The EXACT set of registered owner names the export must invoke. */
  owners: readonly string[];
  /** Optional exact credited call-site counts, e.g. the two `visibleProjectRows` principals. */
  callSites?: Readonly<Record<string, number>>;
  /** Inline role/posture co-checks with no imported owner; proven by executing tests, not here. */
  inlineRequirements?: readonly string[];
  refusal: string;
  /** The operations whose denial tests must observe. */
  effects: readonly string[];
  /** bound / selected correction / deferred / not certified beyond registered conjunctions. */
  clientIdBinding: string;
  /** Desired protections this row does NOT certify, e.g. `AIO-1225`. */
  deferred?: readonly string[];
  evidence: readonly EvidenceRef[];
}

export interface ProtocolException {
  path: string;
  exportName: string;
  /** The exact owner set the protocol export invokes (may be empty only if it invokes none). */
  owners: readonly string[];
  reason: string;
  protocol: string;
  evidence: readonly EvidenceRef[];
}

export interface ActionCensus {
  modules: number;
  runtimeExports: number;
  erasedExports: number;
  inlineDirectives: number;
}

export interface ServerActionPolicy {
  owners: Readonly<Record<string, OwnerRegistration>>;
  protectedActions: readonly ProtectedAction[];
  protocolExceptions: readonly ProtocolException[];
  census: ActionCensus;
  exclusions: ExclusionPolicy;
}

const identityOf = (module: string, exportName: string) => `${module}#${exportName}`;
export const ownerIdentity = (owner: OwnerRegistration): string => identityOf(owner.module, owner.exportName);

/** `module#export` → declared mode, for every registration. Declarations are NOT verified here. */
export function ownerModes(owners: Readonly<Record<string, OwnerRegistration>>): Map<string, CompletionMode> {
  return new Map(Object.values(owners).map((owner) => [ownerIdentity(owner), owner.mode] as const));
}

// ---------------------------------------------------------------------------------------------
// Action module analysis
// ---------------------------------------------------------------------------------------------

export interface ActionExport {
  name: string;
  line: number;
  shape: string;
  supported: boolean;
}

export interface ActionModuleAnalysis {
  /** Every runtime export, supported or not — an unsupported shape is discovered, then refused. */
  runtimeExports: ActionExport[];
  erasedExports: string[];
  problems: string[];
  /** Per supported export: owner identity (`module#export`) → credited call sites. */
  invocations: Map<string, ReadonlyMap<string, number>>;
}

type Resolution =
  | { kind: "import"; module: string; exportName: string }
  | { kind: "function"; fn: ts.FunctionLikeDeclaration }
  | { kind: "opaque" };
const OPAQUE: Resolution = { kind: "opaque" };

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return (name.elements as readonly ts.ArrayBindingElement[]).flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

const isConstList = (list: ts.VariableDeclarationList): boolean =>
  (list.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;

/** `await import("literal")` exactly — a StringLiteral specifier, one argument, directly awaited. */
function dynamicImportSpecifier(initializer: ts.Expression | undefined): string | undefined {
  if (!initializer || !ts.isAwaitExpression(initializer)) return undefined;
  const call = initializer.expression;
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
  const [specifier] = call.arguments;
  return call.arguments.length === 1 && ts.isStringLiteral(specifier) ? specifier.text : undefined;
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

/**
 * Inventory one action module: its runtime and erased exports, and — for each supported export —
 * the registered owners it genuinely invokes with a completed call. `owners` maps `module#export`
 * to the completion mode a call must satisfy; an identity absent from it is never credited.
 */
export function analyzeActionModule(
  path: string,
  source: string,
  owners: ReadonlyMap<string, CompletionMode>,
): ActionModuleAnalysis {
  const analysis: ActionModuleAnalysis = { runtimeExports: [], erasedExports: [], problems: [], invocations: new Map() };
  const { file, problem } = parse(path, source);
  if (problem) {
    analysis.problems.push(`${path}: ${problem}`);
    return analysis;
  }

  // ---- lexical resolution (AIO-1208's rules) ------------------------------------------------

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
    const isConst = isConstList(list);
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
      // A credited element is a plain identifier or `exported: local` rename — no default, rest or nesting.
      const element = declaration.name.elements.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
      );
      const exported =
        element && !element.dotDotDotToken && !element.initializer ? (element.propertyName ?? element.name) : undefined;
      found.push(
        exported && ts.isIdentifier(exported)
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

  // ---- completion forms ---------------------------------------------------------------------

  type Completion = "await" | "return" | "all";

  /** The node standing for `node` once enclosing parentheses are stepped over, with its parent. */
  const outward = (node: ts.Node): { node: ts.Node; parent: ts.Node } => {
    let current = node;
    while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
    return { node: current, parent: current.parent };
  };

  /** `Promise.all` where `Promise` has no lexical declaration in any enclosing scope. */
  const isGlobalPromiseAll = (callee: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(callee) &&
    !callee.questionDotToken &&
    callee.name.text === "all" &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Promise" &&
    resolve(callee.expression) === undefined;

  const completionOf = (call: ts.CallExpression): Completion | undefined => {
    const { node, parent } = outward(call);
    if (ts.isAwaitExpression(parent)) return "await";
    if (ts.isReturnStatement(parent)) return "return";
    if (ts.isArrowFunction(parent) && parent.body === node) return "return";
    if (ts.isArrayLiteralExpression(parent)) {
      const combinator = parent.parent;
      if (
        ts.isCallExpression(combinator) &&
        combinator.arguments.length === 1 &&
        combinator.arguments[0] === parent &&
        !combinator.questionDotToken &&
        isGlobalPromiseAll(combinator.expression) &&
        ts.isAwaitExpression(outward(combinator).parent)
      )
        return "all";
    }
    return undefined;
  };

  // ---- executed-body traversal --------------------------------------------------------------

  interface Credit {
    calls: Map<string, Set<ts.Node>>;
    /** The caller must complete a call to this function for anything in it to count. */
    needsCompletion: boolean;
  }
  const NOTHING = (): Credit => ({ calls: new Map(), needsCompletion: true });

  const creditOf = (fn: ts.FunctionLikeDeclaration, stack: ReadonlySet<ts.Node>): Credit => {
    // Calling a generator runs none of its body — it only creates an iterator — so nothing in it is credited.
    if (fn.asteriskToken) return NOTHING();
    if (stack.has(fn)) return NOTHING(); // cycle protection
    const inner = new Set(stack).add(fn);
    const isAsync = hasModifier(fn, ts.SyntaxKind.AsyncKeyword);
    const credit: Credit = { calls: new Map(), needsCompletion: isAsync };

    /** Whether `call` completes a promise here; a returned promise makes a sync function owe completion. */
    const completes = (call: ts.CallExpression): boolean => {
      const form = completionOf(call);
      if (form === undefined) return false;
      if (isAsync) return true;
      if (form !== "return") return false; // `await` has no meaning in a non-async body
      credit.needsCompletion = true;
      return true;
    };
    const add = (identity: string, site: ts.Node) => {
      const sites = credit.calls.get(identity) ?? new Set<ts.Node>();
      sites.add(site);
      credit.calls.set(identity, sites);
    };

    const recordCall = (call: ts.CallExpression) => {
      const callee = call.expression;
      if (!ts.isIdentifier(callee)) return;
      const target = resolve(callee);
      if (target?.kind === "import") {
        const identity = identityOf(target.module, target.exportName);
        const mode = owners.get(identity);
        if (mode === "sync" || (mode === "async" && completes(call))) add(identity, call);
      } else if (target?.kind === "function") {
        const helper = creditOf(target.fn, inner);
        if (helper.calls.size === 0) return;
        if (helper.needsCompletion && !completes(call)) return;
        for (const [identity, sites] of helper.calls) for (const site of sites) add(identity, site);
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
    return credit;
  };

  // ---- exports ------------------------------------------------------------------------------

  const actions = new Map<string, ts.FunctionLikeDeclaration>();
  const seen = new Set<string>();
  const record = (name: string, node: ts.Node, shape: string, fn?: ts.FunctionLikeDeclaration) => {
    if (seen.has(name)) analysis.problems.push(`${path} ${name}: unsupported action export shape (exported more than once)`);
    seen.add(name);
    analysis.runtimeExports.push({ name, line: lineOf(file, node), shape, supported: fn !== undefined });
    if (fn) actions.set(name, fn);
    else
      analysis.problems.push(
        `${path} ${name}: unsupported action export shape (${shape}) — export the action as an async function`,
      );
  };
  const functionShape = (fn: ts.FunctionLikeDeclaration, literal: string): { shape: string; ok: boolean } => {
    const isAsync = hasModifier(fn, ts.SyntaxKind.AsyncKeyword);
    if (fn.asteriskToken) return { shape: isAsync ? "async generator" : "generator", ok: false };
    if (!isAsync) return { shape: `non-async ${literal}`, ok: false };
    return { shape: `async ${literal}`, ok: true };
  };
  /** A local name that only ever names an interface or a type alias at module scope. */
  const isLocalTypeOnly = (name: string): boolean => {
    const declarations = file.statements.filter(
      (statement) =>
        (ts.isImportDeclaration(statement) && fromImport(statement, name).length > 0) ||
        (ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some((d) => bindingNames(d.name).includes(name))) ||
        ((ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement) ||
          ts.isImportEqualsDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
          statement.name !== undefined &&
          ts.isIdentifier(statement.name) &&
          statement.name.text === name),
    );
    return (
      declarations.length > 0 &&
      declarations.every((statement) => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
    );
  };

  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement)) {
      record(statement.isExportEquals ? "export=" : "default", statement, "default export without a stable identity");
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (statement.isTypeOnly) {
        if (clause && ts.isNamedExports(clause)) for (const s of clause.elements) analysis.erasedExports.push(s.name.text);
        else analysis.erasedExports.push("*");
        continue;
      }
      if (!clause) {
        analysis.problems.push(`${path}: unsupported action export shape (export * from) — re-exported actions cannot be inventoried`);
      } else if (ts.isNamespaceExport(clause)) {
        record(clause.name.text, clause, "namespace re-export");
      } else {
        for (const specifier of clause.elements) {
          const local = (specifier.propertyName ?? specifier.name).text;
          if (specifier.isTypeOnly) analysis.erasedExports.push(specifier.name.text);
          else if (statement.moduleSpecifier) record(specifier.name.text, specifier, "external re-export");
          else if (isLocalTypeOnly(local)) analysis.erasedExports.push(specifier.name.text);
          else record(specifier.name.text, specifier, "local export specifier");
        }
      }
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      analysis.erasedExports.push(statement.name.text);
      continue;
    }
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      record("default", statement, "default export without a stable identity");
      continue;
    }
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? "default";
      if (!statement.body) record(name, statement, "bodiless function signature");
      else {
        const { shape, ok } = functionShape(statement, "function declaration");
        record(name, statement, shape, ok ? statement : undefined);
      }
    } else if (ts.isVariableStatement(statement)) {
      const isConst = isConstList(statement.declarationList);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          for (const name of bindingNames(declaration.name)) record(name, declaration, "destructured export");
          continue;
        }
        const name = declaration.name.text;
        const initializer = declaration.initializer;
        // A `let`/`var` export can be reassigned after the body inspected here was written.
        if (!isConst) record(name, declaration, "mutable let/var export");
        else if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          const { shape, ok } = functionShape(initializer, ts.isArrowFunction(initializer) ? "arrow" : "function expression");
          record(name, declaration, shape, ok ? initializer : undefined);
        } else record(name, declaration, "exported binding is not a function literal");
      }
    } else if (ts.isImportEqualsDeclaration(statement)) {
      record(statement.name.text, statement, "import-equals alias");
    } else if (
      (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) &&
      statement.name &&
      ts.isIdentifier(statement.name)
    ) {
      record(statement.name.text, statement, "not a function");
    } else {
      analysis.problems.push(`${path}: unsupported action export shape (${ts.SyntaxKind[statement.kind]})`);
    }
  }

  for (const [name, fn] of actions) {
    const credit = creditOf(fn, new Set());
    analysis.invocations.set(name, new Map([...credit.calls].map(([identity, sites]) => [identity, sites.size])));
  }
  return analysis;
}

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

export interface ActionInventory {
  /** Action modules (module-level directive), keyed by path. */
  modules: Map<string, ActionModuleAnalysis>;
  inline: InlineDirective[];
  problems: string[];
  census: ActionCensus;
}

const inReviewedRoot = (path: string): boolean =>
  (REVIEWED_ACTION_ROOTS as readonly string[]).includes(path.split("/")[0]) && path.includes("/");

/** Scan every source in `view`; analyse every action module against `owners`. */
export function inventoryServerActions(
  view: ActionRepoView,
  owners: ReadonlyMap<string, CompletionMode>,
): ActionInventory {
  const inventory: ActionInventory = {
    modules: new Map(),
    inline: [],
    problems: [...view.discoveryProblems],
    census: { modules: 0, runtimeExports: 0, erasedExports: 0, inlineDirectives: 0 },
  };
  for (const path of [...view.sources.keys()].sort()) {
    if (!isRootRelative(path)) {
      inventory.problems.push(`${path}: source path is not root-relative — refusing to inventory it`);
      continue;
    }
    const source = view.sources.get(path) ?? "";
    const scan = scanSource(path, source);
    if (scan.parseProblem) {
      inventory.problems.push(`${path}: ${scan.parseProblem}`);
      continue;
    }
    for (const inline of scan.inline) {
      inventory.inline.push(inline);
      inventory.problems.push(
        `${path}:${inline.line} ${inline.name}: inline "use server" directive (${inline.form}) — inline actions are refused until a reviewed registration form exists`,
      );
    }
    if ((scan.moduleDirective || scan.inline.length > 0) && !inReviewedRoot(path))
      inventory.problems.push(
        `${path}: "use server" directive outside the reviewed action roots (${REVIEWED_ACTION_ROOTS.join(", ")}) — unclassified action location`,
      );
    if (!scan.moduleDirective) continue;
    const analysis = analyzeActionModule(path, source, owners);
    inventory.modules.set(path, analysis);
    inventory.problems.push(...analysis.problems);
    inventory.census.runtimeExports += analysis.runtimeExports.length;
    inventory.census.erasedExports += analysis.erasedExports.length;
  }
  inventory.census.modules = inventory.modules.size;
  inventory.census.inlineDirectives = inventory.inline.length;
  return inventory;
}

// ---------------------------------------------------------------------------------------------
// Owner, alias and evidence censuses
// ---------------------------------------------------------------------------------------------

function declaresTopLevel(statement: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.some((declaration) => bindingNames(declaration.name).includes(name));
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    if (!clause) return false;
    if (ts.isNamespaceExport(clause)) return clause.name.text === name;
    return clause.elements.some((specifier) => specifier.name.text === name);
  }
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    return (
      clause?.name?.text === name ||
      (bindings !== undefined &&
        (ts.isNamespaceImport(bindings)
          ? bindings.name.text === name
          : bindings.elements.some((element) => element.name.text === name)))
    );
  }
  return (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement)) &&
    statement.name !== undefined &&
    ts.isIdentifier(statement.name) &&
    statement.name.text === name
  );
}

/**
 * The finite supported owner shape: ONE exported ordinary function declaration with a body. Async
 * mode requires the `async` modifier; sync mode requires its absence and an explicit `boolean`
 * return annotation. Anything else — an overload set, a const binding, a re-export, a generator,
 * a stale mode — is refused. A source-declaration pin, not inference over the body.
 */
export function ownerDeclarationProblem(path: string, source: string, owner: OwnerRegistration): string | undefined {
  const { file, problem } = parse(path, source);
  if (problem) return `${path} does not parse`;
  const named = file.statements.filter((statement) => declaresTopLevel(statement, owner.exportName));
  if (named.length === 0) return `stale registration — ${path} no longer declares it`;
  if (named.length > 1) return `unsupported owner declaration — ${path} declares it more than once`;
  const [declaration] = named;
  if (!ts.isFunctionDeclaration(declaration) || !declaration.body)
    return `unsupported owner declaration — not an ordinary function declaration in ${path}`;
  if (!hasModifier(declaration, ts.SyntaxKind.ExportKeyword) || hasModifier(declaration, ts.SyntaxKind.DefaultKeyword))
    return `stale registration — ${path} no longer exports it by name`;
  if (declaration.asteriskToken) return "unsupported owner declaration — a generator never runs when called";
  const isAsync = hasModifier(declaration, ts.SyntaxKind.AsyncKeyword);
  if (owner.mode === "async")
    return isAsync ? undefined : "stale completion mode — registered async, declared without the async modifier";
  if (isAsync) return "stale completion mode — registered sync, declared async";
  if (declaration.type?.kind !== ts.SyntaxKind.BooleanKeyword)
    return "unsupported owner declaration — a sync co-predicate must carry an explicit boolean return annotation";
  return undefined;
}

const OWNER_ALTERNATES = [".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".d.ts"] as const;

/** `<module>.ts` must be the SOLE file the extensionless canonical specifier can name. */
export function ownerModuleCensusProblems(view: ActionRepoView, module: string): string[] {
  const alternates = [
    ...OWNER_ALTERNATES.map((ext) => `${module}${ext}`),
    ...SERVER_ACTION_SOURCE_EXT.map((ext) => `${module}/index${ext}`),
  ];
  return alternates.filter((path) => view.exists(path)).map((path) => `${path} shadows the canonical owner ${module}.ts`);
}

/** `@/` is trusted as the root alias only while tsconfig still says exactly that. */
export function aliasCensusProblems(view: ActionRepoView): string[] {
  const text = view.read("tsconfig.json");
  if (text === undefined) return ["tsconfig.json: missing — the @/ root alias is unverified"];
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", text);
  if (parsed.error) return ["tsconfig.json: does not parse — the @/ root alias is unverified"];
  const options = (parsed.config as { compilerOptions?: { paths?: unknown; baseUrl?: unknown } } | undefined)?.compilerOptions;
  const problems: string[] = [];
  if (JSON.stringify(options?.paths) !== JSON.stringify(PINNED_TS_PATHS))
    problems.push(`tsconfig.json: compilerOptions.paths drifted from the pinned ${JSON.stringify(PINNED_TS_PATHS)}`);
  if (options?.baseUrl !== undefined && options.baseUrl !== "." && options.baseUrl !== "./")
    problems.push("tsconfig.json: compilerOptions.baseUrl is not the repository root");
  return problems;
}

/**
 * The literal `it(...)`/`test(...)` titles in a test file. A `.todo`, `.skip` or `.fails` case is a
 * placeholder and is never evidence. This shows a named case EXISTS and is not disabled by syntax;
 * it does not show the case passes, executes the action, or asserts a refusal.
 */
export function testCaseTitles(path: string, source: string): { executable: Set<string>; placeholders: Set<string> } {
  const executable = new Set<string>();
  const placeholders = new Set<string>();
  const { file, problem } = parse(path, source);
  if (problem) return { executable, placeholders };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const [title] = node.arguments;
      if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
        const members: string[] = [];
        let callee: ts.Expression = node.expression;
        for (;;) {
          if (ts.isPropertyAccessExpression(callee)) {
            members.push(callee.name.text);
            callee = callee.expression;
          } else if (ts.isCallExpression(callee)) callee = callee.expression;
          else break;
        }
        if (ts.isIdentifier(callee) && (callee.text === "it" || callee.text === "test")) {
          const disabled = members.some((member) => member === "todo" || member === "skip" || member === "fails");
          (disabled ? placeholders : executable).add(title.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { executable, placeholders };
}

function evidenceProblems(view: ActionRepoView, key: string, evidence: readonly EvidenceRef[]): string[] {
  const problems: string[] = [];
  if (evidence.length === 0) problems.push(`${key}: no executing evidence registered`);
  for (const ref of evidence) {
    const source = view.read(ref.path);
    if (source === undefined || !view.exists(ref.path)) {
      problems.push(`${key}: missing evidence path ${ref.path}`);
      continue;
    }
    if (ref.cases.length === 0) problems.push(`${key}: evidence ${ref.path} names no test case`);
    const titles = testCaseTitles(ref.path, source);
    for (const title of ref.cases) {
      if (titles.executable.has(title)) continue;
      problems.push(
        titles.placeholders.has(title)
          ? `${key}: evidence case "${title}" in ${ref.path} is a todo/skip placeholder — never credited`
          : `${key}: evidence case "${title}" not found in ${ref.path}`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

const keyOf = (path: string, exportName: string) => `${path} ${exportName}`;

/** Every violation as a `path export: reason` line. Diagnostics carry paths and symbols only. */
export function checkServerActionAuth(view: ActionRepoView, policy: ServerActionPolicy): string[] {
  const failures: string[] = [...exclusionPolicyProblems(policy.exclusions), ...aliasCensusProblems(view)];
  const ownerNames = Object.keys(policy.owners);

  // -- owners: identity, declaration and completion mode, checked BEFORE any call can count.
  const creditable = new Map<string, CompletionMode>();
  const nameByIdentity = new Map<string, string>();
  for (const name of ownerNames) {
    const owner = policy.owners[name];
    const identity = ownerIdentity(owner);
    if (nameByIdentity.has(identity)) {
      failures.push(`owner ${name}: duplicate registration of ${identity}`);
      continue;
    }
    nameByIdentity.set(identity, name);
    if (!owner.reason.trim()) failures.push(`owner ${name}: empty reason`);
    if (!owner.owner.trim()) failures.push(`owner ${name}: empty owner chain`);
    const modulePath = `${owner.module}.ts`;
    const source = view.read(modulePath);
    const census = ownerModuleCensusProblems(view, owner.module);
    for (const problem of census) failures.push(`owner ${name}: ${problem}`);
    const declaration =
      source === undefined ? `stale registration — ${modulePath} does not exist` : ownerDeclarationProblem(modulePath, source, owner);
    if (declaration) failures.push(`owner ${name}: ${declaration}`);
    if (!declaration && census.length === 0) creditable.set(identity, owner.mode);
  }

  // -- discovery
  const inventory = inventoryServerActions(view, creditable);
  failures.push(...inventory.problems);
  if (inventory.modules.size === 0) failures.push("no Server Action modules discovered — the inventory must be non-empty");
  for (const field of ["modules", "runtimeExports", "erasedExports", "inlineDirectives"] as const)
    if (inventory.census[field] !== policy.census[field])
      failures.push(`census drift: discovered ${inventory.census[field]} ${field}, policy pins ${policy.census[field]}`);

  const discovered = new Map<string, Map<string, number> | undefined>();
  for (const [path, analysis] of inventory.modules) {
    for (const entry of analysis.runtimeExports) {
      const invoked = analysis.invocations.get(entry.name);
      if (!invoked) {
        discovered.set(keyOf(path, entry.name), undefined);
        continue;
      }
      const byName = new Map<string, number>();
      for (const [identity, count] of invoked) {
        const name = nameByIdentity.get(identity);
        if (name !== undefined) byName.set(name, count);
      }
      discovered.set(keyOf(path, entry.name), byName);
    }
  }

  // -- classification: discovery keys and registry keys must match EXACTLY.
  const classified = new Map<string, "protected" | "protocol">();
  const usedOwners = new Set<string>();
  const classify = (key: string, as: "protected" | "protocol"): boolean => {
    const prior = classified.get(key);
    if (prior === undefined) {
      classified.set(key, as);
      return true;
    }
    failures.push(prior === as ? `${key}: duplicate registration` : `${key}: registered as both protected and protocol`);
    return false;
  };

  const checkOwnerSet = (key: string, owners: readonly string[], callSites?: Readonly<Record<string, number>>) => {
    const expected = [...new Set(owners)];
    const unknown = expected.filter((name) => !Object.hasOwn(policy.owners, name));
    for (const name of unknown) failures.push(`${key}: unknown owner "${name}" in its expected set`);
    for (const name of expected) usedOwners.add(name);
    if (!discovered.has(key)) {
      failures.push(`${key}: stale registration — no such exported action`);
      return;
    }
    const invoked = discovered.get(key);
    if (!invoked) return; // unsupported export shape: already refused by discovery
    const names = ownerNames.filter((name) => invoked.has(name));
    const missing = expected.filter((name) => !names.includes(name));
    const unexpected = names.filter((name) => !expected.includes(name));
    if (missing.length > 0) failures.push(`${key}: missing expected owner invocation: ${missing.join(", ")}`);
    if (unexpected.length > 0)
      failures.push(`${key}: unexpected registered owner invocation: ${unexpected.join(", ")} — review and update its row`);
    for (const [name, count] of Object.entries(callSites ?? {})) {
      if (!expected.includes(name)) failures.push(`${key}: call-site pin names "${name}", which is not in its owner set`);
      else if ((invoked.get(name) ?? 0) !== count)
        failures.push(`${key}: ${name} has ${invoked.get(name) ?? 0} credited call site(s), row pins ${count}`);
    }
  };

  for (const row of policy.protectedActions) {
    const key = keyOf(row.path, row.exportName);
    if (!classify(key, "protected")) continue;
    const expected = [...new Set(row.owners)];
    if (expected.length === 0) failures.push(`${key}: empty expected owner set`);
    else if (expected.every((name) => policy.owners[name]?.coGuardOnly))
      failures.push(`${key}: ${expected.join(", ")} alone is never sufficient authentication`);
    if (!row.refusal.trim()) failures.push(`${key}: empty refusal`);
    if (row.effects.length === 0 || row.effects.some((effect) => !effect.trim())) failures.push(`${key}: missing protected effects`);
    if (!row.clientIdBinding.trim()) failures.push(`${key}: missing client-ID binding classification`);
    if ((row.inlineRequirements ?? []).some((requirement) => !requirement.trim()))
      failures.push(`${key}: empty inline requirement`);
    failures.push(...evidenceProblems(view, key, row.evidence));
    checkOwnerSet(key, row.owners, row.callSites);
  }

  for (const row of policy.protocolExceptions) {
    const key = keyOf(row.path, row.exportName);
    if (!classify(key, "protocol")) continue;
    if (!row.reason.trim()) failures.push(`${key}: protocol exception has an empty reason`);
    if (!row.protocol.trim()) failures.push(`${key}: protocol exception has an empty protocol description`);
    failures.push(...evidenceProblems(view, key, row.evidence));
    checkOwnerSet(key, row.owners);
  }

  for (const [key, invoked] of discovered) {
    if (classified.has(key)) continue;
    const names = invoked ? ownerNames.filter((name) => invoked.has(name)) : [];
    failures.push(
      names.length === 0
        ? `${key}: unregistered action with no registered owner invocation — add a protected row or a protocol exception`
        : `${key}: unregistered action invoking ${names.join(", ")} — add a protected row`,
    );
  }

  for (const name of ownerNames) if (!usedOwners.has(name)) failures.push(`owner ${name}: unused registration — remove it`);

  return failures;
}

// ---------------------------------------------------------------------------------------------
// Owner registrations (the accepted AIO-1217 owner table; action rows are a later, separate batch)
// ---------------------------------------------------------------------------------------------

const asyncOwner = (module: string, exportName: string, owner: string, reason: string, coGuardOnly = false) =>
  ({ module, exportName, mode: "async", owner, reason, ...(coGuardOnly ? { coGuardOnly } : {}) }) satisfies OwnerRegistration;
const syncPredicate = (module: string, exportName: string, owner: string, reason: string) =>
  ({ module, exportName, mode: "sync", coGuardOnly: true, owner, reason }) satisfies OwnerRegistration;

export const SERVER_ACTION_OWNERS = {
  currentMember: asyncOwner(
    "lib/auth/guard",
    "currentMember",
    "lib/auth/guard.ts → lib/auth/session.ts",
    "Session → active same-team membership with membership-derived posture.",
  ),
  requireTeamAdmin: asyncOwner(
    "lib/auth/guard",
    "requireTeamAdmin",
    "lib/auth/guard.ts → lib/integrations/read.ts:resolveIntegrationsAdmin → lib/auth/admin-access.ts",
    "Session → active same-team member with role=admin and unrestricted membership-derived posture.",
  ),
  getSessionUser: asyncOwner(
    "lib/auth/session",
    "getSessionUser",
    "lib/auth/session.ts",
    "Signed session cookie → auth-account identity. Identity only: no tenant membership.",
  ),
  signOut: asyncOwner(
    "lib/auth/session",
    "signOut",
    "lib/auth/session.ts",
    "Own-cookie protocol: clears the current browser session. Authenticates nobody.",
    true,
  ),
  authorizeGatewayAdmin: asyncOwner(
    "lib/gateway/admin-persistence",
    "authorizeGatewayAdmin",
    "lib/gateway/admin-persistence.ts",
    "Same-connection membership-derived admin check for a supplied auth-user; needs a session identity.",
    true,
  ),
  canWriteStructuredRow: asyncOwner(
    "lib/access/enforce",
    "canWriteStructuredRow",
    "lib/access/enforce.ts",
    "Row writer predicate for a supplied principal. Never authentication by itself.",
    true,
  ),
  canSeeProjectRow: asyncOwner(
    "lib/access/enforce",
    "canSeeProjectRow",
    "lib/access/enforce.ts",
    "Project visibility predicate for a supplied principal. Never authentication by itself.",
    true,
  ),
  visibleItemIds: asyncOwner(
    "lib/access/enforce",
    "visibleItemIds",
    "lib/access/enforce.ts",
    "Oracle item scope for a supplied principal. Never authentication by itself.",
    true,
  ),
  visibleProjectRows: asyncOwner(
    "lib/access/enforce",
    "visibleProjectRows",
    "lib/access/enforce.ts",
    "Writer/destination project scope for a supplied principal. Never authentication by itself.",
    true,
  ),
  getMeetingNote: asyncOwner(
    "lib/meetings/notes",
    "getMeetingNote",
    "lib/meetings/notes.ts",
    "Team-bound note read gated on the viewer's source visibility. Never authentication by itself.",
    true,
  ),
  actorSeesChain: asyncOwner(
    "lib/social/store",
    "actorSeesChain",
    "lib/social/store.ts",
    "Every-evidence chain visibility for a supplied item set. Never authentication by itself.",
    true,
  ),
  resolveArcScope: asyncOwner(
    "lib/graph/partition-read",
    "resolveArcScope",
    "lib/graph/partition-read.ts",
    "Arc partition scope for a supplied principal. Never authentication by itself.",
    true,
  ),
  canEditMemberContext: syncPredicate(
    "lib/identity/context",
    "canEditMemberContext",
    "lib/identity/context.ts",
    "Self-or-role-admin context editor predicate. Never authentication by itself.",
  ),
  canSeeMeetingNotes: syncPredicate(
    "lib/meetings/notes",
    "canSeeMeetingNotes",
    "lib/meetings/notes.ts",
    "Team-posture meeting-notes predicate. Never authentication by itself.",
  ),
  canAccessAdmin: syncPredicate(
    "lib/auth/admin-access",
    "canAccessAdmin",
    "lib/auth/admin-access.ts",
    "Admin authorization predicate (role ∧ unrestricted posture). Never authentication by itself.",
  ),
} as const satisfies Record<string, OwnerRegistration>;

export type ServerActionOwnerName = keyof typeof SERVER_ACTION_OWNERS;
