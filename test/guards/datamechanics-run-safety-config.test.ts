import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every Vitest config that truncates through `test/datamechanics/setup.ts` must also run
 * `test/datamechanics/global-setup.ts` — and run it FIRST.
 *
 * WHY. That setup file refuses to load a test file, or to truncate, without the run-safety state
 * the global setup creates (a fresh run id, minted once in the main process before any worker). A
 * config that reuses the setup file but lists its own `globalSetup` loses the initializer, and its
 * whole tier then fails before the first test. That happened: `vitest.tierret1-query.config.ts`
 * inherits `setupFiles` from the HTTP config by spread and overrides `globalSetup` — so adding the
 * initializer to the two configs that NAME the setup file was not enough.
 *
 * So this follows the inheritance instead of trusting where the path is spelled. It reads the
 * configs as text: importing them would run their environment pins, which refuse to load without
 * the dedicated test database.
 *
 * IT FAILS CLOSED. Reading text, it can only follow the shapes it knows — `key: ["…"]` and
 * `import x from "./vitest.<name>.config"` with `...x.test`. Anything else is not guessed at and
 * not skipped: a `setupFiles` / `globalSetup` that is not an array of string literals, a config
 * that reaches another config any other way (a named or namespace import, `mergeConfig`, a spread
 * of something that is not a followed config), is a VIOLATION. An unreadable config would otherwise
 * be an uncounted one. The synthetic cases below show each such shape being caught.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const SETUP_FILE = "test/datamechanics/setup.ts";
const RUN_INITIALIZER = "test/datamechanics/global-setup.ts";

/** Config file name → its source text. */
type Sources = Record<string, string>;

interface Wiring { setupFiles: string[] | null; globalSetup: string[] | null }
interface Reading { wiring: Wiring; parent: string | null; problems: string[] }

/**
 * The string array a key is set to in this file's own text (null if it does not set it), and every
 * way the file mentions that key WITHOUT being a plain `key: ["…", "…"]` — a scalar, a variable, a
 * second declaration, a mention this reader cannot classify.
 */
