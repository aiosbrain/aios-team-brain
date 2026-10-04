import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  analyzeRouteSource,
  checkRouteAuth,
  inspectRoutingTree,
  loadRepoView,
  PROTECTED_ROUTES,
  PUBLIC_EXCEPTIONS,
  REGISTERED_GUARDS,
  REPO_ROOT,
  ROUTE_AUTH_POLICY,
  type GuardRegistration,
  type ProtectedRoute,
  type PublicException,
  type RepoView,
} from "./helpers/api-route-auth";

/**
 * AIO-1208 (docs/design/aio1208-route-auth-inventory.md): every explicitly authored App Router
 * route-file handler is classified per method and genuinely INVOKES its expected registered guard
 * set, or carries a method-specific public protocol exception. See the helper's header for exactly
 * what a green run does and does not prove.
 *
 * Every fixture and every mutant below runs the REAL checker. Mutants are copies of real source
 * transformed in an in-memory path→source map — no product file is ever written.
 */

const { repo: REAL, treeProblems: REAL_TREE_PROBLEMS } = loadRepoView();

const P = "app/api/fixture/route.ts";
const Q = "app/api/fixture/other/route.ts";

type GuardName = keyof typeof REGISTERED_GUARDS;
const protect = (path: string, method: ProtectedRoute["method"], ...guards: string[]): ProtectedRoute => ({
  path,
  method,
  guards,
});

interface FixtureOptions {
  exceptions?: PublicException[];
  /** Registrations to check; defaults to the real registrations the rows name. */
  guards?: Record<string, GuardRegistration>;
  /** Paths reported absent. */
  missing?: string[];
  /** Synthetic non-route files (owner modules), overriding the real ones. */
  files?: Record<string, string>;
}

/** Run the real checker over synthetic route sources; owners/evidence resolve against the real repo. */
function check(routes: Record<string, string>, rows: ProtectedRoute[], options: FixtureOptions = {}): string[] {
  const { exceptions = [], missing = [], files = {} } = options;
  const named = new Set(rows.flatMap((entry) => entry.guards));
  const guards =
    options.guards ??
    Object.fromEntries(
      (Object.keys(REGISTERED_GUARDS) as GuardName[])
        .filter((name) => named.has(name))
        .map((name) => [name, REGISTERED_GUARDS[name]]),
    );
  const repo: RepoView = {
    routeSources: new Map(Object.entries(routes)),
    exists: (path) => !missing.includes(path) && (Object.hasOwn(files, path) || REAL.exists(path)),
    read: (path) => (missing.includes(path) ? undefined : Object.hasOwn(files, path) ? files[path] : REAL.read(path)),
  };
  return checkRouteAuth(repo, { guards, protectedRoutes: rows, publicExceptions: exceptions });
}

const NO_INVOCATION = (key: string, expected: string) =>
  `${key}: no registered authentication invocation (expected ${expected})`;

const KEY_IMPORT = `import { authenticateApiKey } from "@/lib/api/auth";\n`;
const guardedGet = `${KEY_IMPORT}
export async function GET(req: Request) {
  const auth = await authenticateApiKey(req);
  if (!auth) return new Response(null, { status: 401 });
  return Response.json({ ok: true });
}
`;
const bareHandler = (method: string) => `
export async function ${method}(_req: Request) {
  return Response.json({ ok: true });
}
`;

describe("route-auth inventory: the real repository", () => {
  it("discovers a non-empty app/ route inventory with no alternate-tree problem (AC-01)", () => {
    expect(REAL_TREE_PROBLEMS).toEqual([]);
    expect(REAL.routeSources.size).toBeGreaterThan(0);
    for (const path of REAL.routeSources.keys()) expect(path).toMatch(/^app\/.*\/route\.ts$/);
  });

  it("classifies every exported handler: discovery keys equal registry keys exactly (AC-01)", () => {
    const discovered: string[] = [];
    const problems: string[] = [];
    for (const [path, source] of REAL.routeSources) {
      const analysis = analyzeRouteSource(path, source);
      problems.push(...analysis.problems);
      for (const method of analysis.methods.keys()) discovered.push(`${path} ${method}`);
    }
    const registered = [...PROTECTED_ROUTES, ...PUBLIC_EXCEPTIONS].map((entry) => `${entry.path} ${entry.method}`);
    expect(problems).toEqual([]);
    expect(discovered.length).toBeGreaterThan(0);
    expect(discovered.sort()).toEqual(registered.sort());
    expect(new Set(registered.map((key) => key.split(" ")[0])).size).toBe(REAL.routeSources.size);
    // Discovery is not limited to /api: the browser auth routes are inventoried too.
    expect(discovered).toContain("app/auth/confirm/route.ts GET");
    expect(discovered).toContain("app/auth/dev-login/route.ts GET");
  });

  it("every protected handler invokes exactly its expected registered guard set — build-failing (AC-13)", () => {
    expect(checkRouteAuth(REAL, ROUTE_AUTH_POLICY)).toEqual([]);
  });

  it("registers only authentication owners — never a limiter, a flag, a serializer or a path helper", () => {
    const names = Object.keys(REGISTERED_GUARDS);
    for (const notAGuard of ["rateLimit", "gatewayDisabled", "safeNextPath", "gatewayError", "resolveAdminTeam"])
      expect(names).not.toContain(notAGuard);
    // The metadata route is authenticated by its owner; it is not a public exception.
    expect(PUBLIC_EXCEPTIONS.map((entry) => entry.path)).not.toContain(
      "app/api/internal/staging-build-metadata/route.ts",
    );
    expect(PUBLIC_EXCEPTIONS.every((entry) => entry.reason.trim() && entry.protocol.trim())).toBe(true);
  });
});

