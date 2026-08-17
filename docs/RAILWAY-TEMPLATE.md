# Railway template contract (maintained, unlisted)

The stable product entry point is **https://aiosbrain.dev/deploy/team-brain/**. That page points to
the current maintained Railway template, so installers and onboarding contracts do not need to
change when Railway rotates a template code.

The template's Railway status is **`UNPUBLISHED`**, which means **unlisted, not disabled**: it does
not appear in Railway's public template gallery, and the direct deploy link works and returns `200`.
Describe it as the maintained template reached by direct link — not as a listed or gallery-published
one.

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
| `SECRETS_KEY` | a generated secret that must decode to **exactly 32 bytes**. The live template uses `${{ secret(64, "0123456789abcdef") }}` (64 hex chars). A 43-char base64url secret also works and was what earlier revisions of this document described. `decodeKey` (`lib/secrets/crypto.ts:55-59`) takes 64-char hex, else base64 — validation is on decoded length alone, so both forms are accepted. Anything else fails on the first connector save, not at boot. |
| `TEAM_NAME` | required user input |
| `TEAM_SLUG` | required user input; lowercase letters, digits, hyphens |
| `ADMIN_NAME` | required user input |
| `ADMIN_EMAIL` | required user input |
| `ADMIN_PASSWORD` | required user input, minimum 10 characters; never printed by bootstrap |
| `SEED_DEMO` | fixed to `false`; inert on this path — `bootstrap.mjs` returns after provisioning a real team and never reads it |

**Bootstrap is gated on `TEAM_SLUG`, not on a flag.** `docker/bootstrap.mjs:228` branches on
`if (process.env.TEAM_SLUG)` — setting it is what provisions the team and admin. `ADMIN_EMAIL` is
also required on that path; bootstrap exits if it is absent. Earlier revisions of this document
listed an `AIOS_TEMPLATE_BOOTSTRAP` variable as the gate. **No code has ever read it** — the only
other reference in the repo is `test/setup-wizard.test.ts:184`, which asserts the start script does
*not* mention it. Do not add it to a template.

Graphiti reaches Neo4j at `bolt://${{neo4j.RAILWAY_PRIVATE_DOMAIN}}:7687` and reaches Team Brain's
internal OpenAI-compatible proxy by setting **`OPENAI_BASE_URL`** to
`http://${{aios-team-brain.RAILWAY_PRIVATE_DOMAIN}}:3000/api/internal/llm/v1` and **`OPENAI_API_KEY`**
to `${{aios-team-brain.GRAPH_LLM_PROXY_SECRET}}` (the shared proxy secret, not a provider key).

The **`:3000` is required**. Railway private domains resolve no default port, so a port-less
`http://…/api/internal/llm/v1` attempts port 80, where nothing is listening, and graph extraction
fails. The app listens on 3000 (`Dockerfile:39-40`, `ENV PORT=3000` / `EXPOSE 3000`). The canonical
form is in `.env.example:81-82`.

This keeps the provider key and extraction-model choice in Team Brain Admin rather than requiring
Graphiti to hold a second provider key.

Optional **model/provider** keys are configured after deployment in Admin → Integrations and are
never encoded in a deploy URL.

**Mail keys are not.** `RESEND_API_KEY`, `SMTP_URL`, `RESEND_FROM` and `SMTP_FROM` are read from
`process.env` only (`lib/auth/mailer.ts:15,38,59,128`); there is no Admin surface that stores them.
Configuring mail on Railway means adding service variables and redeploying. Until that happens
`magicLinkAvailable()` is false: magic-link sign-in is hidden from the login form, and
`inviteMember` switches to **manual mode**, returning a generated password and a ready-to-paste
invite message for the admin to deliver. Nothing is silently lost on that path — only a direct
`POST /api/auth/request-magic-link` is swallowed (it returns `200` regardless). Password sign-in
works throughout, so this is a degraded feature rather than a broken deploy.

## Maintenance and verification

The Railway template is a derived deployment asset. For every Team Brain release:

1. Confirm the template still points at the official repository and `main`.
2. Compare its services and variables to this document and `railway.json`.
3. Deploy it into a fresh `aios-onboarding-sandbox-<date>-<suffix>` project.
4. Verify schema, first-admin login, API-key issuance, restart idempotency, and `/api/v1/me` through
   an individual workspace.
5. Record the template code, source commit, sandbox project/deployment IDs, and teardown evidence on
   AIO-445 or its successor release issue.

Do not generate the template from the production AIOS project: it contains organization-specific
services and variables that do not belong in a public installer.
