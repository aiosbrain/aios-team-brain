import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taskLabel } from "@/lib/query/llm-health";
import { LLM_TASK_NAMES } from "@/lib/query/llm-task";

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
    // A bare slug in the RENDERED MARKUP is the defect. Scoped to the JSX region (from the component's
    // `return (` onward) because non-render uses are legitimate and kept tripping earlier versions of
    // this assertion: `key={t.task}` is a React key, and the dismissal signature builds `${t.task}:…`
    // in a template literal above the return. Twice now this guard has reddened correct code by
    // pinning a shape instead of the property, which is its own small lesson.
    const jsx = SRC.slice(SRC.indexOf("  return ("));
    for (const m of jsx.matchAll(/(.{6})\{t\.task\}/g)) {
      expect(m[1], `a raw task slug is rendered here: ...${m[0]}`).toContain("key=");
    }
  });

  it("its label map cannot drift from the server's — every KNOWN task, same copy", () => {
    // The component duplicates the map deliberately (importing `llm-health` would drag a server-only
    // module into a client component). Duplication is only safe if something pins them together.
    //
    // Derived from `LLM_TASK_NAMES`, NOT a hard-coded list: review found the first version enumerated
    // its own six slugs, so a seventh task added to the union and the server map — but forgotten in
    // the client map — stayed green and rendered a raw slug on Pulse. A guard with its own copy of the
    // vocabulary is a second source of truth, which is the thing it was meant to prevent.
    //
    // Scoped to the LABELS object too: asserting the phrase appears ANYWHERE in the file let a
    // comment containing it mask a drifted entry.
    const labels = SRC.slice(SRC.indexOf("const LABELS"));
    const block = labels.slice(0, labels.indexOf("};") + 2);
    for (const slug of LLM_TASK_NAMES) {
      const server = taskLabel(slug);
      expect(block, `the banner's LABELS is missing copy for \`${slug}\``).toContain(`"${server}"`);
    }
  });

  it("reuses the failing-set dismissal contract, so a NEW failure re-shows a dismissed banner", () => {
    // The signature must carry the ERROR, not just the failing set — that is the contract
    // `lib/ingest/pipeline-alert.alertSignature` states ("an error message changes → the alert
    // re-appears"), and the first version keyed on task names alone while its comment claimed to
    // mirror it. Assert the ingredients rather than the exact expression, so a reformat does not
    // redden correct code.
    const sig = SRC.slice(SRC.indexOf("const signature = failing"));
    const expr = sig.slice(0, sig.indexOf(".join("));
    expect(expr).toContain("t.task");
    expect(expr).toContain("t.lastError");
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