describe("route-auth inventory: filesystem discovery (AC-01)", () => {
  const roots: string[] = [];
  const tree = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "aio1208-route-tree-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("walks the real filesystem, so a never-committed route file is discovered", () => {
    const root = tree({ "app/api/brand-new/route.ts": bareHandler("GET"), "app/page.tsx": "export default null;" });
    const { repo, treeProblems } = loadRepoView(root);
    expect(treeProblems).toEqual([]);
    expect([...repo.routeSources.keys()]).toEqual(["app/api/brand-new/route.ts"]);
    expect(checkRouteAuth(repo, { guards: {}, protectedRoutes: [], publicExceptions: [] })).toEqual([
      "app/api/brand-new/route.ts GET: no registered authentication invocation — unclassified handler; add an expected-guard row or a public protocol exception",
    ]);
  });

  it.each(["tsx", "js", "jsx"])("fails a route.%s Next would serve instead of ignoring it", (extension) => {
    const root = tree({ [`app/api/alt/route.${extension}`]: "export function GET() {}" });
    const { repo, treeProblems } = loadRepoView(root);
    expect(repo.routeSources.size).toBe(0);
    expect(treeProblems).toEqual([
      `app/api/alt/route.${extension}: non-.ts route file — Next serves it, but this repository's inventory covers route.ts only`,
    ]);
  });

  it("fails every alternate routing tree, even an empty one", () => {
    expect(loadRepoView(tree({ "pages/api/hello.ts": "export default () => {}" })).treeProblems).toEqual([
      "pages/api/hello.ts: Pages Router API route — an alternate routing tree is outside the route-auth inventory",
      "pages/api/: alternate routing tree present — outside the route-auth inventory",
    ]);
    expect(loadRepoView(tree({ "src/pages/api/x/y.ts": "" })).treeProblems).toContain(
      "src/pages/api/x/y.ts: Pages Router API route — an alternate routing tree is outside the route-auth inventory",
    );
    expect(loadRepoView(tree({ "src/app/api/x/route.ts": bareHandler("GET") })).treeProblems).toEqual([
      "src/app/api/x/route.ts: src/app routing tree — the route-auth inventory covers app/ only",
      "src/app/: alternate routing tree present — outside the route-auth inventory",
    ]);
    expect(
      inspectRoutingTree({ files: [], directories: ["src", "src/app"], nextConfigs: new Map() }).problems,
    ).toEqual(["src/app/: alternate routing tree present — outside the route-auth inventory"]);
  });

  it("fails a customized pageExtensions, but not prose that merely mentions it", () => {
    const customized = tree({
      "app/api/a/route.ts": bareHandler("GET"),
      "next.config.ts": `export default { pageExtensions: ["api.ts"] };`,
    });
    expect(loadRepoView(customized).treeProblems).toEqual([
      "next.config.ts: pageExtensions is customized — update the route discovery contract first",
    ]);
    const prose = tree({
      "app/api/a/route.ts": bareHandler("GET"),
      "next.config.mjs": `// pageExtensions stays at Next's default\nexport default {};`,
    });
    expect(loadRepoView(prose).treeProblems).toEqual([]);
  });

  it("refuses an empty inventory", () => {
    expect(check({}, [])).toEqual(["no App Router route files discovered — the inventory must be non-empty"]);
  });
});

