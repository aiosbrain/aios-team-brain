import { describe, expect, it } from "vitest";
import { validateIntegrationConfig, IntegrationConfigError } from "@/lib/api/schemas";

// Spec for the integration config gate. The `integrations.config` jsonb must hold NON-SECRET
// selection only — secrets stay in the sidecar's local config. These assertions are the contract.

describe("validateIntegrationConfig()", () => {
  it("accepts a valid per-type config and normalizes defaults", () => {
    expect(validateIntegrationConfig("github", { repos: ["AIOS-alpha/aios-team-brain"] })).toEqual({
      repos: ["AIOS-alpha/aios-team-brain"],
    });
    expect(validateIntegrationConfig("github", {})).toEqual({ repos: [] }); // default applied
  });

  it("rejects unknown keys (strict allowlist)", () => {
    expect(() => validateIntegrationConfig("slack", { channelIds: ["C1"], extra: 1 })).toThrow(
      IntegrationConfigError
    );
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
      expect(() => validateIntegrationConfig("wise", bad), JSON.stringify(bad)).toThrow(
        /secret-like key/i
      );
    }
  });

  it("rejects a secret-like key nested inside an allowed structure", () => {
    // even within github.repos shape, a nested token key is caught by the recursive scan
    expect(() =>
      validateIntegrationConfig("granola", { participantEmails: [], secretToken: "x" })
    ).toThrow(/secret-like key/i);
  });

  it("rejects oversized config (byte cap)", () => {
    const huge = { repos: Array.from({ length: 5000 }, (_, i) => `org/repo-${i}`) };
    expect(() => validateIntegrationConfig("github", huge)).toThrow(/exceeds/);
  });

  it("validates email shape in granola participant allowlist", () => {
    expect(() =>
      validateIntegrationConfig("granola", { participantEmails: ["not-an-email"] })
    ).toThrow(IntegrationConfigError);
    expect(
      validateIntegrationConfig("granola", { participantEmails: ["john@aios.dev"], matchKeywords: ["AIOS"] })
    ).toEqual({ participantEmails: ["john@aios.dev"], matchKeywords: ["AIOS"] });
  });
});
