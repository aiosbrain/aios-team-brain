import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: a save-time warning must actually reach the admin, and must not be styled as success.
 *
 * The whole value of `structuredOutputWarning` is that it appears at the MOMENT the model is chosen —
 * a warning computed and dropped is worth exactly nothing, and one rendered emerald reads as "all
 * good", which is worse than silence. Both are one careless edit away, and neither would fail any
 * behavioural test, so they are pinned here.
 */
describe("guard: the structured-output warning is surfaced, in amber", () => {
  const ui = readFileSync(join(process.cwd(), "components", "admin", "integrations-manager.tsx"), "utf8");
  const action = readFileSync(
    join(process.cwd(), "app", "t", "[team]", "admin", "integrations", "actions.ts"),
    "utf8"
  );

  it("the save action computes it", () => {
    expect(action).toContain("structuredOutputWarning");
    expect(action).toContain("checkStructuredOutputSupport");
  });

  it("the UI consumes `res.warning` rather than dropping it", () => {
    expect(ui).toMatch(/setWarning\(res\.warning/);
  });

  it("it renders amber, NOT the emerald success style", () => {
    const block = ui.slice(ui.indexOf("{warning ?"), ui.indexOf("{warning ?") + 400);
    expect(block, "a caution styled as success defeats the point").toContain("amber");
    expect(block).not.toContain("emerald");
  });
});