describe("route-auth checker: new and unguarded handlers (AC-02)", () => {
  it("passes a new guarded handler that has its registry row", () => {
    expect(check({ [P]: guardedGet }, [protect(P, "GET", "authenticateApiKey")])).toEqual([]);
  });

  it("fails a new unguarded route, naming its exact path and method", () => {
    expect(check({ [P]: bareHandler("GET") }, [])).toEqual([
      `${P} GET: no registered authentication invocation — unclassified handler; add an expected-guard row or a public protocol exception`,
    ]);
  });

  it("fails a new unguarded POST on a file whose GET is guarded — for POST only", () => {
    expect(check({ [P]: guardedGet + bareHandler("POST") }, [protect(P, "GET", "authenticateApiKey")])).toEqual([
      `${P} POST: no registered authentication invocation — unclassified handler; add an expected-guard row or a public protocol exception`,
    ]);
    expect(
      check({ [P]: guardedGet + bareHandler("POST") }, [
        protect(P, "GET", "authenticateApiKey"),
        protect(P, "POST", "authenticateApiKey"),
      ]),
    ).toEqual([NO_INVOCATION(`${P} POST`, "authenticateApiKey")]);
  });

  it("fails a new GUARDED method that has no registry row — classification is explicit", () => {
    const source = `${guardedGet}
export async function POST(req: Request) {
  if (!(await authenticateApiKey(req))) return new Response(null, { status: 401 });
  return Response.json({ ok: true });
}
`;
    expect(check({ [P]: source }, [protect(P, "GET", "authenticateApiKey")])).toEqual([
      `${P} POST: unclassified handler invoking authenticateApiKey — add an expected-guard row`,
    ]);
  });

  it("fails a registry row whose handler no longer exists", () => {
    expect(
      check({ [P]: guardedGet }, [protect(P, "GET", "authenticateApiKey"), protect(P, "DELETE", "authenticateApiKey")]),
    ).toEqual([`${P} DELETE: stale registry row — no such exported handler`]);
  });

  it("fails a file that exports no method handler at all", () => {
    expect(check({ [P]: `export const runtime = "nodejs";\n` }, [])).toEqual([
      `${P}: no exported HTTP method handler — a route file must be classifiable`,
    ]);
  });
});

describe("route-auth checker: export shapes cannot evade the inventory (AC-01)", () => {
  const shape = (source: string) => check({ [P]: source }, []);
  const unsupported = (name: string, kind: string) =>
    `${P} ${name}: unsupported export shape (${kind}) — export the handler as a function`;

  it("fails export-star", () => {
    expect(shape(`export * from "./handlers";\n`)).toEqual([
      `${P}: unsupported export shape (export * from) — re-exported HTTP methods cannot be inventoried`,
    ]);
  });

  it("fails a named re-export alias", () => {
    expect(shape(`export { h as GET } from "./handlers";\n`)).toEqual([unsupported("GET", "re-export")]);
  });

  it("fails a local export specifier — export { GET }", () => {
    expect(shape(`${KEY_IMPORT}async function GET(req: Request) {\n  return authenticateApiKey(req);\n}\nexport { GET };\n`)).toEqual([
      unsupported("GET", "export specifier"),
    ]);
  });

  it("fails a local export alias — export { handler as GET }", () => {
    expect(
      shape(`${KEY_IMPORT}async function handler(req: Request) {\n  return authenticateApiKey(req);\n}\nexport { handler as GET };\n`),
    ).toEqual([unsupported("GET", "export specifier")]);
  });

  it("fails a destructured export — export const { GET, POST } = handlers", () => {
    expect(shape(`import { handlers } from "./handlers";\nexport const { GET, POST } = handlers;\n`)).toEqual([
      unsupported("GET", "destructured export"),
      unsupported("POST", "destructured export"),
    ]);
  });

  it("fails an exported binding that is not a function literal", () => {
    expect(shape(`import { handler } from "./handlers";\nexport const GET = handler;\n`)).toEqual([
      unsupported("GET", "exported binding is not a function literal"),
    ]);
    expect(shape(`import { withAuth } from "./wrap";\nexport const POST = withAuth(async () => new Response());\n`)).toEqual([
      unsupported("POST", "exported binding is not a function literal"),
    ]);
  });

  it("fails an overload signature and an HTTP-named non-function export", () => {
    const overloaded = `${KEY_IMPORT}
export function GET(req: Request): Promise<Response>;
export async function GET(req: Request) {
  if (!(await authenticateApiKey(req))) return new Response(null, { status: 401 });
  return new Response();
}
`;
    expect(check({ [P]: overloaded }, [protect(P, "GET", "authenticateApiKey")])).toEqual([
      unsupported("GET", "overload signature"),
    ]);
    expect(shape(`export class DELETE {}\n`)).toEqual([unsupported("DELETE", "not a function")]);
  });

  it("refuses a source that does not parse", () => {
    expect(shape(`export async function GET( {\n`)).toEqual([`${P}: parse error — route source cannot be inventoried`]);
  });

  it("supports a straightforward exported const arrow and function expression", () => {
    const source = `${KEY_IMPORT}import { governedActionHttp } from "@/lib/actions/governed/http";
export const GET = async (req: Request) => {
  if (!(await authenticateApiKey(req))) return new Response(null, { status: 401 });
  return new Response();
};
export const PUT = async function (req: Request) {
  if (!(await authenticateApiKey(req))) return new Response(null, { status: 401 });
  return new Response();
};
export const POST = (req: Request) => governedActionHttp.submit(req);
`;
    expect(
      check({ [P]: source }, [
        protect(P, "GET", "authenticateApiKey"),
        protect(P, "PUT", "authenticateApiKey"),
        protect(P, "POST", "governedActionHttp.submit"),
      ]),
    ).toEqual([]);
  });
});

