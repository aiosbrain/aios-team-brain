import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BUILD-FAILING GUARDS for the two things `tsc` cannot express about BANNERFLAP-1.
 *
 * Exhaustiveness over `LlmHealthState` is NOT tested here — that is the compiler's job, via the
 * `Record<LlmHealthState, …>` in the card. Spec review was explicit that a text-matching guard cannot
 * catch the class it would be aimed at (a future `state !== "healthy"` derived boolean slips straight
 * past a grep), so the type system does that half and this file pins the two PROPERTIES types cannot:
 *
 *   1. `unstable` must not render as the grey "off" leg captioned "no recent activity recorded". That
 *      is what the ternary chain this replaced actually did — a false statement about a leg that had
 *      just failed, and one every test and `tsc` accepted.
 *   2. The banner must render `failingSince`, not `at`. `at` is the NEWEST run, so a leg failing for
 *      three days was labelled "failing since 20 minutes ago" every time the poller re-failed — the
 *      exact lying-duration defect the field was added to fix. A field can ship computed-and-unread
 *      with every other criterion green (this repo has done it before), so the render is pinned here.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const CARD = "components/admin/retrieval-health-card.tsx";
const BANNER = "components/admin/pipeline-health-banner.tsx";

describe("guard: the LLM leg renders `unstable` honestly", () => {
  it("maps the state through an exhaustive Record, not a ternary chain", () => {
    const src = read(CARD);
    // The mechanism, not the outcome: a Record over the union cannot be written incompletely, so
    // adding a state is a compile error rather than a silent fall-through. Pinned because a later
    // "simplification" back to a ternary would reopen the hole with every test still green.
    expect(src, `${CARD} must map LlmHealthState through a Record so tsc enforces exhaustiveness`)
      .toMatch(/Record<LlmHealthState,/);
    const map = src.slice(src.indexOf("Record<LlmHealthState,"));
    const body = map.slice(0, map.indexOf("}") + 1);
    for (const state of ["healthy", "unstable", "degraded", "unknown"]) {
      expect(body, `the state map is missing \`${state}\``).toContain(`${state}:`);
    }
  });

  it("does not render `unstable` as the grey off-leg", () => {
    const src = read(CARD);
    const map = src.slice(src.indexOf("Record<LlmHealthState,"));
    const body = map.slice(0, map.indexOf("}") + 1);
    // The specific regression: `unstable: "off"` would restore the grey dot the chain produced.
    expect(body).not.toMatch(/unstable:\s*"off"/);
  });

  it("does not caption `unstable` 'no recent activity recorded' — there IS recent activity", () => {
    const src = read(CARD);
    // The false statement itself. It may still exist for `unknown`, which is what it is true of, so
    // the assertion is that the unstable BRANCH does not produce it rather than that the string is
    // absent from the file.
    const detail = src.slice(src.indexOf("const llmDetail"));
    // Bounded to the CONSEQUENT of the unstable branch — between its `?` and the `:` that starts the
    // next arm. A fixed-width slice ran past it into the `unknown` fallback (where the phrase is both
    // present and true) and reddened on correct code; the guard caught its own imprecision first.
    const arm = detail.slice(detail.indexOf('llm.state === "unstable"'));
    const consequent = arm.slice(arm.indexOf("?") + 1, arm.indexOf("\n          : "));
    expect(consequent, "the unstable arm must not be bounded incorrectly").toContain("failed once");
    expect(consequent).not.toContain("no recent activity recorded");
  });
});

describe("guard: the banner renders the duration it actually computed", () => {
  it("renders `failingSince`, not `at`, under its 'failing since' label", () => {
    const src = read(BANNER);
    // Anchored on the rendered template, so computing the field and forgetting to display it reddens.
    expect(src, `${BANNER} must render failingSince under the "failing since" label`).toMatch(
      /failing\{l\.failingSince \? ` since \$\{timeAgo\(l\.failingSince\)\}` : ""\}/
    );
    expect(src, "the newest-run timestamp must not be labelled 'failing since'").not.toMatch(
      /failing\{l\.at \? ` since/
    );
  });
});
