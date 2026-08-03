# Official Railway template contract

The stable product entry point is **https://aiosbrain.dev/deploy/team-brain/**. That page points to
the currently published Railway template, so installers and onboarding contracts do not need to
change when Railway rotates a template code.

## Services

- `aios-team-brain` — source `https://github.com/aiosbrain/aios-team-brain` on `main`, public HTTP
  networking enabled. Repository `railway.json` runs `npm run pg:schema` before release.
- `Postgres` — Railway Postgres template. The app references `${{Postgres.DATABASE_URL}}`.

## App variables

| Variable | Template behavior |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` reference |
| `PGSSL` | fixed to `require` |
| `APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `AUTH_SECRET` | generated with `${{ secret(64, "0123456789abcdef") }}` |
| `SECRETS_KEY` | `${{ secret(43, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") }}` (32 bytes when base64url-decoded) |
| `TEAM_NAME` | required user input |
| `TEAM_SLUG` | required user input; lowercase letters, digits, hyphens |
| `ADMIN_NAME` | required user input |
| `ADMIN_EMAIL` | required user input |
| `ADMIN_PASSWORD` | required user input; never printed by bootstrap |
| `SEED_DEMO` | fixed to `false` |
| `AIOS_TEMPLATE_BOOTSTRAP` | fixed to `true`; provisions the team and admin before the app starts |

Optional model and mail-provider keys are configured after deployment in Admin. They are not part of
the first-deploy form and are never encoded in a deploy URL.

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
