# Ops hardening — Sentry, CodeRabbit, BugBot

This note covers the observability + automated-review stack added in **W1.4**. The Sentry
*code* is wired in this repo; CodeRabbit and BugBot are GitHub/Cursor apps that a human org
owner must approve (they cannot be enabled from code).

---

## 1. Sentry (error monitoring) — W1.4.1

### What's wired

| File | Role |
|------|------|
| `instrumentation-client.ts` | Browser SDK init (`NEXT_PUBLIC_SENTRY_DSN`); exports `onRouterTransitionStart` for App Router nav tracing. |
| `sentry.server.config.ts` | Node.js runtime init (`SENTRY_DSN`). |
| `sentry.edge.config.ts` | Edge runtime init (`SENTRY_DSN`). |
| `instrumentation.ts` | `register()` imports the right config per `NEXT_RUNTIME`; exports `onRequestError = Sentry.captureRequestError` to forward server errors. |
| `app/global-error.tsx` | Root error boundary; calls `Sentry.captureException` and renders fallback UI. |
| `next.config.ts` | Wrapped with `withSentryConfig(...)` for build-time source-map upload. |

**Everything is env-driven and inert when unset.** With no DSN the SDK `init` is a no-op and
sends nothing; with no `SENTRY_AUTH_TOKEN` the build skips source-map upload. So local/CI
builds need no Sentry secrets. SDK version is `@sentry/nextjs` >= 10.13, required for
Turbopack source-map upload. There are no custom webpack plugins (Turbopack ignores them).

### Env vars (names only — set real values in your deploy env, never commit them)

See `.env.example` for the annotated list:

- `SENTRY_DSN` — server + edge runtimes.
- `NEXT_PUBLIC_SENTRY_DSN` — browser bundle (inlined into client JS; genuinely public).
- `SENTRY_TRACES_SAMPLE_RATE` / `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` — optional perf sampling (default 0).
- `SENTRY_ORG`, `SENTRY_PROJECT` — for source-map upload.
- `SENTRY_AUTH_TOKEN` — **SECRET**; build/CI env only. Generate at
  <https://sentry.io/settings/account/api/auth-tokens/> (scope `project:releases`).

Set the DSNs + (for source maps) `SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_AUTH_TOKEN` in Railway
(runtime + build) and in CI for the production build.

### Smoke test — verify events + resolved source maps — W1.4.4

Do this against a **deployed build** (or a local `next build` + `next start`) with the DSNs
and source-map upload env set — source maps are uploaded by `next build`, so `next dev` will
not have resolved frames.

1. **Build with upload on.** With `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`,
   `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` set, run `npm run build`. Confirm the log shows
   Sentry uploading source maps (run with `CI=1` or `silent: false` to see it). Then
   `npm run start` (or deploy to Railway).

2. **Trigger a client (browser) error.** Add a temporary throw behind a button, or in the
   browser devtools console of any dashboard page run:
   ```js
   setTimeout(() => { throw new Error("sentry client smoke test"); });
   ```
   (A thrown error in a React render will surface `app/global-error.tsx`.) In Sentry → Issues,
   confirm a new event titled `sentry client smoke test` appears, and that the stack trace
   shows **original `.tsx` file + line numbers** (not minified `chunk-….js`). Resolved frames
   = source maps working.

3. **Trigger a server error.** Hit a route that throws on the server. Easiest: add a temporary
   route that throws, e.g. `app/api/_sentry-smoke/route.ts`:
   ```ts
   export function GET() { throw new Error("sentry server smoke test"); }
   ```
   Request it (`curl https://<host>/api/_sentry-smoke`). In Sentry, confirm a `sentry server
   smoke test` event with a resolved server stack trace. This exercises the `onRequestError`
   hook in `instrumentation.ts`.

4. **Clean up.** Remove the temporary throw / smoke route.

Expected outcome: two issues in Sentry (one client, one server), both with **un-minified**
stack traces pointing at the original source files.

---

## 2. CodeRabbit (automated PR review) — W1.4.2 — HUMAN STEP

CodeRabbit is a GitHub App; it is **free for public repos**. It cannot be enabled from code —
an org owner must install it.

1. Go to <https://github.com/apps/coderabbitai> and click **Install** (or sign in at
   <https://coderabbit.ai> with GitHub).
2. Install it on the **AIOS-alpha** org and select the public AIOS repos
   (`aios-team-brain`, `aios-workspace`, `aios-website`), or "All repositories".
3. CodeRabbit then auto-reviews new PRs. Optional: add a `.coderabbit.yaml` at repo root later
   to tune review behavior; the defaults are fine to start.

No env vars or secrets in this repo are required.

---

## 3. BugBot (Cursor) — W1.4.3 — HUMAN STEP

BugBot is Cursor's automated PR bug-finder. Enabling it requires approving the Cursor app for
the org (John is the **AIOS-alpha** org owner).

1. In Cursor, enable BugBot for the org (Cursor dashboard → BugBot / GitHub integration),
   which initiates a GitHub App authorization for **AIOS-alpha**.
2. Approve the Cursor app at **GitHub → AIOS-alpha org → Settings → Third-party Access**
   (GitHub Apps / OAuth app access). As org owner, John approves the pending Cursor request.
3. Grant it access to the public AIOS repos. BugBot then comments on PRs with potential bugs.

No env vars or secrets in this repo are required.
