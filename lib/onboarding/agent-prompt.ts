export interface AgentPromptContext {
  teamSlug: string;
  /** The team's real display name (proper casing) — for prose, never the URL slug. */
  teamName: string;
  /** This deployment's own base URL (APP_URL) — the brain a scaffolded workspace should connect to. */
  brainUrl: string;
}

/**
 * The one-click "hand this to your coding agent" prompt shown on a brand-new member's
 * dashboard (components/dashboard/workstation-setup.tsx). Personalizes the AF1
 * "Contributor scaffold prompt" (aios-workspace/docs/getting-started/agent-onboarding.md)
 * with this team's actual brain_url/team_id so the agent can scaffold and connect
 * without asking the human to look those values up — the doc URL stays as the
 * canonical human-readable fallback for anyone who'd rather read and run commands
 * themselves. Pure string template — no I/O, easy to keep in sync by eye with the
 * source doc in the sibling aios-workspace repo.
 */
export function buildAgentOnboardingPrompt({
  teamSlug,
  teamName,
  brainUrl,
}: AgentPromptContext): string {
  return [
    `Guide this person through AIOS onboarding. The authenticated dashboard already knows the team "${teamName}" (${teamSlug}) and its candidate Brain URL: ${brainUrl}.`,
    ``,
    `Operating contract:`,
    `- Inspect before installing. Find existing personal workspaces and toolkit checkouts; run dependency-free \`aios onboard --inspect --json\` when available. Do not mutate yet.`,
    `- Explain what you found. Include workspace health, Git cleanliness, toolkit version, and Brain configuration.`,
    `- Offer Personal / Join / Create and wait. Recommend Join because this dashboard already knows the team, but preserve all three valid outcomes.`,
    `- For an existing workspace, repair or upgrade it instead of re-scaffolding: run \`aios update --check\`, show \`aios update --preview\`, explain the human gate, then update only with approval.`,
    `- For Join, treat ${brainUrl} as a candidate only. Normalize it to the canonical Brain origin, show the exact origin, and stop at a human gate before saving it. The person must approve; you cannot approve for them.`,
    `- The API key is authoritative for team identity; \`team_id\` is optional. Ask the person to generate AIOS_API_KEY from this dashboard's "My API keys" panel, keep it out of output/commits, and validate with GET /api/v1/me.`,
    `- For Create, use the existing self-host guide at https://aiosbrain.dev/guides/team-brain/. Do not invent setup bundles, browser approval, join links, or auth endpoints.`,
    `- Leave dirty workspaces/toolkits untouched. Never run \`aios push\` during onboarding. Explain every human gate before it appears.`,
    ``,
    `Finish with exactly four short sections:`,
    `What AIOS now understands.`,
    `What stays private.`,
    `What can be shared.`,
    `Your best next step.`,
    `End with one relevant action, not an installation inventory.`,
    `Human guide: https://aiosbrain.dev/getting-started/onboarding-a-contributor/`,
  ].join("\n");
}
