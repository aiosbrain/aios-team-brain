# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public GitHub issue for a
suspected vulnerability.

- Use **GitHub's private vulnerability reporting**: the repository's **Security** tab →
  **Report a vulnerability**. Include a description, reproduction steps, and impact.
- We aim to acknowledge within 3 business days and to agree on a disclosure timeline with you.
- Please give us a reasonable window to ship a fix before any public disclosure.

## Supported versions

AIOS Team Brain is pre-1.0 and ships from `main`. Security fixes land on `main`; there is no
back-port branch yet. Run the latest `main` (or the latest tagged release once one exists).

## Security model (what the brain guarantees)

- **Authentication.** Machine clients authenticate with a per-member API key
  `aios_<key_id>_<secret>` — the secret is **sha256-at-rest** and shown once; comparison is
  timing-safe (`lib/api/auth.ts`). Human sessions use a signed, httpOnly cookie.
- **Tier isolation.** Synced content is tagged `team` / `external`; `admin`/`private` content is
  rejected with **422** at the API boundary and never reaches the database. On the default
  **postgres** backend there is **no RLS** — tier isolation is enforced entirely in app code and
  covered by data-mechanics tests (`test/datamechanics/access-isolation.*`). See
  `docs/ARCHITECTURE.md` §5.
- **Single write path.** All synced content is written only through `lib/ingest`
  (build-failing guard: `test/guards/single-writer-items.test.ts`).
- **Secrets at rest.** Integration connector secrets are encrypted (AES-256-GCM, `lib/secrets`)
  and decrypted only in-process for the runner — they never leave over HTTP.
- **Audit.** Auth attempts and privileged actions append to an append-only `audit_log`.
- **Rate limiting.** Per-key fixed-window limits (`lib/api/rate-limit.ts`), Postgres-backed.

## Secrets hygiene

- Never commit real secrets. `.env`, `.env.local`, and `.env.keys` are git-ignored; only
  `.env.example` is tracked. CI runs **gitleaks** on every PR as a backstop.
- Rotate API keys with the admin CLI (`npm run admin` → issue/revoke); revocation is by
  `key_hash`.

## Self-hosting deployment notes

- **Postgres TLS.** `lib/db/pg/pool.ts` connects with `ssl: { rejectUnauthorized: false }` when
  TLS is requested (`PGSSL=require` / `sslmode=require`). This is acceptable for managed providers
  that present provider-managed certificates (e.g. Railway). If you self-host Postgres elsewhere,
  prefer a pinned CA bundle / `sslmode=verify-full` so the connection is authenticated, not just
  encrypted.
- **Keep the database private.** The app enforces tier isolation in code; do not expose the
  Postgres port publicly, and run the brain behind your own auth/network boundary.
- **Sentry / external error reporting** is opt-in and inert unless a DSN is configured; review
  what you forward before enabling it in a sensitive deployment.