function ownList(source: string, key: "setupFiles" | "globalSetup"): { list: string[] | null; problems: string[] } {
  const mentions = source.match(new RegExp(`\\b${key}\\b`, "g"))?.length ?? 0;
  const declared = [...source.matchAll(new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`, "g"))];
  const problems: string[] = [];
  if (mentions !== declared.length) {
    problems.push(`${key} is mentioned ${mentions} time(s) but set to an array literal ${declared.length} time(s) — every mention must be \`${key}: ["…"]\``);
  }
  if (declared.length > 1) problems.push(`${key} is set more than once`);
  if (declared.length === 0) return { list: null, problems };
  const inner = declared[0][1];
  if (!/^\s*(?:(?:"[^"\n]+"|'[^'\n]+')\s*(?:,\s*|$))*$/.test(inner)) {
    problems.push(`${key} must be an array of string literals only`);
  }
  return { list: [...inner.matchAll(/["']([^"'\n]+)["']/g)].map((entry) => entry[1]), problems };
}

/**
 * The root config whose `test` block this one spreads (null if none), and every way the file
 * reaches another config that this reader cannot follow.
 */
function parentOf(source: string, names: string[]): { parent: string | null; problems: string[] } {
  const problems: string[] = [];
  // Every quoted mention of another vitest config file…
  const references = source.match(/["'`][^"'`\n]*vitest[^"'`\n]*\.config(?:\.[cm]?[jt]s)?["'`]/g) ?? [];
  // …must be one of these: a default import of a sibling root config.
  const imports = [...source.matchAll(/import\s+(\w+)\s+from\s+["']\.\/(vitest(?:\.[a-z0-9-]+)?\.config)(?:\.ts)?["']/g)];
  if (references.length !== imports.length) {
    problems.push("it refers to another vitest config other than by `import x from \"./vitest.<name>.config\"`");
  }
  const followed = new Map<string, string>();
  for (const [, binding, specifier] of imports) {
    const file = `${specifier}.ts`;
    if (!names.includes(file)) problems.push(`it imports ${file}, which is not a root config`);
    if (new RegExp(`\\.\\.\\.${binding}\\.test\\b`).test(source)) followed.set(binding, file);
    else problems.push(`it imports ${file} but does not spread its test block as \`...${binding}.test\` — what it inherits cannot be followed`);
  }
  for (const [, binding] of source.matchAll(/\.\.\.(\w+)\.test\b/g)) {
    if (!followed.has(binding)) problems.push(`it spreads \`${binding}.test\`, which is not the test block of a followed root config`);
  }
  if (/\bmergeConfig\b/.test(source)) problems.push("it composes its config with mergeConfig, which this guard does not follow");
  if (followed.size > 1) problems.push("it inherits from more than one config");
  return { parent: [...followed.values()][0] ?? null, problems };
}

/** What a config ends up with — its own value where it sets one, otherwise what it inherits — and what could not be read. */
function read(sources: Sources, name: string, seen: string[] = []): Reading {
  const source = sources[name];
  if (source === undefined) return { wiring: { setupFiles: null, globalSetup: null }, parent: null, problems: [`${name} could not be read`] };
  if (seen.includes(name)) {
    return { wiring: { setupFiles: null, globalSetup: null }, parent: null, problems: [`config inheritance loops: ${[...seen, name].join(" → ")}`] };
  }
  const { parent, problems: parentProblems } = parentOf(source, Object.keys(sources));
  const inherited = parent ? read(sources, parent, [...seen, name]) : null;
  const setupFiles = ownList(source, "setupFiles");
  const globalSetup = ownList(source, "globalSetup");
  return {
    parent,
    wiring: {
      setupFiles: setupFiles.list ?? inherited?.wiring.setupFiles ?? null,
      globalSetup: globalSetup.list ?? inherited?.wiring.globalSetup ?? null,
    },
    // A parent's own problems are reported under the parent's name, not repeated here — except a loop.
    problems: [...parentProblems, ...setupFiles.problems, ...globalSetup.problems,
      ...(inherited?.problems.filter((problem) => problem.startsWith("config inheritance loops")) ?? [])],
  };
}

/** The configs that end up truncating through the data-mechanics setup file. */
const truncatingIn = (sources: Sources): string[] =>
  Object.keys(sources).sort().filter((name) => read(sources, name).wiring.setupFiles?.includes(SETUP_FILE));

/** Everything wrong: what could not be read, and every truncating config without the initializer first. */
function violations(sources: Sources): string[] {
  const found: string[] = [];
  for (const name of Object.keys(sources).sort()) {
    const { wiring, problems } = read(sources, name);
    for (const problem of problems) found.push(`${name}: ${problem}`);
    if (!wiring.setupFiles?.includes(SETUP_FILE)) continue;
    if (!wiring.globalSetup) found.push(`${name}: it reuses ${SETUP_FILE} but has no globalSetup — ${RUN_INITIALIZER} must be listed`);
    else if (wiring.globalSetup[0] !== RUN_INITIALIZER) found.push(`${name}: ${RUN_INITIALIZER} must be the FIRST global setup, and is not`);
    else if (wiring.globalSetup.filter((entry) => entry === RUN_INITIALIZER).length !== 1) found.push(`${name}: ${RUN_INITIALIZER} must be listed exactly once`);
  }
  return found;
}

const REAL: Sources = Object.fromEntries(
  readdirSync(ROOT)
    .filter((name) => /^vitest(\.[a-z0-9-]+)?\.config\.ts$/.test(name))
    .sort()
    .map((name) => [name, readFileSync(join(ROOT, name), "utf8")]),
);

describe("guard: a config that truncates through the data-mechanics setup also initializes its run-safety state", () => {
  it("reads exactly the six root configs — a tier added tomorrow must be looked at, not silently included", () => {
    expect(Object.keys(REAL)).toEqual([
      "vitest.config.ts",
      "vitest.datamechanics.config.ts",
      "vitest.dev-login.config.ts",
      "vitest.http.config.ts",
      "vitest.mcp.config.ts",
      "vitest.tierret1-query.config.ts",
    ]);
  });

  it("finds the four that reuse the setup file — by name AND by inheritance", () => {
    expect(truncatingIn(REAL)).toEqual([
      "vitest.datamechanics.config.ts",
      "vitest.http.config.ts",
      "vitest.mcp.config.ts",
      "vitest.tierret1-query.config.ts",
    ]);
    // Two of them never spell the setup file's path: they get it by spreading the HTTP config.
    for (const inheriting of ["vitest.mcp.config.ts", "vitest.tierret1-query.config.ts"]) {
      expect(REAL[inheriting]).not.toContain(SETUP_FILE);
      expect(read(REAL, inheriting).parent).toBe("vitest.http.config.ts");
    }
    // The other two have no setup file at all, their own or inherited.
    for (const other of ["vitest.config.ts", "vitest.dev-login.config.ts"]) {
      expect(read(REAL, other)).toMatchObject({ parent: null, wiring: { setupFiles: null } });
    }
  });

  it("every one of them runs the run-safety initializer first, and every config could be read", () => {
    expect(violations(REAL)).toEqual([]);
    for (const name of truncatingIn(REAL)) {
      expect(read(REAL, name).wiring.globalSetup?.[0], name).toBe(RUN_INITIALIZER);
    }
  });

  it("the initializer and the setup file are where the configs say they are, and the setup file is the one that needs it", () => {
    const setup = readFileSync(join(ROOT, SETUP_FILE), "utf8");
    expect(setup).toContain("assertRunSafe();");
    expect(readFileSync(join(ROOT, RUN_INITIALIZER), "utf8")).toMatch(/export default function setup\(/);
  });
});

describe("guard self-check: each way of losing the initializer — or of hiding from this guard — is a violation", () => {
  const HTTP = `
    import { defineConfig } from "vitest/config";
    export default defineConfig({ test: {
      globalSetup: ["${RUN_INITIALIZER}", "test/http/global-setup.ts"],
      setupFiles: ["${SETUP_FILE}"],
    } });`;
  /** A child of the HTTP config, as the real inheriting configs are written. */
  const child = (test: string, imports = 'import httpConfig from "./vitest.http.config";') => `
    import { defineConfig } from "vitest/config";
    ${imports}
    export default defineConfig({ ...httpConfig, test: ${test} });`;
  const check = (childSource: string) =>
    violations({ "vitest.http.config.ts": HTTP, "vitest.child.config.ts": childSource });

  it("CONTROL: a child that only spreads the parent's test block inherits the initializer, and is clean", () => {
    const sources = { "vitest.http.config.ts": HTTP, "vitest.child.config.ts": child('{ ...httpConfig.test, include: ["x.test.ts"] }') };
    expect(violations(sources)).toEqual([]);
    expect(truncatingIn(sources)).toEqual(["vitest.child.config.ts", "vitest.http.config.ts"]);
    // …and so is one that overrides globalSetup and keeps the initializer first.
    expect(check(child(`{ ...httpConfig.test, globalSetup: ["${RUN_INITIALIZER}", "test/http/own.ts"] }`))).toEqual([]);
  });

  it("MISSING: an override that drops the initializer", () => {
    expect(check(child('{ ...httpConfig.test, globalSetup: ["test/http/own.ts"] }')))
      .toEqual([`vitest.child.config.ts: ${RUN_INITIALIZER} must be the FIRST global setup, and is not`]);
    expect(check(child("{ ...httpConfig.test, globalSetup: [] }")))
      .toEqual([`vitest.child.config.ts: ${RUN_INITIALIZER} must be the FIRST global setup, and is not`]);
  });

  it("ORDER: the initializer listed, but not first — or listed twice", () => {
    expect(check(child(`{ ...httpConfig.test, globalSetup: ["test/http/own.ts", "${RUN_INITIALIZER}"] }`)))
      .toEqual([`vitest.child.config.ts: ${RUN_INITIALIZER} must be the FIRST global setup, and is not`]);
    expect(check(child(`{ ...httpConfig.test, globalSetup: ["${RUN_INITIALIZER}", "${RUN_INITIALIZER}"] }`)))
      .toEqual([`vitest.child.config.ts: ${RUN_INITIALIZER} must be listed exactly once`]);
  });

  it("SCALAR: `globalSetup` or `setupFiles` set to a string is malformed — not silently inherited from the parent", () => {
    // Vitest accepts a bare string. Read as "not set", this would inherit the parent's list and pass.
    expect(check(child('{ ...httpConfig.test, globalSetup: "test/http/own.ts" }'))).toEqual([
      'vitest.child.config.ts: globalSetup is mentioned 1 time(s) but set to an array literal 0 time(s) — every mention must be `globalSetup: ["…"]`',
    ]);
    // A standalone config that reuses the setup file by a bare string is caught the same way.
    expect(violations({ "vitest.solo.config.ts": `export default { test: { setupFiles: "${SETUP_FILE}" } };` })).toEqual([
      'vitest.solo.config.ts: setupFiles is mentioned 1 time(s) but set to an array literal 0 time(s) — every mention must be `setupFiles: ["…"]`',
    ]);
    // So is a variable, a non-literal element, and a second declaration.
    expect(check(child("{ ...httpConfig.test, globalSetup }"))).toHaveLength(1);
    expect(check(child("{ ...httpConfig.test, globalSetup: [OWN_SETUP] }")))
      .toContain("vitest.child.config.ts: globalSetup must be an array of string literals only");
    expect(check(child(`{ ...httpConfig.test, globalSetup: ["${RUN_INITIALIZER}"], ...{ globalSetup: ["x.ts"] } }`)))
      .toContain("vitest.child.config.ts: globalSetup is set more than once");
  });

  it("UNFOLLOWED PARENT: a config that reaches another config in a way this guard cannot follow is a violation, not an uncounted config", () => {
    // mergeConfig: the parent is imported, and never spread.
    const merged = `
      import { defineConfig, mergeConfig } from "vitest/config";
      import httpConfig from "./vitest.http.config";
      export default mergeConfig(httpConfig, defineConfig({ test: { globalSetup: ["test/http/own.ts"] } }));`;
    expect(check(merged)).toEqual([
      "vitest.child.config.ts: it imports vitest.http.config.ts but does not spread its test block as `...httpConfig.test` — what it inherits cannot be followed",
      "vitest.child.config.ts: it composes its config with mergeConfig, which this guard does not follow",
    ]);
    // A namespace or named import of the parent.
    for (const imports of ['import * as httpConfig from "./vitest.http.config";', 'import { base as httpConfig } from "./vitest.http.config";']) {
      expect(check(child('{ ...httpConfig.test, globalSetup: ["test/http/own.ts"] }', imports))).toEqual([
        'vitest.child.config.ts: it refers to another vitest config other than by `import x from "./vitest.<name>.config"`',
        "vitest.child.config.ts: it spreads `httpConfig.test`, which is not the test block of a followed root config",
      ]);
    }
    // A dynamic import or require of it.
    expect(check('const httpConfig = require("./vitest.http.config"); export default { ...httpConfig };'))
      .toContain('vitest.child.config.ts: it refers to another vitest config other than by `import x from "./vitest.<name>.config"`');
    // A test block spread from something that is not a root config at all.
    expect(check(child("{ ...base.test }", 'import base from "./configs/base";')))
      .toContain("vitest.child.config.ts: it spreads `base.test`, which is not the test block of a followed root config");
    // A parent that is not among the root configs, and a loop.
    expect(violations({ "vitest.child.config.ts": child("{ ...httpConfig.test }") }))
      .toContain("vitest.child.config.ts: it imports vitest.http.config.ts, which is not a root config");
    expect(violations({
      "vitest.a.config.ts": 'import b from "./vitest.b.config"; export default { test: { ...b.test } };',
      "vitest.b.config.ts": 'import a from "./vitest.a.config"; export default { test: { ...a.test } };',
    }).some((violation) => violation.includes("config inheritance loops"))).toBe(true);
  });
});
