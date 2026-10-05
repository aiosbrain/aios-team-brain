import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { hasUseServerDirective } from "./entry-surface-graph";
import {
  aliasCensusProblems,
  analyzeActionModule,
  checkServerActionAuth,
  discoverSourceTree,
  exclusionPolicyProblems,
  inventoryServerActions,
  loadActionRepoView,
  ownerDeclarationProblem,
  ownerIdentity,
  ownerModes,
  ownerModuleCensusProblems,
  scanSource,
  SERVER_ACTION_EXCLUSIONS,
  SERVER_ACTION_OWNERS,
  SERVER_ACTION_SOURCE_EXT,
  testCaseTitles,
  type ActionRepoView,
  type CompletionMode,
  type ExclusionPolicy,
  type OwnerRegistration,
  type ProtectedAction,
  type ProtocolException,
  type ServerActionOwnerName,
  type ServerActionPolicy,
} from "./helpers/server-action-auth";

/**
 * AIO-1217: the finite Server Action discovery and invocation checker. See the helper's header for
 * exactly what a green run does and does not prove.
 *
 * This file covers the analyzer itself — filesystem discovery, directive forms, export shapes, the
 * admitted and refused invocation/completion syntax, and the policy check over a small synthetic
 * registry — plus the current-source census and owner declarations. The reviewed 96-row production
 * registry and its executing evidence are a separate batch and are listed as `todo` at the end;
 * nothing here stands in for them.
 *
 * Every fixture and mutant runs the REAL checker over in-memory source or an isolated temporary
 * root. Real-source mutants transform a copy of the source; no product file is ever written.
 */

const REAL = loadActionRepoView();
const OWNER_MODES = ownerModes(SERVER_ACTION_OWNERS);
const OWNER_NAME = new Map(
  (Object.keys(SERVER_ACTION_OWNERS) as ServerActionOwnerName[]).map(
    (name) => [ownerIdentity(SERVER_ACTION_OWNERS[name]), name] as const,
  ),
);
const REAL_INVENTORY = inventoryServerActions(REAL, OWNER_MODES);

const A = "app/t/[team]/fixture/actions.ts";

/** Owner name → credited call sites for one export of an action module. */
function credit(
  source: string,
  exportName = "act",
  path = A,
  modes: ReadonlyMap<string, CompletionMode> = OWNER_MODES,
): Record<string, number> {
  const invoked = analyzeActionModule(path, source, modes).invocations.get(exportName);
  if (!invoked) throw new Error(`${path} ${exportName}: not a supported action export`);
  return Object.fromEntries([...invoked].map(([identity, count]) => [OWNER_NAME.get(identity) ?? identity, count]));
}

/** Replace exactly one occurrence, refusing a mutation that would silently change nothing. */
function mutate(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`mutation target not found: ${from}`);
  return source.replace(from, () => to);
}

const realSource = (path: string): string => {
  const source = REAL.sources.get(path);
  if (source === undefined) throw new Error(`${path}: not discovered`);
  return source;
};

const expectFailure = (failures: readonly string[], ...fragments: string[]) =>
  expect(failures.filter((line) => fragments.every((fragment) => line.includes(fragment)))).not.toEqual([]);

// ---------------------------------------------------------------------------------------------
// The real repository
// ---------------------------------------------------------------------------------------------

/** The accepted spec's per-module runtime export counts (20 modules, 96 exports). */
const EXPECTED_MODULES: Record<string, number> = {
  "app/actions/account.ts": 2,
  "app/actions/decisions.ts": 2,
  "app/actions/meeting-todos.ts": 2,
  "app/actions/projects.ts": 1,
  "app/actions/tasks.ts": 3,
  "app/auth/welcome/actions.ts": 1,
  "app/t/[team]/admin/access/actions.ts": 1,
  "app/t/[team]/admin/actions.ts": 4,
  "app/t/[team]/admin/agents/actions.ts": 2,
  "app/t/[team]/admin/approvals/actions.ts": 2,
  "app/t/[team]/admin/attribution/actions.ts": 4,
  "app/t/[team]/admin/brand/actions.ts": 3,
  "app/t/[team]/admin/integrations/actions.ts": 25,
  "app/t/[team]/admin/members/actions.ts": 12,
  "app/t/[team]/admin/pm-sync/actions.ts": 2,
  "app/t/[team]/admin/policies/actions.ts": 3,
  "app/t/[team]/codebases/[slug]/actions.ts": 1,
  "app/t/[team]/meetings/actions.ts": 5,
  "app/t/[team]/people/[handle]/actions.ts": 8,
  "app/t/[team]/social/actions.ts": 13,
};

