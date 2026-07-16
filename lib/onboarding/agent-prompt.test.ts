import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAgentOnboardingPrompt } from "./agent-prompt";

const contract = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "..",
      "test",
      "fixtures",
      "contract",
      "onboarding-orchestration.json",
    ),
    "utf8",
  ),
) as { requiredMarkers: string[] };

describe("buildAgentOnboardingPrompt", () => {
  it("uses the authenticated dashboard's known team context without treating it as approved", () => {
    const prompt = buildAgentOnboardingPrompt({
      teamSlug: "acme",
      teamName: "acme",
      brainUrl: "https://brain.acme.example.com",
    });

    expect(prompt).toContain('team "acme"');
    expect(prompt).toContain("(acme)");
    expect(prompt).toContain(
      "candidate Brain URL: https://brain.acme.example.com",
    );
    expect(prompt).toMatch(
      /candidate only.*canonical Brain origin.*human gate/s,
    );
  });

  it("greets with the team's proper-cased display name, not its lowercase URL slug", () => {
    const prompt = buildAgentOnboardingPrompt({
      teamSlug: "acme-corp",
      teamName: "Acme Corp",
      brainUrl: "https://x.test",
    });

    expect(prompt).toContain('team "Acme Corp"');
    expect(prompt).not.toContain('team "acme-corp"');
    expect(prompt).toContain("(acme-corp)");
  });

  it("keeps the human-readable doc URL as a fallback for non-agent readers", () => {
    const prompt = buildAgentOnboardingPrompt({
      teamSlug: "acme",
      teamName: "acme",
      brainUrl: "https://x.test",
    });
    expect(prompt).toContain(
      "https://aiosbrain.dev/getting-started/onboarding-a-contributor/",
    );
  });

  it("tells the agent to self-serve the API key from the dashboard, not an admin", () => {
    const prompt = buildAgentOnboardingPrompt({
      teamSlug: "acme",
      teamName: "acme",
      brainUrl: "https://x.test",
    });
    expect(prompt).toMatch(/My API keys.*keep it out of output\/commits/s);
  });

  it("follows every marker in the pinned orchestration contract", () => {
    const prompt = buildAgentOnboardingPrompt({
      teamSlug: "acme",
      teamName: "Acme",
      brainUrl: "https://brain.example.com/t/acme",
    });
    for (const marker of contract.requiredMarkers)
      expect(prompt).toContain(marker);
    expect(prompt).toMatch(/team_id.*optional/i);
    expect(prompt).not.toMatch(/--team-id\s+acme/);
  });
});
