import { describe, expect, it } from "vitest";
import { buildAgentOnboardingPrompt } from "./agent-prompt";

describe("buildAgentOnboardingPrompt", () => {
  it("substitutes the team slug and brain url into the scaffold command", () => {
    const prompt = buildAgentOnboardingPrompt({
      teamSlug: "acme",
      brainUrl: "https://brain.acme.example.com",
    });

    expect(prompt).toContain('"acme" team');
    expect(prompt).toContain("--brain-url https://brain.acme.example.com");
    expect(prompt).toContain("--team-id acme");
  });

  it("keeps the human-readable doc URL as a fallback for non-agent readers", () => {
    const prompt = buildAgentOnboardingPrompt({ teamSlug: "acme", brainUrl: "https://x.test" });
    expect(prompt).toContain("https://aiosbrain.dev/getting-started/onboarding-a-contributor/");
  });

  it("tells the agent to self-serve the API key from the dashboard, not an admin", () => {
    const prompt = buildAgentOnboardingPrompt({ teamSlug: "acme", brainUrl: "https://x.test" });
    expect(prompt).toMatch(/My API keys.*not from an admin/s);
  });
});