describe("route-auth checker: a guard counts only when genuinely invoked (AC-03)", () => {
  const rows = [protect(P, "GET", "authenticateApiKey")];
  const refused = [NO_INVOCATION(`${P} GET`, "authenticateApiKey")];
  const handler = (body: string, prelude = KEY_IMPORT) => `${prelude}
export async function GET(req: Request) {
${body}
  return Response.json({ ok: true });
}
`;

  it.each([
    ["an import that is never called", handler(`  void req;`)],
    ["a comment naming the guard", handler(`  // const auth = await authenticateApiKey(req);\n  void req;`)],
    ["a string naming the guard", handler(`  const note = "await authenticateApiKey(req)";\n  void note;`)],
    ["a type reference", handler(`  type Auth = Awaited<ReturnType<typeof authenticateApiKey>>;\n  const auth = null as Auth | null;\n  void auth;`)],
    [
      "an unused top-level helper that calls the guard",
      handler(`  void req;`, `${KEY_IMPORT}async function requireKey(req: Request) {\n  return authenticateApiKey(req);\n}\n`),
    ],
    ["a nested helper that is defined but never called", handler(`  const requireKey = async () => authenticateApiKey(req);\n  void requireKey;`)],
    ["a nested callback handed to something else", handler(`  const pending = [req].map((r) => authenticateApiKey(r));\n  void pending;`)],
    ["the guard passed as a value, not called", handler(`  const fn = authenticateApiKey;\n  void fn;`)],
    [
      "a same-spelled local function with no import",
      handler(`  const auth = await authenticateApiKey(req);\n  void auth;`, `async function authenticateApiKey(_req: Request) {\n  return { ok: true };\n}\n`),
    ],
    [
      "the import shadowed by a local const",
      handler(`  const authenticateApiKey = async (_r: Request) => ({ ok: true });\n  const auth = await authenticateApiKey(req);\n  void auth;`),
    ],
    [
      "the import shadowed by a var hoisted from a nested block",
      handler(`  if (req.method) {\n    var authenticateApiKey = async (_r: Request) => ({ ok: true });\n  }\n  const auth = await authenticateApiKey(req);\n  void auth;`),
    ],
    [
      "the guard's spelling imported from another module",
      handler(`  const auth = await authenticateApiKey(req);\n  void auth;`, `import { authenticateApiKey } from "@/lib/api/not-auth";\n`),
    ],
    [
      "another export aliased to the guard's spelling",
      handler(`  const auth = await authenticateApiKey(req);\n  void auth;`, `import { isAgentBearer as authenticateApiKey } from "@/lib/api/auth";\n`),
    ],
    [
      "a type-only import",
      handler(`  const auth = await authenticateApiKey(req);\n  void auth;`, `import type { authenticateApiKey } from "@/lib/api/auth";\n`),
    ],
    ["a namespace import (unsupported — fails closed)", handler(`  const result = await auth.authenticateApiKey(req);\n  void result;`, `import * as auth from "@/lib/api/auth";\n`)],
    ["a syntactically dead branch", handler(`  if (false) await authenticateApiKey(req);\n  false && (await authenticateApiKey(req));`)],
    ["a call after an unconditional return", `${KEY_IMPORT}\nexport async function GET(req: Request) {\n  return Response.json({ ok: true });\n  await authenticateApiKey(req);\n}\n`],
    ["only a limiter and a feature flag", handler(`  if (!(await rateLimit(req))) return gatewayDisabled();`, `${KEY_IMPORT}import { rateLimit } from "@/lib/api/rate-limit";\nimport { gatewayDisabled } from "@/lib/gateway/http";\n`)],
  ])("does not count %s", (_name, source) => {
    expect(check({ [P]: source }, rows)).toEqual(refused);
  });

  it("does not count the import shadowed by a parameter", () => {
    const source = `${KEY_IMPORT}
export async function GET(req: Request, authenticateApiKey: (r: Request) => Promise<unknown>) {
  const auth = await authenticateApiKey(req);
  return Response.json({ ok: !!auth });
}
`;
    expect(check({ [P]: source }, rows)).toEqual(refused);
  });

  it("counts a named import alias that is really called", () => {
    const source = `import { authenticateApiKey as requireKey } from "@/lib/api/auth";
export async function GET(req: Request) {
  const auth = await requireKey(req);
  if (!auth) return new Response(null, { status: 401 });
  return Response.json({ ok: true });
}
`;
    expect(check({ [P]: source }, rows)).toEqual([]);
  });

  it("counts a guard called inside try, a live branch and a ternary", () => {
    const source = `import { authenticateApiKey, authenticateAgentToken, isAgentBearer } from "@/lib/api/auth";
export async function POST(req: Request) {
  try {
    const delegated = isAgentBearer(req);
    const agent = delegated ? await authenticateAgentToken(req) : null;
    const member = delegated ? null : await authenticateApiKey(req);
    if (!(agent ?? member)) return new Response(null, { status: 401 });
    return Response.json({ ok: true });
  } catch {
    return new Response(null, { status: 500 });
  }
}
`;
    expect(check({ [P]: source }, [protect(P, "POST", "authenticateApiKey", "authenticateAgentToken")])).toEqual([]);
  });

  it("fails the exact expected set when a delegated-branch guard is removed", () => {
    expect(check({ [P]: guardedGet }, [protect(P, "GET", "authenticateApiKey", "authenticateAgentToken")])).toEqual([
      `${P} GET: missing expected guard invocation: authenticateAgentToken`,
    ]);
  });

  it("fails the exact expected set when an authorization co-guard is removed", () => {
    const source = `import { getSessionUser } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/admin-access";
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response(null, { status: 401 });
  return Response.json({ ok: true });
}
`;
    expect(check({ [P]: source }, [protect(P, "GET", "getSessionUser", "canAccessAdmin")])).toEqual([
      `${P} GET: missing expected guard invocation: canAccessAdmin`,
    ]);
  });

  it("fails an invocation the registry row does not expect — equality, not a subset", () => {
    const source = `${KEY_IMPORT}import { getSessionUser } from "@/lib/auth/session";
export async function GET(req: Request) {
  const auth = (await authenticateApiKey(req)) ?? (await getSessionUser());
  if (!auth) return new Response(null, { status: 401 });
  return Response.json({ ok: true });
}
`;
    const session = `import { getSessionUser } from "@/lib/auth/session";
export async function GET() {
  return Response.json({ ok: !!(await getSessionUser()) });
}
`;
    expect(
      check({ [P]: source, [Q]: session }, [protect(P, "GET", "authenticateApiKey"), protect(Q, "GET", "getSessionUser")]),
    ).toEqual([`${P} GET: unexpected registered guard invocation: getSessionUser — review and update its registry row`]);
  });

  it("never accepts canAccessAdmin alone as authentication", () => {
    const source = `import { canAccessAdmin } from "@/lib/auth/admin-access";
export async function GET() {
  if (!canAccessAdmin({ role: "admin", tier: "team" })) return new Response(null, { status: 404 });
  return Response.json({ ok: true });
}
`;
    expect(check({ [P]: source }, [protect(P, "GET", "canAccessAdmin")])).toEqual([
      `${P} GET: canAccessAdmin alone is never sufficient authentication`,
    ]);
  });

  it("resolves the destructured dynamic import of canAccessAdmin by module identity", () => {
    const media = (source: string) => `import { currentMember } from "@/lib/auth/guard";
export async function GET() {
  const member = await currentMember("team");
  ${source}
  if (!member || !canAccessAdmin(member)) return new Response("not found", { status: 404 });
  return new Response("ok");
}
`;
    const rowsFor = [protect(P, "GET", "currentMember", "canAccessAdmin")];
    expect(check({ [P]: media(`const { canAccessAdmin } = await import("@/lib/auth/admin-access");`) }, rowsFor)).toEqual([]);
    expect(
      check({ [P]: media(`const { canAccessAdmin: allow } = await import("@/lib/auth/admin-access");\n  const canAccessAdmin = allow;`) }, rowsFor),
    ).toEqual([`${P} GET: missing expected guard invocation: canAccessAdmin`]);
    expect(check({ [P]: media(`const { canAccessAdmin } = await import("@/lib/auth/not-admin-access");`) }, rowsFor)).toEqual([
      `${P} GET: missing expected guard invocation: canAccessAdmin`,
    ]);
    expect(check({ [P]: media(`const { canAccessAdmin } = { canAccessAdmin: () => true };`) }, rowsFor)).toEqual([
      `${P} GET: missing expected guard invocation: canAccessAdmin`,
    ]);
  });
});

