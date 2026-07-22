import { describe, expect, it } from "vitest";
import {
  validateIntegrationConfig,
  IntegrationConfigError,
} from "@/lib/api/schemas";

// Spec for the integration config gate. The `integrations.config` jsonb must hold NON-SECRET
// selection only — secrets stay in the sidecar's local config. These assertions are the contract.

describe("validateIntegrationConfig()", () => {
  it("accepts a valid per-type config and normalizes defaults", () => {
    expect(
      validateIntegrationConfig("github", {
        repos: ["aiosbrain/aios-team-brain"],
      }),
    ).toEqual({
      repos: ["aiosbrain/aios-team-brain"],
    });
    expect(validateIntegrationConfig("github", {})).toEqual({ repos: [] }); // default applied
  });

  it("rejects unknown keys (strict allowlist)", () => {
    expect(() =>
      validateIntegrationConfig("slack", { channelIds: ["C1"], extra: 1 }),
    ).toThrow(IntegrationConfigError);
  });

  it("rejects a secret-like key anywhere, even if otherwise well-formed", () => {
    for (const bad of [
      { token: "xoxb-123" },
      { apiKey: "sk-1" },
      { api_key: "sk-1" },
      { password: "p" },
      { bearer: "b" },
      { client_secret: "c" },
    ]) {
      expect(
        () => validateIntegrationConfig("wise", bad),
        JSON.stringify(bad),
      ).toThrow(/secret-like key/i);
    }
  });

  it("rejects a secret-like key nested inside an allowed structure", () => {
    // even within github.repos shape, a nested token key is caught by the recursive scan
    expect(() =>
      validateIntegrationConfig("granola", {
        participantEmails: [],
        secretToken: "x",
      }),
    ).toThrow(/secret-like key/i);
  });

  it("rejects oversized config (byte cap)", () => {
    const huge = {
      repos: Array.from({ length: 5000 }, (_, i) => `org/repo-${i}`),
    };
    expect(() => validateIntegrationConfig("github", huge)).toThrow(/exceeds/);
  });

  it("validates email shape in granola participant allowlist", () => {
    expect(() =>
      validateIntegrationConfig("granola", {
        participantEmails: ["not-an-email"],
      }),
    ).toThrow(IntegrationConfigError);
    expect(
      validateIntegrationConfig("granola", {
        participantEmails: ["john@aios.dev"],
        matchKeywords: ["AIOS"],
      }),
    ).toEqual({
      participantEmails: ["john@aios.dev"],
      matchKeywords: ["AIOS"],
    });
  });

  it("accepts Plane and Linear PM sync mapping hints", () => {
    expect(
      validateIntegrationConfig("plane", {
        workspaceSlug: "aios-alpha",
        projectId: "plane-project",
        doneStateName: "DONE",
        externalSource: "aios-backlog",
      }),
    ).toEqual({
      workspaceSlug: "aios-alpha",
      projectId: "plane-project",
      doneStateName: "DONE",
      externalSource: "aios-backlog",
    });
    expect(
      validateIntegrationConfig("linear", {
        teamId: "team-uuid",
        projectId: "project-uuid",
        doneStateName: "Done",
      }),
    ).toEqual({
      teamId: "team-uuid",
      projectId: "project-uuid",
      doneStateName: "Done",
    });
  });

  it("accepts the Linear inboundApply opt-in (brain-api v1.4) but still no secret-like keys", () => {
    expect(
      validateIntegrationConfig("linear", {
        teamId: "team-uuid",
        inboundApply: true,
      }),
    ).toEqual({
      teamId: "team-uuid",
      inboundApply: true,
    });
    // Boundary regression for the DEFERRED webhook work: a webhook signing secret has no home in
    // config — the secret-key scan must keep rejecting it (it belongs in an encrypted column).
    expect(() =>
      validateIntegrationConfig("linear", { webhookSecret: "whsec_x" }),
    ).toThrow(/secret-like key/i);
    // …and any other webhook-ish key is rejected by the strict allowlist.
    expect(() =>
      validateIntegrationConfig("linear", { webhookUrl: "https://x" }),
    ).toThrow(IntegrationConfigError);
  });

  it("accepts the member-onboarding provisioning keys (linear/slack/github) but rejects secret-like ones", () => {
    // Linear invite hints
    expect(
      validateIntegrationConfig("linear", {
        teamId: "t",
        inviteTeamIds: ["T1", "T2"],
        inviteRole: "guest",
      }),
    ).toEqual({
      teamId: "t",
      inviteTeamIds: ["T1", "T2"],
      inviteRole: "guest",
    });
    // an invalid role is rejected by the enum
    expect(() =>
      validateIntegrationConfig("linear", { inviteRole: "owner" }),
    ).toThrow(IntegrationConfigError);
    // Slack invite link (must be a URL)
    expect(
      validateIntegrationConfig("slack", {
        inviteLink: "https://join.slack.com/t/x/abc",
      }),
    ).toEqual({
      channelIds: [],
      inviteLink: "https://join.slack.com/t/x/abc",
    });
    expect(() =>
      validateIntegrationConfig("slack", { inviteLink: "not-a-url" }),
    ).toThrow(IntegrationConfigError);
    // GitHub org
    expect(validateIntegrationConfig("github", { org: "acme" })).toEqual({
      repos: [],
      org: "acme",
    });
    // The new keys must not trip the secret-key scan, but a real secret-like sibling still does.
    expect(() =>
      validateIntegrationConfig("github", { org: "acme", token: "ghp_x" }),
    ).toThrow(/secret-like key/i);
  });

  it("keeps the key itself in secret_ciphertext — config holds only the optional answer model", () => {
    for (const type of [
      "openai",
      "anthropic",
      "openrouter",
      "google",
    ] as const) {
      // Empty config is always valid (the key lives in secret_ciphertext).
      expect(validateIntegrationConfig(type, {})).toEqual({});
      // A key-like field is caught by the secret-key scan before the allowlist.
      expect(() => validateIntegrationConfig(type, { apiKey: "sk-1" })).toThrow(
        /secret-like key/i,
      );
      // Unknown non-secret keys are still rejected by the strict allowlist.
      expect(() =>
        validateIntegrationConfig(type, { temperature: 0.5 }),
      ).toThrow(IntegrationConfigError);
    }
    // openai/anthropic/openrouter carry a NON-secret answer-model slug; google stays config-less.
    for (const type of ["openai", "anthropic", "openrouter"] as const) {
      expect(validateIntegrationConfig(type, { model: "some-model" })).toEqual({
        model: "some-model",
      });
    }
    expect(() =>
      validateIntegrationConfig("google", { model: "gemini" }),
    ).toThrow(IntegrationConfigError);
  });
});

describe("INTEGRATION_TYPES", () => {
  it("includes the LLM provider key types", async () => {
    const { INTEGRATION_TYPES, PROVIDER_INTEGRATION_TYPES } =
      await import("@/lib/api/schemas");
    for (const t of PROVIDER_INTEGRATION_TYPES) {
      expect(INTEGRATION_TYPES).toContain(t);
    }
    expect([...PROVIDER_INTEGRATION_TYPES].sort()).toEqual([
      "anthropic",
      "google",
      "openai",
      "openrouter",
    ]);
  });

  it("openrouter carries a NON-secret model config (rejects unknown keys, allows model)", async () => {
    const { validateIntegrationConfig } = await import("@/lib/api/schemas");
    expect(
      validateIntegrationConfig("openrouter", { model: "openai/gpt-4o-mini" }),
    ).toEqual({
      model: "openai/gpt-4o-mini",
    });
    expect(() =>
      validateIntegrationConfig("openrouter", { apiKey: "sk-or-x" }),
    ).toThrow(); // secret rejected
  });
});
