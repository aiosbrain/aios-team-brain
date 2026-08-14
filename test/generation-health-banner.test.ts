import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taskLabel } from "@/lib/query/llm-health";

/**
 * The Pulse generation-health banner (LLMOBS-1 §3f).
 *
 * The owner's decision: "when generation is degraded, Pulse should say so and it should have a
 * specific reason." Draft 3 of the spec left Pulse silent — `llm` came OFF the ingestion banner
 * (whose "the brain isn't getting fresh data" is false for a model failure, and which double-counted
 * every arcs failure) with nothing put back. This banner is what replaces it.
 *
 * Source-level because the component is a client component behind two IO calls; what must be pinned
 * is the CONTRACT — degraded-only, per-task reason, and a label map that cannot drift from the
 * server's.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(path.join(ROOT, "components", "admin", "generation-health-banner.tsx"), "utf8");
const PAGE = readFileSync(path.join(ROOT, "app", "t", "[team]", "page.tsx"), "utf8");

describe("guard: the generation banner is degraded-only", () => {
  it("renders nothing unless the leg is degraded", () => {
    // BANNERFLAP-1's rule on the loudest surface there is: a lone failure heals on the next attempt
    // 6 times out of 10 on this install, so `unstable` must NOT paint the home page.
    expect(SRC).toContain('health.state !== "degraded"');
    expect(SRC).toMatch(/failing\.length === 0/);
  });

  it("selects the failing tasks rather than assuming the whole leg failed", () => {
    expect(SRC).toMatch(/health\.tasks\.filter\(\(t\) => t\.state === "degraded"\)/);
  });
});

describe("guard: the reason is specific — feature, model, error", () => {
  it("renders each failing task's own model and its own error", () => {
    // "A specific reason" was the ask. A banner that says "generation is degraded" is the vague
    // sentence this replaces.
    expect(SRC).toContain("t.model");
    expect(SRC).toContain("t.lastError");
  });

  it("names features through a label map, never a raw slug", () => {
    expect(SRC).toMatch(/labelOf\(t\.task\)/);
    // A bare slug in the RENDERED markup is the defect — but `key={t.task}` is a legitimate React key
    // and the first version of this assertion reddened correct code for it. So: every `{t.task}` must
    // be a `key=`, which is the property actually meant.
    for (const m of SRC.matchAll(/(.{6})\{t\.task\}/g)) {
      expect(m[1], `a raw task slug is rendered here: ...${m[0]}`).toContain("key=");
    }
  });

  it("its label map cannot drift from the server's — same slugs, same copy", () => {
    // The component duplicates the map deliberately (importing `llm-health` would drag a server-only
    // module into a client component). Duplication is only safe if something pins them together.
    for (const slug of [
      "arcs",
      "arc-coherence",
      "meeting-summary",
      "meeting-actions",
      "meeting-merge",
      "attribution",
    ]) {
      const server = taskLabel(slug);
      expect(SRC, `the banner is missing copy for \`${slug}\``).toContain(`"${server}"`);
    }
  });

  it("reuses the failing-set dismissal contract, so a NEW failure re-shows a dismissed banner", () => {
    expect(SRC).toMatch(/const signature = failing[\s\S]{0,120}\.join\(","\)/);
    expect(SRC).toContain("localStorage.getItem(storageKey) === signature");
  });
});

describe("guard: Pulse renders it, admin-only", () => {
  it("is mounted on the Pulse page behind the same admin gate as the pipeline banner", () => {
    // The field can ship computed-and-unread; this repo has done it before. Pin the render.
    expect(PAGE).toContain("<GenerationHealthBanner");
    expect(PAGE).toMatch(/isAdmin \? getLlmHealth\(team\.id\) : Promise\.resolve\(null\)/);
  });
});