describe("route-auth checker: called local helpers and registered wrappers (AC-04)", () => {
  const inspector = (helperBody: string, getBody = `  const gate = await resolveAdminTeam();`) => `import { getSessionUser } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/admin-access";

async function resolveAdminTeam() {
${helperBody}
  return { teamId: "t" };
}

export async function GET() {
${getBody}
  return Response.json({ ok: true });
}

export async function POST() {
  const gate = await resolveAdminTeam();
  return Response.json(gate);
}
`;
  const fullHelper = `  const user = await getSessionUser();
  if (!user) return { error: 401 };
  if (!canAccessAdmin({ role: "admin", tier: "team" })) return { error: 403 };`;
  const rows = [protect(P, "GET", "getSessionUser", "canAccessAdmin"), protect(P, "POST", "getSessionUser", "canAccessAdmin")];

  it("follows an explicitly called local helper to its real guards", () => {
    expect(check({ [P]: inspector(fullHelper) }, rows)).toEqual([]);
  });

  it("fails BOTH methods once the helper's inner session guard is removed", () => {
    const withoutSession = `  if (!canAccessAdmin({ role: "admin", tier: "team" })) return { error: 403 };`;
    expect(check({ [P]: inspector(withoutSession) }, rows)).toEqual([
      `${P} GET: missing expected guard invocation: getSessionUser`,
      `${P} POST: missing expected guard invocation: getSessionUser`,
    ]);
  });

  it("does not credit a method that never calls the helper", () => {
    expect(check({ [P]: inspector(fullHelper, `  const gate = { teamId: "t" };\n  void gate;`) }, rows)).toEqual([
      NO_INVOCATION(`${P} GET`, "getSessionUser, canAccessAdmin"),
    ]);
  });

  it("terminates on mutually recursive helpers and still finds the guard", () => {
    const cyclic = (guard: string) => `${KEY_IMPORT}
async function first(req: Request, depth: number): Promise<unknown> {
  return depth > 3 ? null : second(req, depth + 1);
}
async function second(req: Request, depth: number): Promise<unknown> {
${guard}
  return first(req, depth + 1);
}
export async function GET(req: Request) {
  return Response.json({ ok: !!(await first(req, 0)) });
}
`;
    expect(check({ [P]: cyclic(`  if (!(await authenticateApiKey(req))) return null;`) }, [protect(P, "GET", "authenticateApiKey")])).toEqual([]);
    expect(check({ [P]: cyclic(`  void req;`) }, [protect(P, "GET", "authenticateApiKey")])).toEqual([
      NO_INVOCATION(`${P} GET`, "authenticateApiKey"),
    ]);
  });

  it("requires a real governedActionHttp member call on the import from its exact owner", () => {
    const status = (prelude: string, body: string) => `${prelude}
export async function GET(req: Request, { params }: { params: Promise<{ action_id: string }> }) {
${body}
}
`;
    const owner = `import { governedActionHttp } from "@/lib/actions/governed/http";`;
    const call = `  return governedActionHttp.status(req, (await params).action_id);`;
    const rowsFor = [protect(P, "GET", "governedActionHttp.status")];
    const refused = [NO_INVOCATION(`${P} GET`, "governedActionHttp.status")];

    expect(check({ [P]: status(owner, call) }, rowsFor)).toEqual([]);
    expect(check({ [P]: status(owner, `  void params;\n  return new Response(String(req.url));`) }, rowsFor)).toEqual(refused);
    expect(check({ [P]: status(`import { governedActionHttp } from "@/lib/actions/other/http";`, call) }, rowsFor)).toEqual(refused);
    expect(
      check({ [P]: status(`const governedActionHttp = { status: async (_r: Request, _id: string) => new Response() };`, call) }, rowsFor),
    ).toEqual(refused);
    expect(check({ [P]: status(owner, `  void params;\n  return governedActionHttp["status"](req, "x");`) }, rowsFor)).toEqual(refused);
  });

  it("distinguishes the submit member from the status member", () => {
    const owner = `import { governedActionHttp } from "@/lib/actions/governed/http";`;
    const routes = {
      [P]: `${owner}\nexport async function GET(req: Request) {\n  return governedActionHttp.submit(req);\n}\n`,
      [Q]: `${owner}\nexport async function POST(req: Request) {\n  return governedActionHttp.submit(req);\n}\n`,
    };
    expect(check(routes, [protect(P, "GET", "governedActionHttp.status"), protect(Q, "POST", "governedActionHttp.submit")])).toEqual([
      `${P} GET: missing expected guard invocation: governedActionHttp.status`,
      `${P} GET: unexpected registered guard invocation: governedActionHttp.submit — review and update its registry row`,
    ]);
  });

  it("requires the metadata wrapper to be called, not imported", () => {
    const owner = `import { stagingBuildMetadataResponse } from "@/lib/staging/build-metadata";`;
    const rowsFor = [protect(P, "GET", "stagingBuildMetadataResponse")];
    expect(check({ [P]: `${owner}\nexport function GET(request: Request): Response {\n  return stagingBuildMetadataResponse(request);\n}\n` }, rowsFor)).toEqual([]);
    expect(check({ [P]: `${owner}\nexport function GET(request: Request): Response {\n  return Response.json({ url: request.url });\n}\n` }, rowsFor)).toEqual([
      NO_INVOCATION(`${P} GET`, "stagingBuildMetadataResponse"),
    ]);
  });
});

