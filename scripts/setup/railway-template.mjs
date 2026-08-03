/** Stable product front door for the official Railway template. */
export const RAILWAY_TEMPLATE_URL = "https://aiosbrain.dev/deploy/team-brain/";

/** Railway blocks new deployments when the selected workspace has no active plan. */
export const RAILWAY_PLANS_URL = "https://railway.com/workspace/plans";

/** The Railway template owns these values; the local wizard must not collect or persist them. */
export const RAILWAY_TEMPLATE_INPUTS = Object.freeze([
  "TEAM_NAME",
  "TEAM_SLUG",
  "ADMIN_NAME",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
]);

export const RAILWAY_TEMPLATE_GENERATED = Object.freeze(["AUTH_SECRET", "SECRETS_KEY"]);

export function railwayTemplatePlan() {
  return [
    { id: "railway-template", label: "Open the official AIOS Team Brain Railway template" },
    { id: "railway-config", label: "Enter your team and first-admin details in Railway" },
    { id: "railway-deploy", label: "Deploy Team Brain + Postgres and wait for the healthy public URL" },
    { id: "railway-connect", label: "Sign in and create an API key for your individual workspace" },
  ];
}
