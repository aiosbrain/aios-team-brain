export interface AgentPromptContext {
  teamSlug: string;
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
export function buildAgentOnboardingPrompt({ teamSlug, brainUrl }: AgentPromptContext): string {
  return [
    `You are onboarding a new AIOS individual contributor for the "${teamSlug}" team.`,
    `Follow exactly: https://aiosbrain.dev/getting-started/onboarding-a-contributor/`,
    ``,
    `Rules:`,
    `- Run every command in order. Do not skip validation/validate-all.sh.`,
    `- Ask for the contributor's handle if not given, then scaffold with:`,
    `    --slug {handle}-workspace --brain-url ${brainUrl} --team-id ${teamSlug} --output ~/Projects/{handle}-workspace`,
    `  (unless told otherwise).`,
    `- Stop and report a BLOCKER if a step requires human admin action, browser OAuth, or a secret you cannot obtain.`,
    `- Never commit API keys. Put AIOS_API_KEY in .env only — generate it from this dashboard's`,
    `  "My API keys" panel (your own profile page), not from an admin.`,
    `- After setup, run: aios status (must connect), validation/validate-all.sh . (exit 0).`,
    ``,
    `Report: workspace path, aios status summary, validate-all exit code, and every BLOCKER step.`,
  ].join("\n");
}
