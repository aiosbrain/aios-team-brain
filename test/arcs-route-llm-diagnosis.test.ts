import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The arcs API must diagnose from the ARCS TASK, not the whole answering-model leg (LLMOBS-1 §3e).
 *
 * `app/api/brain/arcs/route.ts` tells a user WHY their Learning arcs panel is empty, and one of its
 * answers is "the model is failing", read from `getLlmHealth`. That was sound while every
 * `source='llm'` row WAS an arcs row. After this slice widens recording it is false: a confirmed
 * `meeting-summary` failure on the query model would tell a user their arcs are empty because the
 * model is failing — while the reasoning model that actually synthesises arcs is perfectly healthy.
 *
 * A false diagnosis on a USER-FACING surface, created by the widening. Review found it as an
 * unenumerated consumer — the spec had named zero, and there are exactly two.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(path.join(ROOT, "app", "api", "brain", "arcs", "route.ts"), "utf8");

describe("guard: the empty-arcs diagnosis is task-scoped", () => {
  it("keys on the `arcs` task's state, not the leg's", () => {
    expect(SRC).toMatch(/llm\.tasks\.some\(\(t\) => t\.task === "arcs" && t\.state === "degraded"\)/);
  });

  it("does NOT key on the leg-level state, which now aggregates unrelated tasks", () => {
    // The exact regression: `llm.state === "degraded"` here makes a meeting-summary outage blame the
    // arcs model to a user.
    expect(SRC).not.toMatch(/llm\.state === "degraded"/);
  });
});
