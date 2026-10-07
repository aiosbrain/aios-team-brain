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
 */
const ROOT = join(import.meta.dirname, "..", "..");
const SETUP_FILE = "test/datamechanics/setup.ts";
const RUN_INITIALIZER = "test/datamechanics/global-setup.ts";

const CONFIGS = readdirSync(ROOT).filter((name) => /^vitest(\.[a-z0-9-]+)?\.config\.ts$/.test(name)).sort();

interface Wiring { setupFiles: string[] | null; globalSetup: string[] | null }

/** The string array a key is set to in this file's own text, or null if the file does not set it. */
function ownList(source: string, key: "setupFiles" | "globalSetup"): string[] | null {
  const found = [...source.matchAll(new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`, "g"))];
  if (found.length === 0) return null;
  expect(found, `${key} must be set at most once per config`).toHaveLength(1);
  return [...found[0][1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
}

/** The config whose `test` block this one spreads, if any: `import x from "./vitest.<n>.config"` + `...x.test`. */
function parentOf(source: string): string | null {
  for (const imported of source.matchAll(/import\s+(\w+)\s+from\s+["']\.\/(vitest(?:\.[a-z0-9-]+)?\.config)["']/g)) {
    if (new RegExp(`\\.\\.\\.${imported[1]}\\.test\\b`).test(source)) return `${imported[2]}.ts`;
  }
  return null;
}

/** What a config ends up with: its own value where it sets one, otherwise what it inherits. */
function wiringOf(name: string, seen: string[] = []): Wiring {
  expect(seen, `config inheritance must not loop: ${[...seen, name].join(" → ")}`).not.toContain(name);
  const source = readFileSync(join(ROOT, name), "utf8");
  const parent = parentOf(source);
  const inherited: Wiring = parent ? wiringOf(parent, [...seen, name]) : { setupFiles: null, globalSetup: null };
  return {
    setupFiles: ownList(source, "setupFiles") ?? inherited.setupFiles,
    globalSetup: ownList(source, "globalSetup") ?? inherited.globalSetup,
  };
}

describe("guard: a config that truncates through the data-mechanics setup also initializes its run-safety state", () => {
  const truncating = CONFIGS.filter((name) => wiringOf(name).setupFiles?.includes(SETUP_FILE));

  it("finds the configs that reuse the setup file — by name AND by inheritance", () => {
    // Non-vacuous, and exact: a tier added tomorrow must be looked at, not silently included.
    expect(CONFIGS).toContain("vitest.config.ts");
    expect(truncating).toEqual([
      "vitest.datamechanics.config.ts",
      "vitest.http.config.ts",
      "vitest.mcp.config.ts",
      "vitest.tierret1-query.config.ts",
    ]);
    // Two of them never spell the setup file's path: they get it by spreading the HTTP config.
    for (const inheriting of ["vitest.mcp.config.ts", "vitest.tierret1-query.config.ts"]) {
      expect(readFileSync(join(ROOT, inheriting), "utf8")).not.toContain(SETUP_FILE);
      expect(parentOf(readFileSync(join(ROOT, inheriting), "utf8"))).toBe("vitest.http.config.ts");
    }
  });

  it.each(truncating)("%s runs the run-safety initializer, first", (name) => {
    const { globalSetup } = wiringOf(name);
    expect(globalSetup, `${name} reuses ${SETUP_FILE} and so must list ${RUN_INITIALIZER} in globalSetup`).not.toBeNull();
    expect(globalSetup![0], `${RUN_INITIALIZER} must be the FIRST global setup of ${name}`).toBe(RUN_INITIALIZER);
    expect(globalSetup!.filter((entry) => entry === RUN_INITIALIZER)).toHaveLength(1);
  });

  it("the initializer and the setup file are where the configs say they are, and the setup file is the one that needs it", () => {
    const setup = readFileSync(join(ROOT, SETUP_FILE), "utf8");
    expect(setup).toContain("assertRunSafe();");
    expect(readFileSync(join(ROOT, RUN_INITIALIZER), "utf8")).toMatch(/export default function setup\(/);
  });
});
