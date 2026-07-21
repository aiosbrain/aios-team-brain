import { describe, it, expect } from "vitest";
import { alertSignature } from "@/lib/ingest/pipeline-alert";
import type { PipelineLeg } from "@/lib/ingest/pipeline-health";

const leg = (over: Partial<PipelineLeg>): PipelineLeg => ({
  source: "plane",
  ok: false,
  error: null,
  at: "2026-07-21T00:00:00Z",
  stale: false,
  ...over,
});

/**
 * The banner dismissal is keyed on this signature: acking the CURRENT failure hides it, but a
 * different failure set must re-show (you can't permanently blind yourself to a new break).
 */
describe("alertSignature", () => {
  it("is stable + order-independent for the same failure set", () => {
    const a = [leg({ source: "plane", error: "timeout" }), leg({ source: "graph_extract", error: "no facts" })];
    const b = [leg({ source: "graph_extract", error: "no facts" }), leg({ source: "plane", error: "timeout" })];
    expect(alertSignature(a)).toBe(alertSignature(b));
  });

  it("changes when a NEW leg breaks (so the alert re-appears)", () => {
    const before = [leg({ source: "plane", error: "timeout" })];
    const after = [leg({ source: "plane", error: "timeout" }), leg({ source: "slack", error: "401" })];
    expect(alertSignature(after)).not.toBe(alertSignature(before));
  });

  it("changes when the error message changes for the same leg", () => {
    expect(alertSignature([leg({ error: "timeout" })])).not.toBe(alertSignature([leg({ error: "429 quota" })]));
  });

  it("distinguishes a stale leg from a hard-failing one", () => {
    const stale = [leg({ source: "github", ok: true, stale: true, error: null })];
    const failing = [leg({ source: "github", ok: false, error: null })];
    expect(alertSignature(stale)).not.toBe(alertSignature(failing));
  });

  it("empty failing set → empty signature", () => {
    expect(alertSignature([])).toBe("");
  });
});