describe("route-auth checker: wrapper registrations are an explicit, evidenced trust decision (AC-04)", () => {
  const rows = [protect(P, "GET", "authenticateApiKey")];
  const apiKey = REGISTERED_GUARDS.authenticateApiKey;

  it("fails a registration whose owner module is gone or no longer exports the entry point", () => {
    expect(check({ [P]: guardedGet }, rows, { missing: ["lib/api/auth.ts"] })).toEqual([
      "guard authenticateApiKey: stale registration — lib/api/auth.ts does not exist",
    ]);
    expect(check({ [P]: guardedGet }, rows, { files: { "lib/api/auth.ts": "export const somethingElse = 1;\n" } })).toEqual([
      "guard authenticateApiKey: stale registration — lib/api/auth.ts no longer exports it",
    ]);
  });

  it("fails a member registration once the owner stops declaring that member", () => {
    const route = `import { governedActionHttp } from "@/lib/actions/governed/http";\nexport async function POST(req: Request) {\n  return governedActionHttp.submit(req);\n}\n`;
    expect(
      check({ [P]: route }, [protect(P, "POST", "governedActionHttp.submit")], {
        files: { "lib/actions/governed/http.ts": "export const governedActionHttp = { status() {} };\n" },
      }),
    ).toEqual(["guard governedActionHttp.submit: stale registration — lib/actions/governed/http.ts no longer exports it"]);
  });

  it("fails stale or absent denial evidence, and an empty reason", () => {
    expect(check({ [P]: guardedGet }, rows, { missing: ["test/api-auth-team-header.test.ts"] })).toEqual([
      "guard authenticateApiKey: stale evidence path test/api-auth-team-header.test.ts",
    ]);
    expect(check({ [P]: guardedGet }, rows, { guards: { authenticateApiKey: { ...apiKey, evidence: [] } } })).toEqual([
      "guard authenticateApiKey: no denial evidence registered",
    ]);
    expect(check({ [P]: guardedGet }, rows, { guards: { authenticateApiKey: { ...apiKey, reason: "  " } } })).toEqual([
      "guard authenticateApiKey: empty reason",
    ]);
  });

  it("fails an unused registration so bypass entries cannot accumulate", () => {
    expect(
      check({ [P]: guardedGet }, rows, {
        guards: { authenticateApiKey: apiKey, getSessionUser: REGISTERED_GUARDS.getSessionUser },
      }),
    ).toEqual(["guard getSessionUser: unused registration — remove it"]);
  });

  it("fails a row that names an unregistered symbol, and a duplicate registration", () => {
    const limited = `import { rateLimit } from "@/lib/api/rate-limit";\nexport async function GET(req: Request) {\n  return Response.json({ ok: await rateLimit(req) });\n}\n`;
    expect(check({ [P]: limited }, [protect(P, "GET", "rateLimit")])).toEqual([
      `${P} GET: unknown guard "rateLimit" in its expected set`,
      NO_INVOCATION(`${P} GET`, "rateLimit"),
    ]);
    expect(check({ [P]: guardedGet }, rows, { guards: { authenticateApiKey: apiKey, alias: apiKey } })).toContain(
      "guard alias: duplicate registration of lib/api/auth#authenticateApiKey",
    );
  });
});

