import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ADOPTDECL-1 — the ingest side of the declaration, and specifically the WITHDRAWAL.
 *
 * A declared key is load-bearing after this slice: if it resolves to nothing the row fails on every
 * run. So the way a human takes it back — deleting `pm_external_id` from the markdown — has to actually
 * clear the column, or the failure is permanent with no remedy short of manual SQL.
 *
 * Two shapes of that were specced wrong before review caught them, and both are pinned here:
 *
 *   • conditioning the clear on `pm_provider` still being present. The NATURAL withdrawal deletes BOTH
 *     fields, so that trigger never fires for the case people actually hit.
 *   • clearing via an upsert. `provider_external_id` is `not null` with no default, so an insert leg
 *     has no legal value to supply for a row that has no link yet — it would throw inside the push, or
 *     force ingest to invent the very default this column exists to escape.
 *
 * These assert the SOURCE of `materializeTasks` rather than running it, deliberately: the behaviour is
 * a DB write shape, and the real round-trip is pinned in
 * `test/datamechanics/pm-sync-declared-adoption.datamechanics.test.ts` against real Postgres. What a
 * unit test can add here is that the two refuted shapes have not crept back.
 */

const SRC = readFileSync(join(process.cwd(), "lib/ingest/tasks.ts"), "utf8");

/** The `else` branch that runs when a row does NOT carry both pm fields. */
const clearBranch = (): string => {
  const start = SRC.indexOf("if (row.pm_provider && row.pm_external_id)");
  expect(start, "the declaration branch has moved — this test is reading the wrong code").toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  const elseAt = rest.indexOf("} else {");
  expect(elseAt, "there is no withdrawal branch at all").toBeGreaterThan(-1);
  return rest.slice(elseAt, elseAt + 1200);
};

describe("ADOPTDECL-1 — ingest sets and clears declared_external_id", () => {
  it("sets it from pm_external_id when the row declares one", () => {
    expect(SRC).toMatch(/declared_external_id:\s*row\.pm_external_id/);
  });

  it("clears it with an UPDATE, never an upsert — provider_external_id is NOT NULL with no default", () => {
    const branch = clearBranch();
    expect(branch).toMatch(/\.update\(\s*\{\s*declared_external_id:\s*null/);
    expect(branch, "an upsert here would have no legal provider_external_id to supply").not.toMatch(
      /\.upsert\(/
    );
    expect(branch, "an insert here would create links that never existed before").not.toMatch(/\.insert\(/);
  });

  it("the clear does NOT require pm_provider — the natural withdrawal deletes both fields", () => {
    // The refuted trigger. If the clear sat behind `if (row.pm_provider)`, deleting both fields would
    // leave the stale declaration in place exactly when the human believed they had removed it.
    const branch = clearBranch();
    expect(branch).not.toMatch(/if\s*\(\s*row\.pm_provider\s*\)/);
  });

  it("the clear is scoped to the row, not to a provider — every provider's link for it is cleared", () => {
    const branch = clearBranch();
    expect(branch).toMatch(/\.eq\("row_key",\s*row\.row_key\)/);
    expect(branch).not.toMatch(/\.eq\("provider"/);
  });
});
