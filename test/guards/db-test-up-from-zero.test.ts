import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `npm run db:test:up` must be RE-RUNNABLE against any prior state.
 *
 * The regression this guards (see scripts/db-test-up.sh's header): the command was
 * `docker compose … up -d --wait && … npm run pg:schema`. Compose `up` on an already-running
 * container is a no-op, so the tmpfs data dir survived and the schema replayed onto a dirty DB —
 * which is (a) not the from-zero replay proof the command is relied on for, and (b) able to abort
 * part-way on the PRET-6 production guard (a dm run leaves `teams.access_enforcement` re-armed at
 * its `'permissive'` default), leaving the container UP with an incomplete schema.
 *
 * Three invariants, structural because the behavioural proof costs a container:
 *   1. the bring-up resets before it loads (from zero, every time);
 *   2. EVERY fallible step tears the container down, so "up" never means "half-loaded";
 *   3. none of this was bought by weakening the PRET-6 production guard.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const script = () => readFileSync(join(ROOT, "scripts", "db-test-up.sh"), "utf8");
/** The executable body only — the header comment quotes the old, broken command on purpose. */
const body = () =>
  script()
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
const pkg = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe("db:test:up brings the test Postgres up from zero", () => {
  it("delegates to scripts/db-test-up.sh — the reset cannot live in a package.json one-liner", () => {
    expect(pkg().scripts["db:test:up"]).toBe("bash scripts/db-test-up.sh");
  });

  it("resets the volume BEFORE starting the container", () => {
    const src = body();
    const down = src.indexOf("down -v");
    const up = src.indexOf("up -d --wait");
    expect(down, "the script must tear the old container + volume down").toBeGreaterThan(-1);
    expect(up, "the script must start the container").toBeGreaterThan(-1);
    expect(down, "the reset must come first, or the schema replays onto a dirty DB").toBeLessThan(up);
  });

  it("verifies the reset actually removed the container (a swallowed `down` failure is the defect, back)", () => {
    expect(body(), "the script must assert no compose container survived the down").toMatch(/ps -aq/);
  });

  it("removes the container when ANY step of the bring-up fails (no half-loaded container left up)", () => {
    const src = body();
    // Both fallible steps route their failure through the same handler. `up -d --wait` counts:
    // it fails when the healthcheck never goes green, and leaves the container behind.
    expect(src, "starting the container must be guarded").toMatch(/up -d --wait \|\| fail/);
    expect(src, "the schema load must be guarded").toMatch(/npm run pg:schema \|\| fail/);
    // …and the handler removes the container + volume and fails the command.
    const handler = src.slice(src.indexOf("fail()"), src.indexOf("up -d --wait"));
    expect(handler, "the failure handler must tear the container down").toMatch(/teardown|down -v/);
    expect(handler, "and must exit non-zero").toMatch(/exit "?\$?\{?rc|exit 1/);
    expect(src, "teardown must remove the volume, not just stop the container").toMatch(
      /teardown\(\)[^\n]*down -v/
    );
  });

  it("does not weaken the PRET-6 production guard to get the test DB up", () => {
    const migration = readFileSync(
      join(ROOT, "postgres", "migrations", "20260818210000_pret6_retire_access_enforcement.sql"),
      "utf8"
    );
    expect(migration).toContain("PRET-6 refused: permissive team(s) remain");
    expect(migration.replace(/--[^\n]*/g, "")).toMatch(/perform\s+materialize_builtin_membership_once\s*\(\s*\)/i);
    // The permissive refusal and materialization must stay unconditional. The hazard is
    // either operation made SKIPPABLE by an
    // ambient signal (an env var / session GUC read in the guard), not the mere presence of
    // `current_setting`, which has legitimate uses in a migration.
    for (const raise of migration.matchAll(/(?:raise exception 'PRET-6|perform\s+materialize_builtin_membership_once)[^\n]*/g)) {
      expect(raise[0], "neither refusal nor reconciliation may depend on an env/test signal").not.toMatch(
        /current_setting|NODE_ENV|AIOS_|_TEST|CI\b/
      );
    }
    expect(migration, "no environment-keyed bypass may gate the guard block").not.toMatch(
      /current_setting\s*\(\s*'(app|aios)\.|NODE_ENV|AIOS_|_TEST|\bCI\b/i
    );
  });
});