describe("server-action inventory: the real repository", () => {
  it("discovers every first-party source with no symlink, parse or location problem (AC-01)", () => {
    expect(REAL.discoveryProblems).toEqual([]);
    expect(REAL_INVENTORY.problems).toEqual([]);
    expect(REAL.sources.size).toBeGreaterThan(1000);
  });

  it("reconciles the current census: 20 modules, 96 runtime exports, 13 erased, 0 inline (AC-01)", () => {
    const counts = Object.fromEntries(
      [...REAL_INVENTORY.modules].map(([path, analysis]) => [path, analysis.runtimeExports.length]),
    );
    expect(counts).toEqual(EXPECTED_MODULES);
    expect(REAL_INVENTORY.census).toEqual({ modules: 20, runtimeExports: 96, erasedExports: 13, inlineDirectives: 0 });
    expect(REAL_INVENTORY.inline).toEqual([]);
  });

  it("finds every current action in the one supported shape: an async function declaration", () => {
    const shapes = new Set<string>();
    for (const analysis of REAL_INVENTORY.modules.values())
      for (const entry of analysis.runtimeExports) shapes.add(`${entry.shape}:${entry.supported}`);
    expect([...shapes]).toEqual(["async function declaration:true"]);
  });

  it("pins the exclusion list literally, with a reason each", () => {
    expect(SERVER_ACTION_EXCLUSIONS.rootNames.map((entry) => entry.name)).toEqual([
      "node_modules",
      ".next",
      ".git",
      ".context",
      "coverage",
      "out",
      "build",
      ".yarn",
      ".vercel",
      ".pnp",
      ".aios",
      "supabase",
      "tmp",
      ".staging-pair-artifacts",
      ".staging-ops-reaper-checks",
    ]);
    expect(SERVER_ACTION_EXCLUSIONS.rootFilePrefixes.map((entry) => entry.name)).toEqual([".pnp."]);
    expect(SERVER_ACTION_EXCLUSIONS.nestedPaths.map((entry) => entry.name)).toEqual([
      "ingestion/.venv",
      "ingestion/.pytest_cache",
    ]);
    expect(SERVER_ACTION_EXCLUSIONS.nestedNames.map((entry) => `${entry.under}/**/${entry.name}`)).toEqual([
      "ingestion/**/__pycache__",
    ]);
    expect(exclusionPolicyProblems(SERVER_ACTION_EXCLUSIONS)).toEqual([]);
  });

  it("verifies every registered owner's declaration and completion mode, and the @/ alias", () => {
    expect(aliasCensusProblems(REAL)).toEqual([]);
    const problems: string[] = [];
    for (const [name, owner] of Object.entries(SERVER_ACTION_OWNERS) as [string, OwnerRegistration][]) {
      const path = `${owner.module}.ts`;
      const source = REAL.read(path);
      const problem = source === undefined ? `${path} does not exist` : ownerDeclarationProblem(path, source, owner);
      if (problem) problems.push(`${name}: ${problem}`);
      problems.push(...ownerModuleCensusProblems(REAL, owner.module).map((line) => `${name}: ${line}`));
    }
    expect(problems).toEqual([]);
    expect(
      Object.entries(SERVER_ACTION_OWNERS)
        .filter(([, owner]) => owner.mode === "sync")
        .map(([name]) => name)
        .sort(),
    ).toEqual(["canAccessAdmin", "canEditMemberContext", "canSeeMeetingNotes"]);
  });

  // Admitted controls on unchanged production source: a reject-everything analyzer cannot pass these.
  it.each([
    ["app/t/[team]/admin/agents/actions.ts", "mintAgentTokenAction", { requireTeamAdmin: 1, visibleProjectRows: 2 }],
    ["app/t/[team]/admin/members/actions.ts", "linkMemberIdentity", { requireTeamAdmin: 1 }],
    ["app/t/[team]/admin/members/actions.ts", "linkMemberSlack", { requireTeamAdmin: 1 }],
    ["app/t/[team]/people/[handle]/actions.ts", "saveProfile", { currentMember: 1, canEditMemberContext: 1 }],
    ["app/actions/tasks.ts", "moveTaskAction", { currentMember: 1, canWriteStructuredRow: 1 }],
    ["app/t/[team]/social/actions.ts", "discoverNow", { requireTeamAdmin: 1, visibleItemIds: 1 }],
    ["app/t/[team]/social/actions.ts", "discoverFromArcsNow", { requireTeamAdmin: 1, resolveArcScope: 1 }],
    ["app/t/[team]/social/actions.ts", "planNow", { requireTeamAdmin: 1, visibleItemIds: 1, actorSeesChain: 1 }],
    ["app/t/[team]/social/actions.ts", "generateDrafts", { requireTeamAdmin: 1, visibleItemIds: 2, actorSeesChain: 1 }],
    ["app/t/[team]/meetings/actions.ts", "importPushedMeetingsAction", { currentMember: 1, canAccessAdmin: 1 }],
    ["app/t/[team]/admin/approvals/actions.ts", "decideManagedGatewayApproval", { getSessionUser: 1, authorizeGatewayAdmin: 1 }],
    ["app/actions/account.ts", "signOutAction", { signOut: 1 }],
  ])("credits the actual completed owner calls of %s %s", (path, exportName, expected) => {
    expect(credit(realSource(path), exportName, path)).toEqual(expected);
  });

  it.each([
    [
      "an un-awaited admin guard",
      "app/t/[team]/social/actions.ts",
      "discoverNow",
      "const ctx = await requireAdmin(teamSlug);",
      "const ctx = requireAdmin(teamSlug);",
      { visibleItemIds: 1 },
    ],
    [
      "a fire-and-forget exported delegation",
      "app/t/[team]/admin/members/actions.ts",
      "linkMemberSlack",
      `return linkMemberIdentity(teamSlug, memberId, "slack", slackUserId, handle);`,
      `void linkMemberIdentity(teamSlug, memberId, "slack", slackUserId, handle);`,
      {},
    ],
    [
      "a non-awaited Promise.all",
      "app/t/[team]/admin/agents/actions.ts",
      "mintAgentTokenAction",
      "await Promise.all([",
      "Promise.all([",
      { requireTeamAdmin: 1 },
    ],
    [
      "a shadowed Promise",
      "app/t/[team]/admin/agents/actions.ts",
      "mintAgentTokenAction",
      "const UUID_RE =",
      "const Promise = { all: async (values: unknown[]) => values };\nconst UUID_RE =",
      { requireTeamAdmin: 1 },
    ],
    [
      "a mutable dynamic-import binding in the called helper",
      "app/actions/tasks.ts",
      "moveTaskAction",
      `const { canWriteStructuredRow } = await import("@/lib/access/enforce");`,
      `let { canWriteStructuredRow } = await import("@/lib/access/enforce");`,
      { currentMember: 1 },
    ],
    [
      "a non-canonical owner specifier",
      "app/t/[team]/people/[handle]/actions.ts",
      "saveProfile",
      `from "@/lib/identity/context";`,
      `from "@/lib/identity/context/index";`,
      { currentMember: 1 },
    ],
  ])("real-source mutant: %s loses its credit", (_name, path, exportName, from, to, expected) => {
    expect(credit(mutate(realSource(path), from, to), exportName, path)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------------------------
// Invocation and completion syntax
// ---------------------------------------------------------------------------------------------

const GUARD = `import { requireTeamAdmin, currentMember } from "@/lib/auth/guard";\n`;
const ADMIN = `import { canAccessAdmin } from "@/lib/auth/admin-access";\n`;
const ROWS = `import { visibleProjectRows } from "@/lib/access/enforce";\n`;
const mod = (body: string, imports = GUARD) => `"use server";\n${imports}${body}\n`;
const act = (statements: string, imports = GUARD) =>
  mod(`export async function act(s: string) {\n${statements}\n}`, imports);

describe("server-action inventory: admitted invocation and completion forms (AC-03 controls)", () => {
  it.each<[string, string, Record<string, number>]>([
    ["a direct await", act(`const ctx = await requireTeamAdmin(s); return ctx;`), { requireTeamAdmin: 1 }],
    ["returning the promise", act(`return requireTeamAdmin(s);`), { requireTeamAdmin: 1 }],
    ["a negated, parenthesised await in a condition", act(`if (!(await requireTeamAdmin(s))) return null; return 1;`), { requireTeamAdmin: 1 }],
    [
      "direct elements of a directly awaited literal Promise.all",
      act(`const [a, b] = await Promise.all([visibleProjectRows(s), visibleProjectRows(s + "2")]); return [a, b];`, ROWS),
      { visibleProjectRows: 2 },
    ],
    [
      "a static import alias",
      act(`return (await requireAdmin(s)) !== null;`, `import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";\n`),
      { requireTeamAdmin: 1 },
    ],
    [
      "an extensionless relative path to the owner",
      act(`return await requireTeamAdmin(s);`, `import { requireTeamAdmin } from "../../../../lib/auth/guard";\n`),
      { requireTeamAdmin: 1 },
    ],
    [
      "a const-destructured, renamed, awaited literal dynamic import",
      act(`const { visibleProjectRows: rows } = await import("@/lib/access/enforce"); return await rows(s);`, ""),
      { visibleProjectRows: 1 },
    ],
    [
      "an un-awaited sync co-predicate",
      act(`const me = await currentMember(s); if (!me || !canAccessAdmin(me)) return null; return me;`, GUARD + ADMIN),
      { currentMember: 1, canAccessAdmin: 1 },
    ],
    [
      "a sync co-predicate from a dynamic import",
      act(`const { canAccessAdmin } = await import("@/lib/auth/admin-access"); return canAccessAdmin({ role: s });`, ""),
      { canAccessAdmin: 1 },
    ],
    [
      "an awaited ordinary local helper",
      mod(`async function gate(s: string) { return requireTeamAdmin(s); }\nexport async function act(s: string) { const ctx = await gate(s); return ctx; }`),
      { requireTeamAdmin: 1 },
    ],
    [
      "delegation to another exported action by returning its promise",
      mod(`export async function base(s: string) { const ctx = await requireTeamAdmin(s); return ctx; }\nexport async function act(s: string) { return base(s); }`),
      { requireTeamAdmin: 1 },
    ],
    [
      "an awaited const async arrow helper",
      mod(`const gate = async (s: string) => { const ctx = await requireTeamAdmin(s); return ctx; };\nexport async function act(s: string) { return await gate(s); }`),
      { requireTeamAdmin: 1 },
    ],
    [
      "an awaited concise-arrow helper that returns the promise",
      mod(`const gate = async (s: string) => requireTeamAdmin(s);\nexport async function act(s: string) { return await gate(s); }`),
      { requireTeamAdmin: 1 },
    ],
    [
      "a sync helper handing the promise back, awaited by its caller",
      mod(`function gate(s: string) { return requireTeamAdmin(s); }\nexport async function act(s: string) { const ctx = await gate(s); return ctx; }`),
      { requireTeamAdmin: 1 },
    ],
    [
      "an un-awaited sync helper around a sync co-predicate",
      mod(
        `function allowed(m: { role: string }) { return canAccessAdmin(m); }\nexport async function act(s: string) { const me = await currentMember(s); return me && allowed(me); }`,
        GUARD + ADMIN,
      ),
      { currentMember: 1, canAccessAdmin: 1 },
    ],
    [
      "mutually recursive helpers (cycle protection)",
      mod(
        `async function a(n: number): Promise<unknown> { if (n > 0) return b(n - 1); return requireTeamAdmin("x"); }\nasync function b(n: number): Promise<unknown> { return a(n); }\nexport async function act(s: string) { return await a(s.length); }`,
      ),
      { requireTeamAdmin: 1 },
    ],
    [
      "a const async arrow action export",
      mod(`export const act = async (s: string) => { await requireTeamAdmin(s); };`),
      { requireTeamAdmin: 1 },
    ],
    [
      "a const async function-expression action export",
      mod(`export const act = async function (s: string) { await requireTeamAdmin(s); };`),
      { requireTeamAdmin: 1 },
    ],
  ])("credits %s", (_name, source, expected) => {
    expect(analyzeActionModule(A, source, OWNER_MODES).problems).toEqual([]);
    expect(credit(source)).toEqual(expected);
  });
});

describe("server-action inventory: forms that count for nothing (AC-03 mutants)", () => {
  const dynamic = (binding: string, call = "requireTeamAdmin(s)") => act(`${binding}\n  return await ${call};`, "");

  it.each<[string, string]>([
    // -- completion
    ["a fire-and-forget async guard", act(`requireTeamAdmin(s); return 1;`)],
    ["a voided async guard", act(`void requireTeamAdmin(s); return 1;`)],
    ["a .then chain", act(`requireTeamAdmin(s).then(() => undefined); return 1;`)],
    ["a promise stored and awaited later", act(`const p = requireTeamAdmin(s); return await p;`)],
    ["a ternary around the returned call", act(`return s ? requireTeamAdmin(s) : null;`)],
    ["a non-awaited Promise.all", act(`const p = Promise.all([visibleProjectRows(s)]); return p;`, ROWS)],
    ["a returned, non-awaited Promise.all", act(`return Promise.all([visibleProjectRows(s)]);`, ROWS)],
    ["Promise.all over a non-literal array", act(`const calls = [visibleProjectRows(s)]; return await Promise.all(calls);`, ROWS)],
    ["a spread inside the Promise.all literal", act(`return await Promise.all([...[visibleProjectRows(s)]]);`, ROWS)],
    ["a nested array inside the Promise.all literal", act(`return await Promise.all([[visibleProjectRows(s)]]);`, ROWS)],
    ["Promise.allSettled", act(`return await Promise.allSettled([visibleProjectRows(s)]);`, ROWS)],
    ["Promise.race", act(`return await Promise.race([visibleProjectRows(s)]);`, ROWS)],
    ["a computed Promise['all']", act(`return await Promise["all"]([visibleProjectRows(s)]);`, ROWS)],
    [
      "a module-level shadowed Promise",
      mod(`const Promise = { all: async (v: unknown[]) => v };\nexport async function act(s: string) { return await Promise.all([visibleProjectRows(s)]); }`, ROWS),
    ],
    [
      "a parameter-shadowed Promise",
      mod(`export async function act(s: string, Promise: PromiseConstructor) { return await Promise.all([visibleProjectRows(s)]); }`, ROWS),
    ],
    [
      "a fire-and-forget async helper",
      mod(`async function gate(s: string) { await requireTeamAdmin(s); }\nexport async function act(s: string) { gate(s); return 1; }`),
    ],
    [
      "a sync helper handing the promise back to a caller that drops it",
      mod(`function gate(s: string) { return requireTeamAdmin(s); }\nexport async function act(s: string) { gate(s); return 1; }`),
    ],
    [
      "an awaited helper whose own guard call is fire-and-forget",
      mod(`async function gate(s: string) { requireTeamAdmin(s); }\nexport async function act(s: string) { await gate(s); return 1; }`),
    ],
    // -- lexical identity
    ["an import that is never called", act(`return s;`)],
    ["a comment", act(`// await requireTeamAdmin(s);\n  return s;`, "")],
    ["a string", act(`return "await requireTeamAdmin(s)" + s;`, "")],
    ["a type reference", act(`type Guard = typeof requireTeamAdmin; return s as unknown as Guard;`)],
    ["a same-spelled local function", mod(`async function requireTeamAdmin(s: string) { return s; }\nexport async function act(s: string) { return await requireTeamAdmin(s); }`, "")],
    ["a shadowing parameter", mod(`export async function act(s: string, requireTeamAdmin: (s: string) => Promise<null>) { return await requireTeamAdmin(s); }`)],
    ["a shadowing local const", act(`const requireTeamAdmin = async (x: string) => x; return await requireTeamAdmin(s);`)],
    ["a shadowing inner function declaration", act(`async function requireTeamAdmin(x: string) { return x; }\n  return await requireTeamAdmin(s);`)],
    ["a const alias of the import", act(`const guard = requireTeamAdmin; return await guard(s);`)],
    ["a bare-package specifier", act(`return await requireTeamAdmin(s);`, `import { requireTeamAdmin } from "lib/auth/guard";\n`)],
    ["an /index specifier", act(`return await requireTeamAdmin(s);`, `import { requireTeamAdmin } from "@/lib/auth/guard/index";\n`)],
    ["an explicit-extension specifier", act(`return await requireTeamAdmin(s);`, `import { requireTeamAdmin } from "@/lib/auth/guard.ts";\n`)],
    ["a wrong owner module", act(`return await requireTeamAdmin(s);`, `import { requireTeamAdmin } from "@/lib/auth/guards";\n`)],
    ["a relative path to a different module", act(`return await requireTeamAdmin(s);`, `import { requireTeamAdmin } from "./lib/auth/guard";\n`)],
    ["an unrelated export under the guard's local name", act(`return await requireTeamAdmin(s);`, `import { somethingElse as requireTeamAdmin } from "@/lib/auth/guard";\n`)],
    ["a default import", act(`return await requireTeamAdmin(s);`, `import requireTeamAdmin from "@/lib/auth/guard";\n`)],
    ["a namespace member call", act(`return await guard.requireTeamAdmin(s);`, `import * as guard from "@/lib/auth/guard";\n`)],
    ["a type-only import", act(`return await requireTeamAdmin(s);`, `import type { requireTeamAdmin } from "@/lib/auth/guard";\n`)],
    // -- uninvoked definitions
    ["a declared but uncalled helper", mod(`async function gate(s: string) { return requireTeamAdmin(s); }\nexport async function act(s: string) { return s; }`)],
    ["a nested closure that is only defined", act(`const later = async () => { await requireTeamAdmin(s); }; return typeof later;`)],
    ["a helper passed as a callback", mod(`async function gate(s: string) { return requireTeamAdmin(s); }\nexport async function act(s: string) { return await Promise.all([s].map(gate)); }`)],
    ["an immediately invoked function expression", act(`return await (async () => { await requireTeamAdmin(s); })();`)],
    ["a class method helper", mod(`class Gate { async check(s: string) { return requireTeamAdmin(s); } }\nexport async function act(s: string) { return await new Gate().check(s); }`)],
    // -- generators never run when called
    ["a called sync generator helper", mod(`function* gate(s: string) { yield requireTeamAdmin(s); }\nexport async function act(s: string) { return await gate(s); }`)],
    ["a called async generator helper", mod(`async function* gate(s: string) { yield await requireTeamAdmin(s); }\nexport async function act(s: string) { return await gate(s); }`)],
    ["a for-await over an async generator helper", mod(`async function* gate(s: string) { yield await requireTeamAdmin(s); }\nexport async function act(s: string) { for await (const x of gate(s)) return x; return null; }`)],
    ["a const generator function-expression helper", mod(`const gate = async function* (s: string) { yield await requireTeamAdmin(s); };\nexport async function act(s: string) { return await gate(s); }`)],
    // -- dynamic import bindings
    ["a dynamic import with a default initialiser", dynamic(`const { requireTeamAdmin = async (x: string) => x } = await import("@/lib/auth/guard");`)],
    ["a dynamic import rest binding", dynamic(`const { ...rest } = await import("@/lib/auth/guard");`, "rest.requireTeamAdmin(s)")],
    ["a dynamic import nested binding", dynamic(`const { guard: { requireTeamAdmin } } = (await import("@/lib/auth/guard")) as never;`)],
    ["a string-keyed dynamic import binding", dynamic(`const { "requireTeamAdmin": requireTeamAdmin } = await import("@/lib/auth/guard");`)],
    ["a let dynamic import binding", dynamic(`let { requireTeamAdmin } = await import("@/lib/auth/guard");`)],
    ["a var dynamic import binding", dynamic(`var { requireTeamAdmin } = await import("@/lib/auth/guard");`)],
    ["a non-literal dynamic import", dynamic(`const spec = "@/lib/auth/guard"; const { requireTeamAdmin } = await import(spec);`)],
    ["a template-literal dynamic import", dynamic("const { requireTeamAdmin } = await import(`@/lib/auth/guard`);")],
    ["an un-awaited dynamic import", dynamic(`const { requireTeamAdmin } = import("@/lib/auth/guard") as never;`)],
    ["a whole-module dynamic import binding", dynamic(`const guard = await import("@/lib/auth/guard");`, "guard.requireTeamAdmin(s)")],
    // -- the documented dead-code subset
    ["a call after an unconditional return", act(`return s;\n  await requireTeamAdmin(s);`)],
    ["a call under a literal-false if", act(`if (false) { await requireTeamAdmin(s); }\n  return s;`)],
    ["a call behind a literal-false &&", act(`return false && (await requireTeamAdmin(s));`)],
  ])("does not credit %s", (_name, source) => {
    expect(credit(source)).toEqual({});
  });

  it("credits a sync predicate only while its registration says sync: sync→async drift needs completion", () => {
    const source = act(`const me = await currentMember(s); return me && canAccessAdmin(me);`, GUARD + ADMIN);
    expect(credit(source)).toEqual({ currentMember: 1, canAccessAdmin: 1 });
    const drifted = new Map(OWNER_MODES).set(ownerIdentity(SERVER_ACTION_OWNERS.canAccessAdmin), "async" as const);
    expect(credit(source, "act", A, drifted)).toEqual({ currentMember: 1 });
  });

  it("never credits an identity that is not a registered owner", () => {
    const source = act(`return await requireTeamAdmin(s);`);
    expect(credit(source, "act", A, new Map())).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------
// Export shapes
// ---------------------------------------------------------------------------------------------

describe("server-action inventory: export shapes (AC-01)", () => {
  const shapesOf = (body: string) => {
    const analysis = analyzeActionModule(A, mod(body), OWNER_MODES);
    return {
      exports: analysis.runtimeExports.map((entry) => `${entry.name}:${entry.shape}:${entry.supported}`),
      erased: analysis.erasedExports,
      problems: analysis.problems,
    };
  };

  it("supports async function declarations and immutable const async function literals", () => {
    const found = shapesOf(
      `export async function a() {}\nexport const b = async () => {};\nexport const c = async function () {};`,
    );
    expect(found.exports).toEqual([
      "a:async function declaration:true",
      "b:async arrow:true",
      "c:async function expression:true",
    ]);
    expect(found.problems).toEqual([]);
  });

  it.each<[string, string, string, string]>([
    ["a sync function", `export function act() {}`, "act", "non-async function declaration"],
    ["a sync generator", `export function* act() {}`, "act", "generator"],
    ["an async generator", `export async function* act() {}`, "act", "async generator"],
    ["a const async generator expression", `export const act = async function* () {};`, "act", "async generator"],
    ["a sync const arrow", `export const act = () => {};`, "act", "non-async arrow"],
    ["a let export", `export let act = async () => {};`, "act", "mutable let/var export"],
    ["a var export", `export var act = async () => {};`, "act", "mutable let/var export"],
    ["a non-function value", `export const act = 1;`, "act", "exported binding is not a function literal"],
    ["a destructured export", `const o = { act: async () => {} };\nexport const { act } = o;`, "act", "destructured export"],
    ["a local alias specifier", `async function h() {}\nexport { h as act };`, "act", "local export specifier"],
    ["a local same-name specifier", `async function act() {}\nexport { act };`, "act", "local export specifier"],
    ["an external re-export", `export { act } from "./other";`, "act", "external re-export"],
    ["a namespace re-export", `export * as act from "./other";`, "act", "namespace re-export"],
    ["a default function", `export default async function act() {}`, "default", "default export without a stable identity"],
    ["a default expression", `const act = async () => {};\nexport default act;`, "default", "default export without a stable identity"],
    ["an import-equals alias", `import other = require("./other");\nexport import act = other.act;`, "act", "import-equals alias"],
    ["a class", `export class act {}`, "act", "not a function"],
    ["an enum", `export enum act { A }`, "act", "not a function"],
    ["an overload signature", `export async function act(): Promise<void>;`, "act", "bodiless function signature"],
  ])("discovers, then refuses %s", (_name, body, name, shape) => {
    const found = shapesOf(body);
    expect(found.exports).toContain(`${name}:${shape}:false`);
    expectFailure(found.problems, `${A} ${name}:`, `unsupported action export shape (${shape})`);
  });

  it("refuses `export *`, which has no name to key", () => {
    const found = shapesOf(`export * from "./other";`);
    expect(found.exports).toEqual([]);
    expectFailure(found.problems, A, "unsupported action export shape (export * from)");
  });

  it("refuses a name exported more than once", () => {
    const found = shapesOf(`export async function act() {}\nasync function h() {}\nexport { h as act };`);
    expectFailure(found.problems, `${A} act:`, "exported more than once");
  });

  it("ignores erased type exports without hiding the adjacent runtime export", () => {
    const found = shapesOf(
      `export interface Input { name: string }\nexport type Mode = "a" | "b";\ninterface Local { n: number }\nexport type { Local };\nexport { type Mode as Mode2 };\nexport async function act(input: Input) { return input.name; }`,
    );
    expect(found.erased).toEqual(["Input", "Mode", "Local", "Mode2"]);
    expect(found.exports).toEqual(["act:async function declaration:true"]);
    expect(found.problems).toEqual([]);
  });

  it("treats a plain specifier of a local interface as erased, and of a local value as a refused alias", () => {
    expect(shapesOf(`interface Local { n: number }\nexport { Local };`).erased).toEqual(["Local"]);
    expect(shapesOf(`const Local = 1;\nexport { Local };`).exports).toEqual(["Local:local export specifier:false"]);
  });

  it("fails closed on a module that does not parse", () => {
    const analysis = analyzeActionModule(A, `"use server";\nexport async function act( {`, OWNER_MODES);
    expectFailure(analysis.problems, A, "parse error");
    expect(analysis.runtimeExports).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Directive prologues
// ---------------------------------------------------------------------------------------------

const DIRECTIVE_FORMS: [string, string, string][] = [
  ["a function declaration", `async function a() { "use server"; }`, "FunctionDeclaration"],
  ["a function expression", `const a = async function () { "use server"; };`, "FunctionExpression"],
  ["a block-bodied arrow", `const a = async () => { "use server"; };`, "ArrowFunction"],
  ["a class method", `class C { async m() { "use server"; } }`, "MethodDeclaration"],
  ["an object method", `const o = { async m() { "use server"; } };`, "MethodDeclaration"],
  ["a constructor", `class C { constructor() { "use server"; } }`, "Constructor"],
  ["a get accessor", `class C { get v() { "use server"; return 1; } }`, "GetAccessor"],
  ["a set accessor", `class C { set v(x: number) { "use server"; } }`, "SetAccessor"],
  ["a nested anonymous closure", `export function outer() { return async () => { "use server"; }; }`, "ArrowFunction"],
  ["a generator body", `async function* g() { "use server"; }`, "FunctionDeclaration"],
  ["a sync function body", `function s() { "use server"; }`, "FunctionDeclaration"],
  ["a prologue with use strict first", `async function a() { "use strict"; "use server"; }`, "FunctionDeclaration"],
  ["a single-quoted directive after a comment", `async function a() { /* note */ 'use server'; }`, "FunctionDeclaration"],
];

const NON_DIRECTIVES: [string, string][] = [
  ["a function declaration", `async function a() { const x = 1; "use server"; return x; }`],
  ["a function expression", `const a = async function () { void 0; "use server"; };`],
  ["a block-bodied arrow", "const a = async () => { `use server`; };"],
  ["an expression-bodied arrow", `const a = async () => "use server";`],
  ["a class method", `class C { async m() { ("use server"); } }`],
  ["an object method", `const o = { async m() { return "use server"; } };`],
  ["a constructor", `class C { constructor() { // "use server"\n } }`],
  ["a get accessor", `class C { get v() { return "use server"; } }`],
  ["a set accessor", `class C { set v(x: string) { x = "use server"; } }`],
  ["bodiless signatures and types", `declare function a(): void;\ninterface I { m(): "use server" }\ntype F = () => "use server";\nabstract class C { abstract m(): "use server"; }`],
  ["a module-level comment", `// "use server"\nexport const p = 1;`],
  ["a module-level string after a statement", `export const p = 1;\n"use server";`],
  ["a module-level template", "`use server`;\nexport const p = 1;"],
  ["a module-level string constant", `export const mode = "use server";`],
];

const MODULE_DIRECTIVES: [string, string][] = [
  ["a module directive", `"use server";\nexport async function act() {}`],
  ["a module directive after use strict", `"use strict";\n"use server";\nexport async function act() {}`],
  ["a module directive after a comment", `// actions\n'use server';\nexport async function act() {}`],
];

describe("server-action inventory: directive prologue forms (AC-01)", () => {
  it.each(DIRECTIVE_FORMS)("discovers an inline directive in %s", (_name, code, form) => {
    const scan = scanSource("lib/fixture/inline.ts", code);
    expect(scan.parseProblem).toBeUndefined();
    expect(scan.moduleDirective).toBe(false);
    expect(scan.inline.map((entry) => entry.form)).toEqual([form]);
    expect(scan.inline[0].line).toBe(1);
  });

  it.each(NON_DIRECTIVES)("finds no directive in a non-prologue position: %s", (_name, code) => {
    const scan = scanSource("lib/fixture/none.ts", code);
    expect(scan.parseProblem).toBeUndefined();
    expect(scan).toMatchObject({ moduleDirective: false, inline: [] });
  });

  it.each(MODULE_DIRECTIVES)("discovers %s", (_name, code) => {
    expect(scanSource("lib/fixture/module.ts", code)).toMatchObject({ moduleDirective: true, inline: [] });
  });

  it("reports every directive in a file: module level and each nested function", () => {
    const scan = scanSource(
      "lib/fixture/many.ts",
      `"use server";\nexport async function outer() {\n  "use server";\n  return async function named() {\n    "use server";\n  };\n}`,
    );
    expect(scan.moduleDirective).toBe(true);
    expect(scan.inline.map((entry) => `${entry.name}@${entry.line}`)).toEqual(["outer@2", "named@4"]);
  });

  it("agrees with the existing entry-surface detector over the whole fixture corpus", () => {
    const corpus = [...DIRECTIVE_FORMS, ...NON_DIRECTIVES, ...MODULE_DIRECTIVES].map(([, code]) => code);
    for (const code of corpus) {
      const scan = scanSource("lib/fixture/agree.ts", code);
      const existing = hasUseServerDirective(
        ts.createSourceFile("lib/fixture/agree.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      );
      expect(scan.moduleDirective || scan.inline.length > 0, code).toBe(existing);
    }
    expect(corpus.length).toBe(DIRECTIVE_FORMS.length + NON_DIRECTIVES.length + MODULE_DIRECTIVES.length);
  });
});

// ---------------------------------------------------------------------------------------------
// Filesystem discovery (isolated temporary roots)
// ---------------------------------------------------------------------------------------------

describe("server-action inventory: filesystem discovery (AC-01)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const ACTION = `"use server";\nexport async function act() {}\n`;
  const MALFORMED = `export async function ( {`;
  const makeRoot = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "aio1217-actions-"));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return root;
  };
  const actionsIn = (root: string) => {
    const tree = discoverSourceTree(root);
    const inventory = inventoryServerActions(
      { sources: tree.sources, discoveryProblems: tree.problems, exists: () => false, read: () => undefined },
      OWNER_MODES,
    );
    return { tree, inventory, modules: [...inventory.modules.keys()].sort() };
  };

  it("finds an added action in a nested directory, in every supported extension, and under src/app", () => {
    const files: Record<string, string> = { "src/app/t/[team]/deep/nested/actions.ts": ACTION };
    for (const ext of SERVER_ACTION_SOURCE_EXT) files[`app/ext/actions${ext}`] = ACTION;
    files["components/widget/save.tsx"] = ACTION;
    files["lib/server/save.ts"] = ACTION;
    files["pages/api-like/save.ts"] = ACTION;
    const { modules, inventory } = actionsIn(makeRoot(files));
    expect(modules).toEqual(Object.keys(files).sort());
    expect(inventory.problems).toEqual([]);
    expect(inventory.census.runtimeExports).toBe(Object.keys(files).length);
  });

  it("skips a symlinked root node_modules by name, without visiting its target", () => {
    const outside = makeRoot({ "pkg/actions.ts": ACTION, "pkg/broken.js": MALFORMED });
    const root = makeRoot({ "app/actions.ts": ACTION });
    symlinkSync(outside, join(root, "node_modules"), "dir");
    const { tree, modules, inventory } = actionsIn(root);
    expect(modules).toEqual(["app/actions.ts"]);
    expect(inventory.problems).toEqual([]);
    expect(tree.skipped).toContainEqual({ path: "node_modules", reason: "dependency tree" });
  });

  it("diagnoses a non-excluded symlinked directory and a symlinked source file, following neither", () => {
    const outside = makeRoot({ "target/actions.ts": ACTION, "single.ts": ACTION });
    const root = makeRoot({ "app/actions.ts": ACTION });
    symlinkSync(join(outside, "target"), join(root, "app", "x"), "dir");
    symlinkSync(join(outside, "single.ts"), join(root, "app", "linked.ts"), "file");
    const { tree, modules } = actionsIn(root);
    expect(modules).toEqual(["app/actions.ts"]);
    expectFailure(tree.problems, "app/x/:", "symlinked directory");
    expectFailure(tree.problems, "app/linked.ts:", "symlinked source file");
    expect(tree.problems).toHaveLength(2);
  });

  it("does not fail on an unrelated non-source link, a dangling link, or .env* entries — and reads none", () => {
    const outside = makeRoot({ "notes.md": "notes", "secret.ts": MALFORMED });
    const root = makeRoot({ "app/actions.ts": ACTION, ".env": MALFORMED, ".env.local.ts": MALFORMED });
    symlinkSync(join(outside, "notes.md"), join(root, "app", "NOTES.md"), "file");
    symlinkSync(join(outside, "absent"), join(root, "app", "dangling"), "file");
    symlinkSync(join(outside, "secret.ts"), join(root, ".env.production"), "file");
    const { tree, inventory } = actionsIn(root);
    expect(tree.problems).toEqual([]);
    expect(inventory.problems).toEqual([]);
    expect([...tree.sources.keys()]).toEqual(["app/actions.ts"]);
    expect(tree.skipped.map((entry) => entry.path).sort()).toEqual([".env", ".env.local.ts", ".env.production"]);
  });

  it("skips malformed source inside the pinned trees, and only there", () => {
    const { tree, inventory, modules } = actionsIn(
      makeRoot({
        "app/actions.ts": ACTION,
        "node_modules/pkg/x.js": MALFORMED,
        ".next/server/x.js": MALFORMED,
        ".context/copy/app/actions.ts": ACTION,
        "build/x.js": MALFORMED,
        ".pnp.cjs": MALFORMED,
        ".pnp.loader.mjs": MALFORMED,
        "supabase/functions/x.ts": MALFORMED,
        "ingestion/.venv/lib/python/site-packages/pkg/x.js": MALFORMED,
        "ingestion/.pytest_cache/x.js": MALFORMED,
        "ingestion/pkg/__pycache__/x.js": MALFORMED,
        "ingestion/tools/helper.js": `export const ok = 1;\n`,
      }),
    );
    expect(inventory.problems).toEqual([]);
    expect(modules).toEqual(["app/actions.ts"]);
    expect([...tree.sources.keys()].sort()).toEqual(["app/actions.ts", "ingestion/tools/helper.js"]);
  });

  it("still walks a nested directory that merely shares a generated-directory name", () => {
    const { modules, inventory } = actionsIn(
      makeRoot({
        "app/node_modules/action.ts": ACTION,
        "app/.next/action.ts": ACTION,
        "app/build/action.ts": ACTION,
        "src/tmp/action.ts": ACTION,
        "lib/__pycache__/action.ts": ACTION,
        "lib/.venv/action.ts": ACTION,
      }),
    );
    expect(inventory.problems).toEqual([]);
    expect(modules).toEqual([
      "app/.next/action.ts",
      "app/build/action.ts",
      "app/node_modules/action.ts",
      "lib/.venv/action.ts",
      "lib/__pycache__/action.ts",
      "src/tmp/action.ts",
    ]);
  });

  it("fails with a path diagnostic on unparseable first-party source, even outside the action roots", () => {
    const { inventory } = actionsIn(makeRoot({ "app/actions.ts": ACTION, "scripts/broken.mjs": MALFORMED }));
    expect(inventory.problems).toHaveLength(1);
    expectFailure(inventory.problems, "scripts/broken.mjs:", "parse error");
  });

  it("refuses a directive outside the reviewed action roots, and every inline directive anywhere", () => {
    const { inventory } = actionsIn(
      makeRoot({
        "scripts/tool.ts": ACTION,
        "test/fixtures/actions.ts": ACTION,
        "rootlevel.ts": ACTION,
        "lib/inline.ts": `export function make() {\n  return async () => {\n    "use server";\n  };\n}\n`,
      }),
    );
    expectFailure(inventory.problems, "scripts/tool.ts:", "unclassified action location");
    expectFailure(inventory.problems, "test/fixtures/actions.ts:", "unclassified action location");
    expectFailure(inventory.problems, "rootlevel.ts:", "unclassified action location");
    expectFailure(inventory.problems, "lib/inline.ts:2", "inline \"use server\" directive (ArrowFunction)");
    expect(inventory.inline).toEqual([{ path: "lib/inline.ts", form: "ArrowFunction", name: "<anonymous>", line: 2 }]);
    expect(inventory.problems).toHaveLength(4);
  });

  it("an exclusion that widens the pinned list hides source — and is refused as policy drift", () => {
    const widened: ExclusionPolicy = {
      ...SERVER_ACTION_EXCLUSIONS,
      rootNames: [...SERVER_ACTION_EXCLUSIONS.rootNames, { name: "app", reason: "" }],
      nestedPaths: [...SERVER_ACTION_EXCLUSIONS.nestedPaths, { name: "lib/generated", reason: "generated" }],
      nestedNames: [...SERVER_ACTION_EXCLUSIONS.nestedNames, { under: "app", name: "node_modules", reason: "deps" }],
    };
    const root = makeRoot({ "app/actions.ts": ACTION });
    expect(discoverSourceTree(root, widened).sources.size).toBe(0);
    const problems = exclusionPolicyProblems(widened);
    expectFailure(problems, "exclusion app:", "first-party source root cannot be excluded");
    expectFailure(problems, "exclusion app:", "empty reason");
    expectFailure(problems, "exclusion lib/generated:", "pinned to direct children of ingestion/");
    expectFailure(problems, "app/**/node_modules", "pinned to ingestion/");
    const duplicated = { ...SERVER_ACTION_EXCLUSIONS, rootNames: [...SERVER_ACTION_EXCLUSIONS.rootNames, SERVER_ACTION_EXCLUSIONS.rootNames[0]] };
    expectFailure(exclusionPolicyProblems(duplicated), "exclusion node_modules:", "duplicate");
  });
});

// ---------------------------------------------------------------------------------------------
// The policy check over a synthetic registry
// ---------------------------------------------------------------------------------------------

const EVIDENCE = "test/actions/aio1217-fixture.test.ts";
const DENIAL = "refuses a non-admin before the write";

const BASE_ACTIONS = `"use server";
import { requireTeamAdmin as requireAdmin, currentMember } from "@/lib/auth/guard";
import { visibleProjectRows } from "@/lib/access/enforce";
import { getSessionUser, signOut } from "@/lib/auth/session";

export interface SaveInput { name: string }

async function gate(teamId: string) {
  const me = await currentMember(teamId);
  if (!me) return null;
  const { canAccessAdmin } = await import("@/lib/auth/admin-access");
  return canAccessAdmin(me) ? me : null;
}

export async function save(teamSlug: string, input: SaveInput) {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false };
  return { ok: true, name: input.name };
}

export async function mint(teamSlug: string, launcher: string) {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false };
  const [mine, theirs] = await Promise.all([visibleProjectRows(ctx.memberId), visibleProjectRows(launcher)]);
  return { ok: mine.ids.size + theirs.ids.size > 0 };
}

export async function importAll(teamId: string) {
  const me = await gate(teamId);
  return { ok: me !== null };
}

export async function rename(name: string) {
  const user = await getSessionUser();
  if (!user) return { ok: false };
  return { ok: true, name };
}

export async function leave(): Promise<void> {
  await signOut();
}
`;

const BASE_FILES: Record<string, string> = {
  "tsconfig.json": `{\n  // the root alias\n  "compilerOptions": { "paths": { "@/*": ["./*"] } }\n}\n`,
  "lib/auth/guard.ts": `export async function requireTeamAdmin(teamSlug: string) { return teamSlug ? { teamId: "t", memberId: "m" } : null; }
export async function currentMember(teamId: string) { return teamId ? { id: "m", role: "admin", tier: "team" } : null; }
`,
  "lib/auth/session.ts": `export async function getSessionUser() { return null; }\nexport async function signOut(): Promise<void> {}\n`,
  "lib/auth/admin-access.ts": `export function canAccessAdmin(member: { role?: string | null }): boolean { return member.role === "admin"; }\n`,
  "lib/access/enforce.ts": `export async function visibleProjectRows(memberId: string) { return { ids: new Set([memberId]) }; }\n`,
  [EVIDENCE]: `import { it } from "vitest";
it("${DENIAL}", () => {});
it("signs out without an identity", () => {});
it.todo("pending denial");
it.skip("skipped denial", () => {});
it.each([1, 2])("refuses principal %s", () => {});
`,
  [A]: BASE_ACTIONS,
};

const pickOwners = (...names: ServerActionOwnerName[]): Record<string, OwnerRegistration> =>
  Object.fromEntries(names.map((name) => [name, SERVER_ACTION_OWNERS[name]]));

const row = (exportName: string, owners: string[], extra: Partial<ProtectedAction> = {}): ProtectedAction => ({
  path: A,
  exportName,
  owners,
  refusal: "admins only",
  effects: ["write"],
  clientIdBinding: "not certified beyond registered conjunctions",
  evidence: [{ path: EVIDENCE, cases: [DENIAL] }],
  ...extra,
});

const LEAVE: ProtocolException = {
  path: A,
  exportName: "leave",
  owners: ["signOut"],
  reason: "Own-cookie sign-out cannot require an identity.",
  protocol: "Clears only the current browser cookie.",
  evidence: [{ path: EVIDENCE, cases: ["signs out without an identity"] }],
};

const BASE_POLICY: ServerActionPolicy = {
  owners: pickOwners("requireTeamAdmin", "currentMember", "getSessionUser", "signOut", "canAccessAdmin", "visibleProjectRows"),
  protectedActions: [
    row("save", ["requireTeamAdmin"]),
    row("mint", ["requireTeamAdmin", "visibleProjectRows"], { callSites: { visibleProjectRows: 2 } }),
    row("importAll", ["currentMember", "canAccessAdmin"]),
    row("rename", ["getSessionUser"]),
  ],
  protocolExceptions: [LEAVE],
  census: { modules: 1, runtimeExports: 5, erasedExports: 1, inlineDirectives: 0 },
  exclusions: SERVER_ACTION_EXCLUSIONS,
};

function fixtureView(overrides: Record<string, string | undefined> = {}, discoveryProblems: string[] = []): ActionRepoView {
  const files = new Map<string, string>();
  for (const [path, source] of Object.entries({ ...BASE_FILES, ...overrides })) if (source !== undefined) files.set(path, source);
  const sources = new Map([...files].filter(([path]) => SERVER_ACTION_SOURCE_EXT.some((ext) => path.endsWith(ext))));
  return { sources, discoveryProblems, exists: (path) => files.has(path), read: (path) => files.get(path) };
}

const check = (overrides: Record<string, string | undefined> = {}, policy: Partial<ServerActionPolicy> = {}) =>
  checkServerActionAuth(fixtureView(overrides), { ...BASE_POLICY, ...policy });

const actions = (from: string, to: string) => ({ [A]: mutate(BASE_ACTIONS, from, to) });
const rows = (exportName: string, patch: Partial<ProtectedAction>): Partial<ServerActionPolicy> => ({
  protectedActions: BASE_POLICY.protectedActions.map((entry) => (entry.exportName === exportName ? { ...entry, ...patch } : entry)),
});

describe("server-action inventory: the policy check (AC-02, AC-03)", () => {
  it("passes the admitted synthetic policy — the control every mutant below departs from", () => {
    expect(check()).toEqual([]);
  });

  it.each<[string, Record<string, string | undefined>, string[][]]>([
    [
      "a new unregistered export",
      { [A]: `${BASE_ACTIONS}\nexport async function extra() { return 1; }\n` },
      [[`${A} extra:`, "unregistered action with no registered owner invocation"], ["census drift", "6 runtimeExports"]],
    ],
    [
      "a spare guarded export",
      { [A]: `${BASE_ACTIONS}\nexport async function extra(s: string) { return await requireAdmin(s); }\n` },
      [[`${A} extra:`, "unregistered action invoking requireTeamAdmin"]],
    ],
    [
      "a new action module in another root and extension",
      { "src/app/extra/actions.mjs": `"use server";\nexport async function extra() {}\n` },
      [["src/app/extra/actions.mjs extra:", "unregistered action"], ["census drift", "2 modules"]],
    ],
    [
      "a removed guard call",
      actions("const ctx = await requireAdmin(teamSlug);", "const ctx = { memberId: teamSlug };"),
      [[`${A} save:`, "missing expected owner invocation: requireTeamAdmin"]],
    ],
    [
      "a guard downgraded to session-only",
      actions("const ctx = await requireAdmin(teamSlug);", "const ctx = await getSessionUser();"),
      [[`${A} save:`, "missing expected owner invocation: requireTeamAdmin"], [`${A} save:`, "unexpected registered owner invocation: getSessionUser"]],
    ],
    [
      "a guard left only in a comment",
      actions("const ctx = await requireAdmin(teamSlug);", "// const ctx = await requireAdmin(teamSlug);\n  const ctx = { memberId: teamSlug };"),
      [[`${A} save:`, "missing expected owner invocation: requireTeamAdmin"]],
    ],
    [
      "an un-awaited async guard",
      actions("const ctx = await requireAdmin(teamSlug);", "const ctx = requireAdmin(teamSlug);"),
      [[`${A} save:`, "missing expected owner invocation: requireTeamAdmin"]],
    ],
    [
      "a lexically shadowed guard",
      actions(
        "export async function save(teamSlug: string, input: SaveInput) {",
        "export async function save(teamSlug: string, input: SaveInput, requireAdmin = async (s: string) => ({ memberId: s })) {",
      ),
      [[`${A} save:`, "missing expected owner invocation: requireTeamAdmin"]],
    ],
    [
      "a wrong owner module",
      actions(`from "@/lib/auth/guard";`, `from "@/lib/auth/guard/index";`),
      [[`${A} save:`, "missing expected owner invocation: requireTeamAdmin"], [`${A} importAll:`, "missing expected owner invocation: currentMember"]],
    ],
    [
      "a generator action export",
      actions("export async function save(", "export async function* save("),
      [[`${A} save:`, "unsupported action export shape (async generator)"]],
    ],
    [
      "a generator helper",
      actions("async function gate(", "async function* gate("),
      [[`${A} importAll:`, "missing expected owner invocation: currentMember, canAccessAdmin"]],
    ],
    [
      "a fire-and-forget helper",
      actions("const me = await gate(teamId);", "const me = gate(teamId);"),
      [[`${A} importAll:`, "missing expected owner invocation: currentMember, canAccessAdmin"]],
    ],
    [
      "an uninvoked helper",
      actions("const me = await gate(teamId);", "const me = teamId ? gate : null;"),
      [[`${A} importAll:`, "missing expected owner invocation: currentMember, canAccessAdmin"]],
    ],
    [
      "a non-awaited combinator",
      actions("await Promise.all([", "Promise.all(["),
      [[`${A} mint:`, "missing expected owner invocation: visibleProjectRows"]],
    ],
    [
      "a shadowed Promise",
      actions("export interface SaveInput", "const Promise = { all: async <T>(values: T[]) => values };\nexport interface SaveInput"),
      [[`${A} mint:`, "missing expected owner invocation: visibleProjectRows"]],
    ],
    [
      "one of the two pinned principals dropped",
      actions("[visibleProjectRows(ctx.memberId), visibleProjectRows(launcher)]", "[visibleProjectRows(ctx.memberId)]"),
      [[`${A} mint:`, "visibleProjectRows has 1 credited call site(s), row pins 2"]],
    ],
    [
      "a mutable dynamic-import binding",
      actions("const { canAccessAdmin } = await import(", "let { canAccessAdmin } = await import("),
      [[`${A} importAll:`, "missing expected owner invocation: canAccessAdmin"]],
    ],
    [
      "a removed protocol export",
      actions("export async function leave(): Promise<void> {\n  await signOut();\n}", ""),
      [[`${A} leave:`, "stale registration — no such exported action"], ["census drift", "4 runtimeExports"]],
    ],
    [
      "an inline action in another file",
      { "lib/widgets/save.ts": `export function make() {\n  return async function saver() {\n    "use server";\n  };\n}\n` },
      [["lib/widgets/save.ts:2 saver:", "inline \"use server\" directive (FunctionExpression)"], ["census drift", "1 inlineDirectives"]],
    ],
    [
      "an action module outside the reviewed roots",
      { "scripts/tool.ts": `"use server";\nexport async function tool() {}\n` },
      [["scripts/tool.ts:", "unclassified action location"], ["scripts/tool.ts tool:", "unregistered action"]],
    ],
    [
      "an unparseable first-party source file",
      { "components/broken.tsx": `export const x = <div>;` },
      [["components/broken.tsx:", "parse error"]],
    ],
    [
      "an owner whose sync mode went stale (sync→async)",
      { "lib/auth/admin-access.ts": `export async function canAccessAdmin(member: { role?: string | null }): Promise<boolean> { return member.role === "admin"; }\n` },
      [["owner canAccessAdmin:", "stale completion mode — registered sync, declared async"], [`${A} importAll:`, "missing expected owner invocation: canAccessAdmin"]],
    ],
    [
      "an owner whose async mode went stale (async→sync)",
      { "lib/auth/session.ts": `export function getSessionUser() { return null; }\nexport async function signOut(): Promise<void> {}\n` },
      [["owner getSessionUser:", "registered async, declared without the async modifier"], [`${A} rename:`, "missing expected owner invocation: getSessionUser"]],
    ],
    [
      "a sync predicate without its boolean annotation",
      { "lib/auth/admin-access.ts": `export function canAccessAdmin(member: { role?: string | null }) { return member.role === "admin"; }\n` },
      [["owner canAccessAdmin:", "explicit boolean return annotation"]],
    ],
    [
      "an owner turned into a generator",
      { "lib/access/enforce.ts": `export async function* visibleProjectRows(memberId: string) { yield memberId; }\n` },
      [["owner visibleProjectRows:", "a generator never runs when called"], [`${A} mint:`, "missing expected owner invocation: visibleProjectRows"]],
    ],
    [
      "an owner turned into a const binding",
      { "lib/access/enforce.ts": `export const visibleProjectRows = async (memberId: string) => ({ ids: new Set([memberId]) });\n` },
      [["owner visibleProjectRows:", "not an ordinary function declaration"]],
    ],
    [
      "an owner declared more than once",
      { "lib/auth/session.ts": `export async function getSessionUser(): Promise<null>;\nexport async function getSessionUser() { return null; }\nexport async function signOut(): Promise<void> {}\n` },
      [["owner getSessionUser:", "declares it more than once"]],
    ],
    [
      "an owner that no longer exports the entry point",
      { "lib/auth/session.ts": `async function getSessionUser() { return null; }\nexport async function signOut(): Promise<void> { await getSessionUser(); }\n` },
      [["owner getSessionUser:", "no longer exports it by name"]],
    ],
    ["a deleted owner module", { "lib/access/enforce.ts": undefined }, [["owner visibleProjectRows:", "lib/access/enforce.ts does not exist"]]],
    [
      "a sibling file that shadows the canonical owner",
      { "lib/auth/guard/index.ts": `export const requireTeamAdmin = async () => ({ teamId: "t", memberId: "m" });\n` },
      [["owner requireTeamAdmin:", "lib/auth/guard/index.ts shadows the canonical owner lib/auth/guard.ts"], [`${A} save:`, "missing expected owner invocation: requireTeamAdmin"]],
    ],
    [
      "a drifted @/ alias",
      { "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }` },
      [["tsconfig.json:", "compilerOptions.paths drifted"]],
    ],
    ["a missing tsconfig", { "tsconfig.json": undefined }, [["tsconfig.json:", "missing"]]],
    ["a deleted evidence file", { [EVIDENCE]: undefined }, [[`${A} save:`, `missing evidence path ${EVIDENCE}`], [`${A} leave:`, `missing evidence path ${EVIDENCE}`]]],
    [
      "an evidence case downgraded to a todo",
      { [EVIDENCE]: mutate(BASE_FILES[EVIDENCE], `it("${DENIAL}", () => {});`, `it.todo("${DENIAL}");`) },
      [[`${A} save:`, `evidence case "${DENIAL}"`, "todo/skip placeholder — never credited"]],
    ],
  ])("fails on %s", (_name, overrides, expected) => {
    const failures = check(overrides);
    for (const fragments of expected) expectFailure(failures, ...fragments);
  });

  it.each<[string, Partial<ServerActionPolicy>, string[][]]>([
    ["a missing registration", { protectedActions: BASE_POLICY.protectedActions.slice(1) }, [[`${A} save:`, "unregistered action invoking requireTeamAdmin"]]],
    ["a duplicate registration", { protectedActions: [...BASE_POLICY.protectedActions, row("save", ["requireTeamAdmin"])] }, [[`${A} save:`, "duplicate registration"]]],
    ["a row registered as both protected and protocol", { protectedActions: [...BASE_POLICY.protectedActions, row("leave", ["signOut"])] }, [[`${A} leave:`, "registered as both protected and protocol"]]],
    ["a stale registration", { protectedActions: [...BASE_POLICY.protectedActions, row("gone", ["requireTeamAdmin"])] }, [[`${A} gone:`, "stale registration — no such exported action"]]],
    ["a stale protocol exception", { protocolExceptions: [LEAVE, { ...LEAVE, exportName: "gone" }] }, [[`${A} gone:`, "stale registration — no such exported action"]]],
    ["a protocol exception with no reason or protocol", { protocolExceptions: [{ ...LEAVE, reason: " ", protocol: "" }] }, [[`${A} leave:`, "empty reason"], [`${A} leave:`, "empty protocol description"]]],
    ["a protocol exception with a stale owner set", { protocolExceptions: [{ ...LEAVE, owners: [] }] }, [[`${A} leave:`, "unexpected registered owner invocation: signOut"]]],
    ["a protected action reclassified as an unexplained exception", { ...rows("rename", {}), protectedActions: BASE_POLICY.protectedActions.filter((entry) => entry.exportName !== "rename"), protocolExceptions: [LEAVE, { ...LEAVE, exportName: "rename", owners: [] }] }, [[`${A} rename:`, "unexpected registered owner invocation: getSessionUser"]]],
    ["an unknown owner name", rows("save", { owners: ["requireTeamAdmin", "requireSuperAdmin"] }), [[`${A} save:`, `unknown owner "requireSuperAdmin"`]]],
    ["an empty owner set", rows("save", { owners: [] }), [[`${A} save:`, "empty expected owner set"], [`${A} save:`, "unexpected registered owner invocation: requireTeamAdmin"]]],
    ["a co-guard-only owner set", rows("importAll", { owners: ["canAccessAdmin"] }), [[`${A} importAll:`, "canAccessAdmin alone is never sufficient authentication"], [`${A} importAll:`, "unexpected registered owner invocation: currentMember"]]],
    ["an expected set wider than the invocation", rows("rename", { owners: ["getSessionUser", "requireTeamAdmin"] }), [[`${A} rename:`, "missing expected owner invocation: requireTeamAdmin"]]],
    ["a call-site pin on an owner outside the set", rows("save", { callSites: { visibleProjectRows: 1 } }), [[`${A} save:`, `call-site pin names "visibleProjectRows"`]]],
    ["no evidence", rows("save", { evidence: [] }), [[`${A} save:`, "no executing evidence registered"]]],
    ["a missing evidence path", rows("save", { evidence: [{ path: "test/actions/aio1217-absent.test.ts", cases: [DENIAL] }] }), [[`${A} save:`, "missing evidence path test/actions/aio1217-absent.test.ts"]]],
    ["evidence that names no case", rows("save", { evidence: [{ path: EVIDENCE, cases: [] }] }), [[`${A} save:`, "names no test case"]]],
    ["an evidence case that does not exist", rows("save", { evidence: [{ path: EVIDENCE, cases: ["refuses everything"] }] }), [[`${A} save:`, `evidence case "refuses everything" not found`]]],
    ["a todo placeholder credited as evidence", rows("save", { evidence: [{ path: EVIDENCE, cases: ["pending denial"] }] }), [[`${A} save:`, "todo/skip placeholder — never credited"]]],
    ["a skipped placeholder credited as evidence", rows("save", { evidence: [{ path: EVIDENCE, cases: ["skipped denial"] }] }), [[`${A} save:`, "todo/skip placeholder — never credited"]]],
    ["an empty refusal, effect list and client-ID classification", rows("save", { refusal: "", effects: [], clientIdBinding: " " }), [[`${A} save:`, "empty refusal"], [`${A} save:`, "missing protected effects"], [`${A} save:`, "missing client-ID binding classification"]]],
    ["an unused owner registration", { owners: { ...BASE_POLICY.owners, ...pickOwners("canWriteStructuredRow") } }, [["owner canWriteStructuredRow:", "unused registration"]]],
    ["a duplicate owner identity", { owners: { ...BASE_POLICY.owners, alsoAdmin: SERVER_ACTION_OWNERS.requireTeamAdmin } }, [["owner alsoAdmin:", "duplicate registration of lib/auth/guard#requireTeamAdmin"]]],
    ["an owner with no reason", { owners: { ...BASE_POLICY.owners, getSessionUser: { ...SERVER_ACTION_OWNERS.getSessionUser, reason: "" } } }, [["owner getSessionUser:", "empty reason"]]],
    ["a stale census pin", { census: { ...BASE_POLICY.census, runtimeExports: 4, erasedExports: 0 } }, [["census drift", "5 runtimeExports, policy pins 4"], ["census drift", "1 erasedExports, policy pins 0"]]],
    ["a widened exclusion policy", { exclusions: { ...SERVER_ACTION_EXCLUSIONS, rootNames: [...SERVER_ACTION_EXCLUSIONS.rootNames, { name: "lib", reason: "noise" }] } }, [["exclusion lib:", "first-party source root cannot be excluded"]]],
  ])("fails on %s", (_name, policy, expected) => {
    const failures = check({}, policy);
    for (const fragments of expected) expectFailure(failures, ...fragments);
  });

  it("accepts a parameterised evidence title only by its literal template", () => {
    expect(check({}, rows("save", { evidence: [{ path: EVIDENCE, cases: ["refuses principal %s"] }] }))).toEqual([]);
    const titles = testCaseTitles(EVIDENCE, BASE_FILES[EVIDENCE]);
    expect([...titles.executable].sort()).toEqual([DENIAL, "refuses principal %s", "signs out without an identity"].sort());
    expect([...titles.placeholders].sort()).toEqual(["pending denial", "skipped denial"]);
  });

  it("carries discovery problems and an empty inventory through as failures", () => {
    const view = fixtureView({ [A]: undefined }, ["app/x/: symlinked directory — not followed"]);
    const failures = checkServerActionAuth(view, BASE_POLICY);
    expectFailure(failures, "app/x/:", "symlinked directory");
    expectFailure(failures, "no Server Action modules discovered");
  });

  it("refuses a source path that is not root-relative", () => {
    const view = fixtureView();
    const escaped = new Map(view.sources);
    escaped.set("../outside/actions.ts", `"use server";\nexport async function act() {}\n`);
    expectFailure(checkServerActionAuth({ ...view, sources: escaped }, BASE_POLICY), "../outside/actions.ts:", "not root-relative");
  });
});

// ---------------------------------------------------------------------------------------------
// Explicitly pending — nothing above certifies these
// ---------------------------------------------------------------------------------------------

describe("server-action inventory: pending integration (NOT covered by this file yet)", () => {
  it.todo("the reviewed 96-row production registry passes checkServerActionAuth on unchanged source (AC-02)");
  it.todo("full-policy in-memory mutants over the production registry (AC-03)");
  it.todo("each of the 95 protected rows names executing denial evidence that exists and is not a placeholder (AC-04)");
});
