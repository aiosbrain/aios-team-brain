**E3_REMAINING_ADM_RECOVERY_COMPLETE**

**No edit made.** The retained cases-11–15 insertion is syntactically closed, fits the existing fixture's types and seams, and every assertion I traced follows from the supplied source. Nothing has been run.

- **Authorized path:** `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/test/datamechanics/aio1217-pm-reconcile-action-native.datamechanics.test.ts`
- **Other paths:** none created or edited; only Read/Glob/Grep were used.
- **Bytes outside the insertion:** preserved. With no edit, the whole file is as it stood at launch, so the expected fixture identity remains `7ae552...`.
- **Insertion location as read:** it begins after case 10's closing `});` (line 2672) and ends at line 3699, immediately before `// Each TODO names evidence…` and the Z block.

## Checklist disposition

| Case | Disposition | What the retained code does |
| --- | --- | --- |
| 11 — invalid session | Present, source-supported | Three non-empty cookies (not a token; Alice's session with an altered signature; a real `signSession` token under another `AUTH_SECRET`), each read back as null from the real `verifySession`. The trace is exactly the cookie read, with no server or service client and no statement. Alice's valid session at the same slug is the admitted control, then the other-secret cookie is repeated. Missing cookie stays in case 3; expired is stated as not constructed. |
| 12 — membership and role | Present, source-supported | The `member_status` catalog is read back as `invited, active, disabled` (no `suspended`). Memberless, `invited` and `disabled` callers stop at the active-member read with zero rows, and their member row is never bound. The active role-`lead` runs the whole chain through posture (one row) and is refused on role. Alice's first pass is the control. |
| 13 — stale legacy tier | Present, source-supported | Legacy `team` with only the External row is refused after the posture read. Legacy `external` with the Everyone row is admitted through the existing `admit` (three provider reads, two link updates, audit row under that member's own id). The refusal is repeated afterwards with an identical trace. Stored role/status/tier/builtin rows are read back before and after. |
| 14 — association removed and restored | Present, source-supported | Admit, move the board, delete the one `group_members` row, then a fresh invocation is refused with a zero-row posture read and the moved link still `Done`. Restore through `placeMemberByTier`, then a fresh invocation is admitted with one link update and a second audit row. Setup changes are isolated by `changes(first.after, denied.before)` and `changes(denied.after, restored.before)`; request effects are asserted separately. |
| 15 — reverse-team binding | Present, source-supported | Bob at A and Alice at B are each refused with exact bindings. Bob at B's own slug, over a team-B board that forbids A's secret and Linear team id, decrypts only B's secret, reads one link, updates it, audits under team B and revalidates B's path. No team A identifier appears in statements, return, trace or revalidation, and team A's rows are unchanged. Alice's first pass afterwards shows team A's rows stayed live. |

Cross-cutting items hold:

- **Real chain:** every refusal goes through the exported `reconcileDivergenceAction` and the existing `request`/`refuse`, so `getSessionUser → verifySession → resolveIntegrationsAdmin → resolveViewerPosture → canAccessAdmin` runs for real. No guard verdict or owner answer is substituted; the new helpers are setup, readbacks and assertions only.
- **Whole-request assertions:** each refusal asserts the exact trace, acquisition counts, the two-key DTO, empty seam logs, and `after` equal to `before` across all ten tables, timestamps included.
- **Non-claims:** the insertion's own bounds disclaim E4, mutants, Next wire/cache behavior, whole-E3 and acceptance.

## Source files used

- `app/t/[team]/admin/pm-sync/actions.ts`
- `lib/auth/guard.ts`, `lib/auth/session.ts`, `lib/auth/pg-session.ts`, `lib/auth/admin-access.ts`, `lib/auth/visibility.ts`
- `lib/integrations/read.ts`, `lib/access/posture.ts`
- `lib/access/groups.ts` (lines 1–160, `ensureBuiltins`)
- `postgres/schema.sql` (enums, `auth_users`, `teams`, `members`, `audit_log`, `groups`, `group_members`, and a trigger/index search)
- `lib/pm-sync/reconcile.ts`, `lib/pm-sync/linear-client.ts`, `lib/api/audit.ts`, `lib/secrets/crypto.ts`
- `lib/pm-sync/project.ts` (100–149), `lib/integrations/manage.ts` (240–279), `lib/pm-sync/linear.ts` (90–289)
- `lib/db/admin.ts`, `lib/db/server.ts`, `lib/db/pg/client.ts`, `lib/db/pg/pool.ts`, `lib/db/types.ts`
- `test/datamechanics/helpers.ts`, `test/datamechanics/setup.ts`
- `test/datamechanics/aio1217-admin-guard-association.datamechanics.test.ts` (authority, `seedAdmin`, `removeEveryone`, guard chain, removal/restoration case)
- The whole current fixture, `AGENTS.md`, the workflow skill, the Astra disposition, the Next Server Actions guide, both manifests, the original builder prompt and `validation.json`

Outside the manifest, read-only: `lib/db/pg/query-builder.ts`, `postgres/migrations` (trigger search and the member-kind migration), `tsconfig.json`, `package.json`.

## NOT RUN

No PG, test, lint, typecheck, review, commit or push was performed or is claimed.

## Remaining limitations

- **Identity not re-hashed by me.** Without Bash I could not compute SHA-256 or byte counts. I relied on the packet's `validation.json` and your stated checkpoint; what I read is consistent with them.
- **Not read in full.** Accepted v9 §§1–9 were read, but Appendix A (the v6 body) only by targeted search for the ADM definition. `lib/pm-sync/plane.ts` and `lib/pm-sync/provider.ts` were not opened, since cases 11–15 are Linear-only. The files listed above with line ranges were read in those ranges only.
- **Typecheck will not cover this file.** `tsconfig.json` excludes `test` and `**/*.test.ts`, so type coherence here is by reading alone.
- **Not exercised by this slice.** An expired cookie, and a guard read that Postgres refuses. v9 F4-E3 says to preserve current guard-fault outcomes; that was not on this recovery checklist and the fixture says it is still open.
- **Style only, left untouched.** Lines 3509 and 3556 run slightly past the roughly 120-column width the surrounding code keeps, and the `premise` call at 3140 is wrapped oddly. `package.json` configures no formatter.
- **Stale prose preserved as instructed.** The header's `NO ADMITTED OTHER-TEAM INVOCATION`, `World.bob`'s comment and Z's TODOs are unchanged; the insertion's own header names itself as their later exception.