describe("route-auth checker: public protocol exceptions (AC-05)", () => {
  const exception = (over: Partial<PublicException> = {}): PublicException => ({
    path: P,
    method: "POST",
    reason: "Obtains a session by proving a password.",
    protocol: "Credential verified before any session is signed.",
    evidence: ["test/http/auth.http.test.ts"],
    ...over,
  });
  const publicPost = bareHandler("POST");

  it("accepts an exact path+method exception with a reason, a protocol and existing evidence", () => {
    expect(check({ [P]: publicPost }, [], { exceptions: [exception()] })).toEqual([]);
  });

  it("fails an exception whose file or method no longer exists", () => {
    expect(check({ [Q]: guardedGet }, [protect(Q, "GET", "authenticateApiKey")], { exceptions: [exception()] })).toEqual([
      `${P} POST: stale public exception — no such exported handler`,
    ]);
    expect(check({ [P]: guardedGet }, [protect(P, "GET", "authenticateApiKey")], { exceptions: [exception()] })).toEqual([
      `${P} POST: stale public exception — no such exported handler`,
    ]);
  });

  it("requires a newly exported method at an excepted path to be classified separately", () => {
    expect(check({ [P]: publicPost + bareHandler("GET") }, [], { exceptions: [exception()] })).toEqual([
      `${P} GET: no registered authentication invocation — unclassified handler; add an expected-guard row or a public protocol exception`,
    ]);
  });

  it("fails an empty reason, an empty protocol, missing evidence and stale evidence", () => {
    expect(check({ [P]: publicPost }, [], { exceptions: [exception({ reason: " " })] })).toEqual([
      `${P} POST: public exception has an empty reason`,
    ]);
    expect(check({ [P]: publicPost }, [], { exceptions: [exception({ protocol: "" })] })).toEqual([
      `${P} POST: public exception has an empty protocol description`,
    ]);
    expect(check({ [P]: publicPost }, [], { exceptions: [exception({ evidence: [] })] })).toEqual([
      `${P} POST: public exception has no evidence`,
    ]);
    expect(check({ [P]: publicPost }, [], { exceptions: [exception({ evidence: ["test/http/gone.http.test.ts"] })] })).toEqual([
      `${P} POST: stale evidence path test/http/gone.http.test.ts`,
    ]);
  });

  it("fails duplicate and conflicting entries", () => {
    expect(check({ [P]: publicPost }, [], { exceptions: [exception(), exception()] })).toEqual([
      `${P} POST: duplicate classification`,
    ]);
    const guardedPost = `${KEY_IMPORT}export async function POST(req: Request) {\n  return Response.json({ ok: !!(await authenticateApiKey(req)) });\n}\n`;
    expect(check({ [P]: guardedPost }, [protect(P, "POST", "authenticateApiKey")], { exceptions: [exception()] })).toEqual([
      `${P} POST: classified as both protected and public`,
    ]);
    expect(
      check({ [P]: guardedPost }, [protect(P, "POST", "authenticateApiKey"), protect(P, "POST", "authenticateApiKey")]),
    ).toEqual([`${P} POST: duplicate classification`]);
  });

  it("holds for the real exception set: one method each, every path and evidence file present", () => {
    for (const entry of PUBLIC_EXCEPTIONS) {
      expect(REAL.routeSources.has(entry.path), entry.path).toBe(true);
      expect(entry.evidence.length, entry.path).toBeGreaterThan(0);
      for (const evidence of entry.evidence) expect(REAL.exists(evidence), evidence).toBe(true);
    }
    expect(new Set(PUBLIC_EXCEPTIONS.map((entry) => entry.path)).size).toBe(PUBLIC_EXCEPTIONS.length);
  });
});

