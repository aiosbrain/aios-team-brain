import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AIO-1167 X-04 / X-04a — the controls that keep GENERIC context reconciliation off a Drive-owned
 * item, pinned where they live.
 *
 * WHY A SHAPE GUARD AS WELL AS BEHAVIOUR. The failure is silent and it is an audience widening: a
 * Drive document, stored `external`, placed in external-shared by a routine sweep. Two call-site
 * filters on stored provenance were the only barrier, deleting either turned no test red, and the
 * locked owner itself asked nothing. The real-PostgreSQL suite
 * (`test/datamechanics/gdrive-context-ownership`) proves what the owner does; this pins that the
 * owner asks FIRST, asks the exact question on its own session, and that the cheap filters in front
 * of it are still there — the candidate query's own terms are pinned in `backfill-candidate-sql`.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `"${start}" must exist`).toBeGreaterThan(-1);
  expect(to, `"${end}" must follow "${start}"`).toBeGreaterThan(from);
  return source.slice(from, to);
}

const RECONCILE = read("lib/projects/context/reconcile-item.ts");

describe("guard: the locked reconcile owner refuses a Drive-owned item before any generic write", () => {
  it("the ownership check is the FIRST thing the shared core does — ahead of the unit mirror, the gate and both membership writers", () => {
    const core = between(
      RECONCILE,
      "export async function reconcileLockedItemContext(",
      "export async function reconcileItemContext("
    );
    const check = core.indexOf("if (await driveOwnsLockedItem(context)) return { ok: true, skipped: true, driveOwned: true };");
    expect(check, "the Drive-ownership refusal must be in the shared core").toBeGreaterThan(-1);
    // Non-vacuous: every one of these is really called here, and each comes after the check.
    for (const next of [
      "reconcileItemUnitLocked(",
      "systemIntegrityGate(",
      "closeMembershipIntoLocked(",
      "ensureIncludeMembershipLocked(",
    ]) {
      const at = core.indexOf(next);
      expect(at, `${next} must be called by the shared core`).toBeGreaterThan(-1);
      expect(check, `the Drive-ownership check must precede ${next}`).toBeLessThan(at);
    }
    // The standalone entry reaches the writers only through that core, on the row it locked.
    const standalone = RECONCILE.slice(RECONCILE.indexOf("export async function reconcileItemContext("));
    expect(standalone).toMatch(/const context = await lockItemContext\(session, teamId, itemId\);[\s\S]*await reconcileLockedItemContext\(context, projects\)/);
    expect(standalone).not.toMatch(/reconcileItemUnitLocked\(|ensureIncludeMembershipLocked\(|closeMembershipIntoLocked\(/);
  });

  it("ownership is stored provenance OR the exact same-team mapping, read on the caller's session, failing closed", () => {
    const owner = between(RECONCILE, "async function driveOwnsLockedItem(", "/** Shared core");
    expect(owner).toMatch(/frontmatter\.source === "gdrive"/);
    // The same transaction/session that holds the row lock — not the pool, not the query builder.
    expect(owner).toMatch(/await context\.session\.executeSql</);
    expect(owner).not.toMatch(/\brunSql\b|\.from\(/);
    expect(owner).toMatch(/select 1 from source_item_mappings m\s+where m\.team_id = \$1 and m\.item_id = \$2 and m\.source = 'gdrive'/);
    expect(owner).toContain("[context.teamId, context.itemId]");
    // Anything but exactly one boolean answer throws — before any write, so nothing is written.
    expect(owner).toMatch(/if \(result\.rows\.length !== 1 \|\| typeof answer !== "boolean"\) \{\s*throw new Error\("Drive ownership could not be read for a locked item"\);/);
    // Nothing about the connection is consulted: none of it ends Drive's ownership.
    expect(owner).not.toMatch(/connection_id|provider_id|gdrive_item_claims|gdrive_connection_authority|integrations|lease|canonical_path/);
  });
});

describe("guard: the call-site filters in front of the owner are retained (X-04a)", () => {
  it("the items route never schedules the post-response reconcile for a Drive-sourced push", () => {
    expect(read("app/api/v1/items/route.ts")).toMatch(
      /if \(\(result\.status !== "unchanged" \|\| result\.accessChanged\) && parsed\.data\.frontmatter\?\.source !== "gdrive"\) \{/
    );
  });

  it("ingest never plans a system-project move for an item whose payload or stored row is Drive-sourced", () => {
    const ingest = read("lib/ingest/index.ts");
    expect(ingest).toMatch(
      /const driveOwnedContext =\s*payload\.frontmatter\?\.source === "gdrive" \|\| storedFrontmatter\.source === "gdrive";/
    );
    expect(ingest).toMatch(/if \(accessChanged && !driveOwnedContext\) \{/);
  });
});
