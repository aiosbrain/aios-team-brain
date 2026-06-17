---
name: admin
description: >
  Team Brain admin operations from the terminal — create members, mint one-time
  login links, issue/revoke API keys, list members/keys, load the Postgres schema
  (and, once landed, map git-author aliases, sync GitHub profiles, and run scans).
  Use when asked to provision a user, get someone a login link, issue an API key,
  or do team-brain admin DB work. Requires a Postgres DATABASE_URL.
---

# Team Brain admin

A thin wrapper over `scripts/admin.ts` (which reuses the audited primitives in
`lib/admin/*` — it never re-implements auth/key logic, and every credential/alias
mutation is written to `audit_log`).

## Running

Local / dev / test DB:

```bash
DATABASE_URL=postgres://… npm run admin -- <command> [args] [--flags]
# or: npx tsx --conditions react-server scripts/admin.ts <command> …
```

Production (Railway — injects the public DB URL; the secret never appears in argv):

```bash
railway run -s Postgres bash -lc \
  'DATABASE_URL=$DATABASE_PUBLIC_URL npx tsx --conditions react-server scripts/admin.ts <command> …'
```

## Commands

- `create-member <email> --name <n> --handle <h> [--role admin|lead|member] [--team <slug>] [--upsert]`
- `login-link <email> [--team <slug>] [--ttl-min <n>] [--base-url <url> | env BRAIN_URL]` — one-time link
- `issue-key <member-email> [--name <n>] [--team <slug>]` — prints the key **once**
- `revoke-key <api-key-uuid> [--team <slug>]`
- `list-members [--team <slug>]` · `list-keys [--team <slug>]`
- `pg:schema` — load `postgres/schema.sql` (idempotent)

Default team is `demo`.

## Secret hygiene (IMPORTANT)

- API keys and login tokens print to stdout **once**. Treat them as credentials:
  hand them to the user, do **not** echo them back, paste them into chat, or store them.
- Provide GitHub tokens via the **`GITHUB_TOKEN` env var** (or stdin), never a `--token`
  flag (it would leak into shell history / process lists). Never print the token.
