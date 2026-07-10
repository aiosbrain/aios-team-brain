import { describe, expect, it } from "vitest";
import { buildConfig } from "@/lib/integrations/build-config";
import { validateIntegrationConfig } from "@/lib/api/schemas";

// Spec for the admin form's selection → config mapping. The contract that matters for AIO-323:
// the Linear `inboundApply` opt-in must be threadable from the UI (it previously required prod SQL),
// stay OFF unless explicitly enabled, and produce config the downstream validator accepts.

describe("buildConfig()", () => {
  it("maps a Linear kv selection to the PM mapping hints", () => {
    expect(buildConfig("linear", "teamId=T, projectId=P, doneStateName=Done")).toEqual({
      teamId: "T",
      projectId: "P",
      doneStateName: "Done",
    });
  });

  it("adds inboundApply:true ONLY when the toggle is set", () => {
    expect(buildConfig("linear", "teamId=T", { inboundApply: true })).toEqual({
      teamId: "T",
      inboundApply: true,
    });
    // Default-off: omitted or false must NOT write the flag (gate checks `=== true`).
    expect(buildConfig("linear", "teamId=T")).toEqual({ teamId: "T" });
    expect(buildConfig("linear", "teamId=T", { inboundApply: false })).toEqual({ teamId: "T" });
  });

  it("carries inboundApply even for the bare-projectId Linear form", () => {
    expect(buildConfig("linear", "project-uuid", { inboundApply: true })).toEqual({
      projectId: "project-uuid",
      inboundApply: true,
    });
  });

  it("ignores inboundApply for non-Linear types", () => {
    expect(buildConfig("slack", "C1, C2", { inboundApply: true })).toEqual({
      channelIds: ["C1", "C2"],
    });
    expect(buildConfig("plane", "workspaceSlug=w", { inboundApply: true })).not.toHaveProperty(
      "inboundApply"
    );
  });

  it("produces config the downstream validator accepts (round-trip)", () => {
    const cfg = buildConfig("linear", "teamId=team-uuid", { inboundApply: true });
    expect(validateIntegrationConfig("linear", cfg)).toEqual({
      teamId: "team-uuid",
      inboundApply: true,
    });
  });
});
