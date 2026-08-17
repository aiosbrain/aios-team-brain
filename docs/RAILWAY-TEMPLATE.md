# Official Railway template contract

The stable product entry point is **https://aiosbrain.dev/deploy/team-brain/**. That page points to
the currently published Railway template, so installers and onboarding contracts do not need to
change when Railway rotates a template code.

## Prerequisite

The target Railway workspace must have an **active Railway plan** before the template can create a
project. An expired trial is not sufficient. Activate or verify the plan at
**https://railway.com/workspace/plans**, using Railway's workspace switcher to select the workspace
that will own the deployment.

## Services

- `aios-team-brain` — source `https://github.com/aiosbrain/aios-team-brain` on `main`, public HTTP
  networking enabled. Repository `railway.json` runs `npm run pg:schema` before release.
- `Postgres` — Railway Postgres template. The app references `${{Postgres.DATABASE_URL}}`.
- `neo4j` — `neo4j:5.26.2`, internal-only, with a persistent `/data` volume.
- `graphiti` — source `https://github.com/aiosbrain/aios-team-brain` with root directory `graphiti/`,
  internal-only on port 8000. It uses the repository's patched Dockerfile and no custom start command.

## App variables

| Variable | Template behavior |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` reference |
| `PGSSL` | fixed to `require` |
| `APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `AUTH_SECRET` | generated with `${{ secret(64, "0123456789abcdef") }}` |
| `GRAPH_LLM_PROXY_SECRET` | generated secret shared with Graphiti; authenticates its calls to Team Brain's internal LLM proxy |
| `GRAPHITI_URL` | `http://${{graphiti.RAILWAY_PRIVATE_DOMAIN}}:8000` |
| `NEO4J_URL` | `bolt://${{neo4j.RAILWAY_PRIVATE_DOMAIN}}:7687` |
| `NEO4J_USER` | fixed to `neo4j` |
| `NEO4J_PASSWORD` | generated secret shared with Neo4j and Graphiti |
| `GRAPH_PROJECT_ENABLED` | fixed to `true` |
| `SECRETS_KEY` | `${{ secret(43, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") }}` (32 bytes when base64url-decoded) |
| `TEAM_NAME` | required user input |
| `TEAM_SLUG` | required user input; lowercase letters, digits, hyphens. Railway's form cannot validate it, so bootstrap normalises anything else (`Acme Corp` → `acme-corp`) and prints what it used — the slug is the team's permanent `/t/<slug>` address |
| `ADMIN_NAME` | required user input |
| `ADMIN_EMAIL` | required user input |
| `ADMIN_PASSWORD` | required user input, minimum 10 characters; never printed by bootstrap |
| `SEED_DEMO` | fixed to `false` |
| `AIOS_TEMPLATE_BOOTSTRAP` | fixed to `true`; provisions the team and admin before the app starts |

Graphiti reaches Neo4j at `bolt://${{neo4j.RAILWAY_PRIVATE_DOMAIN}}:7687` and reaches Team Brain's
internal OpenAI-compatible proxy at
`http://${{aios-team-brain.RAILWAY_PRIVATE_DOMAIN}}/api/internal/llm/v1`, authenticating with
`${{aios-team-brain.GRAPH_LLM_PROXY_SECRET}}`. This keeps the provider key and extraction-model
choice in Team Brain Admin rather than requiring Graphiti to hold a second provider key. Optional
model and mail-provider keys are configured after deployment in Admin and are never encoded in a
deploy URL.

## Maintenance and verification

The published Railway template is a derived deployment asset. For every Team Brain release:

1. Confirm the template still points at the official repository and `main`.
2. Compare its services and variables to this document and `railway.json`.
3. Deploy it into a fresh `aios-onboarding-sandbox-<date>-<suffix>` project.
4. Verify schema, first-admin login, API-key issuance, restart idempotency, and `/api/v1/me` through
   an individual workspace.
5. Record the template code, source commit, sandbox project/deployment IDs, and teardown evidence on
   AIO-445 or its successor release issue.

Do not generate the template from the production AIOS project: it contains organization-specific
services and variables that do not belong in a public installer.
