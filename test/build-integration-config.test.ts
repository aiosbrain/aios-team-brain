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

describe("notion — the token is the secret, the selection is what to pull", () => {
  it("treats plain entries as page ids", () => {
    expect(buildConfig("notion", "abc123, def456")).toEqual({ pageIds: ["abc123", "def456"] });
  });

  it("`databaseId=<id>` selects a whole database INSTEAD of pages (the connector takes one or the other)", () => {
    expect(buildConfig("notion", "databaseId=db_42")).toEqual({ databaseId: "db_42" });
  });

  it("an empty selection is savable — a half-configured integration must not be un-persistable", () => {
    expect(buildConfig("notion", "")).toEqual({ pageIds: [] });
  });
});

describe("clickup — the pk_ token is the secret, the selection is workspace + Lists + Docs", () => {
  it("parses workspace, Lists and Docs out of the one free-text field", () => {
    // `,` is the OUTER separator (toList), so a multi-value entry needs `|`.
    expect(buildConfig("clickup", "workspaceId=9001, listIds=101|202, docIds=doc-a|doc-b")).toEqual({
      workspaceId: "9001",
      listIds: ["101", "202"],
      docIds: ["doc-a", "doc-b"],
    });
  });

  it("an empty selection is savable — a half-configured integration must not be un-persistable", () => {
    // Matches the notion stance: the admin saves the token first and picks Lists after. `default:`
    // returning `{}` would ALSO have been savable, which is exactly why this needs its own case —
    // a missing switch arm is not a compile error here, it silently stores an empty config.
    expect(buildConfig("clickup", "")).toEqual({ listIds: [] });
  });

  it("reads a lone bare token as the workspace id rather than silently dropping it", () => {
    // The hint says `workspaceId=…`, but an admin who types just the id would otherwise save an
    // empty config with no complaint — the one failure here that is silent rather than a visible
    // 400. linear/plane already fall back this way for `projectId`.
    expect(buildConfig("clickup", "9001")).toEqual({ workspaceId: "9001", listIds: [] });
    // An explicit key always wins over the fallback.
    expect(buildConfig("clickup", "9001, workspaceId=7777")).toEqual({ workspaceId: "7777", listIds: [] });
    // Ambiguous (two bare tokens) stays dropped — guessing which is the workspace would be worse.
    expect(buildConfig("clickup", "9001, 9002")).toEqual({ listIds: [] });
  });

  it("produces config the downstream validator accepts (round-trip)", () => {
    const cfg = buildConfig("clickup", "workspaceId=9001, listIds=101, docParentType=space, docParentId=s1");
    expect(validateIntegrationConfig("clickup", cfg)).toEqual({
      workspaceId: "9001",
      listIds: ["101"],
      docParentType: "SPACE", // upper-cased for the enum, so a lowercase entry is not a save failure
      docParentId: "s1",
    });
  });
});