describe("route-auth checker: real-source mutants, in memory only (AC-03, AC-04)", () => {
  /** A copy of the real inventory with ONE occurrence of `needle` in `path` replaced. */
  function mutant(path: string, needle: string, replacement: string, occurrence: "only" | "last" = "only"): RepoView {
    const source = REAL.routeSources.get(path);
    if (source === undefined) throw new Error(`mutant target is not in the inventory: ${path}`);
    const count = source.split(needle).length - 1;
    if (count === 0 || (occurrence === "only" && count !== 1))
      throw new Error(`mutant needle occurs ${count}x in ${path} — the mutation would be vacuous or ambiguous`);
    const at = occurrence === "last" ? source.lastIndexOf(needle) : source.indexOf(needle);
    const routeSources = new Map(REAL.routeSources);
    routeSources.set(path, source.slice(0, at) + replacement + source.slice(at + needle.length));
    return { ...REAL, routeSources };
  }
  const run = (repo: RepoView) => checkRouteAuth(repo, ROUTE_AUTH_POLICY);

  const ADMIN = "app/api/internal/executor-gateway/v1/admin/[teamSlug]";
  const INSPECT = "app/api/dashboard/access/inspect/route.ts";
  const MEDIA = "app/api/dashboard/social/media/[id]/route.ts";

  it("passes an unchanged in-memory copy of the real inventory", () => {
    expect(run({ ...REAL, routeSources: new Map(REAL.routeSources) })).toEqual([]);
  });

  it("fails when authenticateApiKey is removed from a representative v1 handler (its import stays)", () => {
    const path = "app/api/v1/projects/route.ts";
    const repo = mutant(path, "await authenticateApiKey(req)", "null");
    expect(repo.routeSources.get(path)).toContain(`import { authenticateApiKey } from "@/lib/api/auth"`);
    expect(run(repo)).toEqual([NO_INVOCATION(`${path} GET`, "authenticateApiKey")]);
  });

  it("fails only the mutated method when gatewayAdminContext is removed from one admin operation", () => {
    const path = `${ADMIN}/policies/route.ts`;
    expect(run(mutant(path, "await gatewayAdminContext((await params).teamSlug)", "null", "last"))).toEqual([
      NO_INVOCATION(`${path} POST`, "gatewayAdminContext"),
    ]);
  });

  it("fails GET and POST when getSessionUser is removed from the called local resolveAdminTeam", () => {
    expect(run(mutant(INSPECT, "await getSessionUser()", "null"))).toEqual([
      `${INSPECT} GET: missing expected guard invocation: getSessionUser`,
      `${INSPECT} POST: missing expected guard invocation: getSessionUser`,
    ]);
  });

  it("fails when the canAccessAdmin co-guard is removed from the inspector and from media", () => {
    expect(run(mutant(INSPECT, "!canAccessAdmin(", "!Boolean("))).toEqual([
      `${INSPECT} GET: missing expected guard invocation: canAccessAdmin`,
      `${INSPECT} POST: missing expected guard invocation: canAccessAdmin`,
    ]);
    expect(run(mutant(MEDIA, "!canAccessAdmin(member)", "!Boolean(member)"))).toEqual([
      `${MEDIA} GET: missing expected guard invocation: canAccessAdmin`,
    ]);
  });

  it.each([
    ["app/api/v1/items/route.ts", "GET"],
    ["app/api/v1/query/route.ts", "POST"],
    ["app/api/v1/evidence/search/route.ts", "POST"],
  ])("fails %s %s when its delegated authenticateAgentToken branch is removed", (path, method) => {
    expect(run(mutant(path, "await authenticateAgentToken(req)", "null"))).toEqual([
      `${path} ${method}: missing expected guard invocation: authenticateAgentToken`,
    ]);
  });

  it("left every product file on disk untouched", () => {
    for (const [path, source] of REAL.routeSources) expect(readFileSync(join(REPO_ROOT, path), "utf8"), path).toBe(source);
  });
});
