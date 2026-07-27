import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * BUILD-FAILING GUARD: exactly ONE work-key matcher, in `scripts/pr-work-keys.mjs`.
 *
 * Two workflows read a PR for the ticket it cites — `pr-task-link.yml` warns about it, and
 * `aios-work-sync.yml` posts it on merge to move the task to Done. Each carried its own inline copy of
 * the regex and the body-stripping, so they could disagree about what counts as a cited key: the check
 * clears a PR, and the step that actually closes tickets then reads it differently. Both copies also sat
 * in YAML heredocs no test tier could reach, which is how the tasks-response parser shipped reading a
 * shape the endpoint never returns and reported a REAL key as nonexistent.
 *
 * Discovered from the workflow files rather than a hardcoded list, so a NEW workflow that inlines its own
 * copy fails this too.
 */

const WORKFLOWS = join(process.cwd(), ".github", "workflows");

/** The distinctive fragment of the matcher — any inline re-implementation contains it. */
const INLINE_MATCHER = "AIOS-Work:\\s*";

describe("guard: one work-key matcher, shared and tested", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  it("finds the workflows to check (or this guard is vacuous)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no workflow inlines its own copy of the work-key regex", () => {
    const offenders = files.filter((f) => readFileSync(join(WORKFLOWS, f), "utf8").includes(INLINE_MATCHER));
    expect(
      offenders,
      `these workflows inline the work-key matcher instead of importing scripts/pr-work-keys.mjs — two ` +
        `copies can disagree about which ticket a PR cites, and an inline copy is untestable`
    ).toEqual([]);
  });

  it("every workflow that reads work keys imports the shared module", () => {
    const readers = files.filter((f) => readFileSync(join(WORKFLOWS, f), "utf8").includes("work_keys") || readFileSync(join(WORKFLOWS, f), "utf8").includes("work-key"));
    expect(readers.length, "no workflow reads work keys — has the feature moved?").toBeGreaterThan(0);
    for (const f of readers) {
      expect(readFileSync(join(WORKFLOWS, f), "utf8"), `${f} reads work keys without the shared matcher`).toContain(
        "scripts/pr-work-keys.mjs"
      );
    }
  });
});
