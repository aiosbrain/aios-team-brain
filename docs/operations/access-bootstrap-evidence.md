# Access bootstrap evidence — operations companion (AUDITFIX-25 / AIO-1062)

Companion to the accepted specification, whose exact copy is
[`docs/design/auditfix25-bootstrap-evidence.md`](../design/auditfix25-bootstrap-evidence.md)
(SHA-256 `37416615842ce787d6730aa48ae7c6d909a029a9d6ed0778658d07be9f89cddb`). That copy is immutable
and its bytes, and the copy attached to AIO-1062, are unchanged; this file describes the
implementation and how an operator uses it.

## Status of this document

| Statement kind | Status |
| --- | --- |
| Behaviour described under "What is implemented" | **Implemented in source** on `codex/auditfix-25-bootstrap-evidence`, checkpoint commit `8a07f5c3d2e097a1f2b503281df05980e22a4789`. Reconciled against the code by reading it. The automated results under "Verification status" were recorded by the coordinator on that source. |
| The SQL and CLI command below | Checked against the current schema, census, CLI and tokenizer source by reading them. **Never executed** for this document, against any database. |
| Acceptance criteria AC01–AC12 | **Observable evidence recorded**, with the limits stated per criterion under "Acceptance criteria". |
| Acceptance criterion AC13, and acceptance as a whole | **Pending.** Outstanding: the last focused review, of the published source (the four raw ledger readers' context and this updated document), the coordinator's checks on wording changed after its docs run, and final acceptance and publication. Nothing here attests final acceptance, publication, a rollout or production capacity. |

The documentation writer ran no command. Every result below was run and recorded by the coordinator
and is quoted from its retained result records and log summaries. A result attests only the bytes it
ran on: this update changes this file after those runs and after the reviews listed below.

## What is implemented

### The operator surface

An admitted admin opens the team's **Admin → Integrations** page, section **Recent ingestion runs**.
A failed per-team `access_bootstrap` scheduler row keeps what it always showed — the `failed (n)`
pill, a 120-character error preview and the full error as the tooltip — and additionally shows a
native **Evidence** disclosure, closed by default. It is a read surface: it repairs nothing and
generates no command.

The disclosure shows, for that one tick:

- **Convergence** — `ok` or `failed`, with its reason.
- **Census** — `complete` with the exact number of unsanctioned edges, how many are sampled and how
  many are omitted; or `failed` with **finding count unavailable**.
- **Sample** — up to sixteen findings, each a project label + project UUID and a group label + group
  UUID. The heading is "Sample — N of M", followed by "all findings for this tick" when nothing was
  omitted and by "not the complete set" when anything was. "All findings for this tick" describes
  that tick's census only; it is not a statement about the current state.
- A `(shortened)` marker on any reason that was cut, and `(label shortened)` on any display label
  that was cut.

Only rows the decoder recognizes get a disclosure. Older failed rows, rows from other sources,
instance-wide (`team_id is null`) rows, and rows whose metadata is malformed, oversized, of another
version, healthy-shaped, naming a different team or carrying a failing phase with an empty reason
keep their existing presentation with no disclosure. A healthy tick writes no evidence at all.

The runs table sits in a horizontally scrollable region. The section heading on the page is "Recent
ingestion runs"; the region's own accessible name is **"Recent runs"**. The region is a keyboard tab
stop — one, ahead of the first Evidence toggle — so a table wider than the page can be scrolled
without a pointer.

The region is also an inline-size query container (`container-type: inline-size`). Everything in a
Details cell sits in one box that is 20rem wide where there is room and never wider than the
region's own inline size less 1rem (`max-width: calc(100cqw - 1rem)`). The cap follows the region,
not the viewport, because the team layout's fixed sidebar leaves the region much narrower than the
viewport. Long labels, reasons and metadata values wrap inside that box instead of widening the
table. Wrapping is the only fitting applied: the 120-character error preview and its tooltip are as
before, and no evidence text is cut or hidden to fit.

### What was observed in a browser, and what was not

Observed by the coordinator with the final panel (SHA-256
`daf793eff2caffbc3109a5818c00173862ee119fe3f5bcd2f5e99bf9513ec77f`) and compiled production CSS,
mounted in the **actual exported team layout** with its real fixed sidebar and main geometry. Only
the layout's authentication, navigation and sign-out collaborators were synthetic. It was not a
standalone preview, and it used synthetic data.

| Viewport | Measured | Interaction observed |
| --- | --- | --- |
| Desktop, 1280 px | Region 974 px; Details box 320 px; the Evidence summary spans about 855–1,175 px | Enter opens the disclosure with native keyboard handling |
| Narrow, 390 px | Main column 150 px; region 84 px (272–358 px); Details box 68 px; the summary spans about 281–349 px, entirely inside the region; every measured paragraph and list is 68 px wide with nothing overflowing; every label and UUID sits inside the region | Tab reaches the summary and Enter opens it; Space closes it; Shift+Tab returns to the region; the left arrow key scrolls the region horizontally; vertical pointer scrolling reaches all of the long text, the last exact UUID and the closing "display labels" note |

**Severe limitation at narrow width.** The existing fixed sidebar leaves a text column 68 px wide,
and the expanded disclosure measured **7,452 px tall**. Everything is reachable and nothing is cut,
but reading it takes a great deal of vertical scrolling. The sidebar is unchanged and no change to it
is part of this work. No comfortable-reading, minimum-width, maximum-height, other-viewport or
screen-reader result is claimed.

**Forced colors: not activated; no focus-cue result.** The forced-colors mode was never switched on
in a browser. The compiled CSS does contain a forced-colors rule for the region
(`outline: 2px solid` in a transparent colour), but the class that produces it is applied
unconditionally, not on focus. That static rule therefore does **not** show that focus on the region
is distinguishable in forced colors, and it is not recorded as a focus fallback. This is a
low-severity finding, deferred; the source comment beside that class states an intent that has not
been established. In the normal colour mode the native focus outline on the summary and the violet
focus ring on the region were both observed.

The other consumer of this panel, the PM-sync admin page, was checked by reading only: its rows are
read by team and by the `pm_sync` source, so it never shows this disclosure, and its parent is an
ordinary block container. It was not measured in a browser. The panel is not claimed to fit an
arbitrary parent; a shrink-to-fit parent would collapse a query container.

### What the evidence means

The envelope is version 1, stored under `meta.accessBootstrapEvidence` on the team's own row.

- A **completed** census reports the exact full finding count, zero included, and
  `omitted = total − sample.length`.
- A census that **could not be read** (a returned failure or a throw) reports `total = null`,
  `omitted = null`, an empty sample and a named reason. **Unavailable never means zero.**
- Convergence and the census are independent. A convergence failure — returned or thrown — does not
  stop the census, and both reasons are kept: the stored error is `census: …; convergence: …`, census
  first, with only the failing arms present.

The ledger carries **bounded structured evidence: exact counts plus a sample**. It deliberately does
not carry every name. The original ticket asked for exhaustive names in the ledger and expressly
allowed bounding as the alternative; this is that alternative, and the complete current set is
retrieved with the read-only query below. If `omitted` is nonzero, do not assume the sample is every
violation. Counts describe that tick; a later administrative read sees a newer snapshot.

### Limits

These are presentation budgets measured in UTF-8 bytes. They are not database capacity estimates.

| Item | Bound |
| --- | --- |
| Metadata | ≤ 8,192 bytes of the actual `JSON.stringify({ accessBootstrapEvidence: … })` — after escaping, key and braces included |
| Samples | ≤ 16, the first by full normalized untruncated `(projectSlug, groupSlug, projectId, groupId)` in plain JavaScript string order; then removed from the end until the metadata fits, `omitted` recomputed each time |
| Display labels | ≤ 96 bytes each, cue included; a per-label flag says when one was cut. UUIDs are exact |
| Stored error | ≤ 480 bytes, one string, one `error_count` contribution |
| Both phases failing | 224 bytes reserved per arm; the remainder of the 457-byte message pool extends the census first, then convergence |
| One phase failing | census ≤ 472 bytes, convergence ≤ 467 bytes (480 minus the label) |
| Health banner preview | unchanged: 160 JavaScript characters. It can visually omit the later arm even though both are stored |

NUL and isolated surrogate code units become U+FFFD before ordering, cutting and measuring; valid
pairs survive. Cuts land on code-point boundaries and the `…` cue is inside the budget. The census
reason is the exact count followed by the first ≤ 16 ordered full pairs taken *before* the metadata
trim; it may end inside a name and never says "+N more". `total` and `omitted` are authoritative.

Display labels are **not** command arguments. A shortened label cannot identify a group or project;
use the exact UUID to look up the complete slug.

**Reading limit for legacy JSON-string metadata.** The decoder accepts `meta` as an object or as a
legacy JSON string. A string is bounded at 8,192 bytes of its *actual* text **before** it is parsed,
whitespace included. PostgreSQL's `jsonb::text` form puts a space after every `:` and `,`, and
pretty-printed JSON adds more, so a string can exceed the bound even though its compact known-field
projection fits. Such a row is refused unparsed: it keeps the existing error presentation and shows
no disclosure. That is the fail-closed direction, and the evidence is still in the stored row. The
current `pg` reader returns object metadata, for which the bound is measured on the compact
projection; the string branch is tolerance for legacy input, and no current path that hands the
decoder adapter-returned text was demonstrated. The limit is not raised and the string is not
compacted before the check.

### When a reason or the evidence cannot be produced

A phase whose failure carries no usable message still produces normal evidence, with a fixed reason
and `truncated = false`:

| Phase outcome | Reason recorded |
| --- | --- |
| Convergence returned a failure with a missing, empty, non-string or unreadable error | `unknown` |
| Convergence threw something other than an `Error` with a nonempty string message | `threw` |
| Census returned a failure with a missing, empty, non-string or unreadable error | `failed` |
| Census threw something other than an `Error` with a nonempty string message | `system-edge census threw: threw` |

Thrown non-`Error` values are never inspected for a message, and nothing is converted to text.

Separately, if building the evidence itself fails, the team's row is still written, **without
evidence**, with a fixed ASCII error naming only what failed:

- `census: N unsanctioned edge(s) on system projects (evidence unavailable)`
- `census: unavailable (evidence unavailable)`
- `convergence: failed (evidence unavailable)`

joined by `; `, census first. Such a row has no disclosure. A team whose phases were both clean stays
green, and teams after it are still processed.

That fallback is deliberately silent about its cause. The row says evidence was unavailable; the
exception that stopped the builder is not stored and is not logged by this change, because it could
carry tenant text. A builder fault that persists would show as repeated "(evidence unavailable)" rows
with nothing recording why.

## Complete enumeration — authorized, read-only SQL

**Not executed for this document.** Use a trusted administrative PostgreSQL session against the
intended instance. There is no row-level-security backstop for this read, so bind the intended team's
UUID explicitly. The query has no `LIMIT` and writes nothing. It returns complete stored names; do
not paste another team's results into a shared ledger, ticket or log.

```sql
-- psql variable; replace with the intended team's UUID (not a slug).
\set team_id '00000000-0000-0000-0000-000000000000'

BEGIN READ ONLY;

SELECT
  pg.team_id,
  pg.project_id,
  p.slug AS project_slug,
  p.kind AS project_kind,
  pg.group_id,
  g.slug AS group_slug,
  g.is_builtin,
  CASE
    WHEN p.id IS NULL THEN 'unresolved project'
    WHEN g.id IS NULL THEN 'unresolved group'
    ELSE 'unsanctioned system edge'
  END AS finding
FROM project_groups AS pg
LEFT JOIN projects AS p
  ON p.team_id = pg.team_id AND p.id = pg.project_id
LEFT JOIN groups AS g
  ON g.team_id = pg.team_id AND g.id = pg.group_id
WHERE pg.team_id = :'team_id'::uuid
  AND (p.id IS NULL OR p.kind = 'system')
  AND (
    p.id IS NULL
    OR g.id IS NULL
    OR NOT COALESCE(
      g.is_builtin AND (
        (p.slug = 'general' AND g.slug = 'everyone')
        OR (p.slug = 'external-shared' AND g.slug = 'everyone')
        OR (p.slug = 'external-shared' AND g.slug = 'external')
      ),
      FALSE
    )
  )
ORDER BY pg.project_id, pg.group_id;

COMMIT;
```

How it corresponds to the census (`censusTeamSystemEdges`, `isSanctionedSystemEdge`):

- It enumerates every system-project candidate: both joins are `LEFT JOIN`s on team **and** id, and
  the filter is `p.id IS NULL OR p.kind = 'system'`.
- An unresolved project or group is a **finding**, not a clean row. The composite same-team foreign
  keys on `project_groups` make that unreachable in an intact database; the branch keeps the query
  fail-closed, as the census is. If one actually appears, investigate the integrity problem — do not
  invent a slug and do not run a repair against it.
- An edge is sanctioned only when the group `is_builtin` **and** the pair is exactly one of
  `general→everyone`, `external-shared→everyone`, `external-shared→external`. A built-in group alone
  is not enough: `general→external` is forbidden.
- A reserved-slug `source` project is **not** in this census. It is covered by the separate
  pre-adoption guard, which refuses to promote it while it holds a forbidden grant. So a convergence
  refusal beside a completed census of zero is consistent — it does not mean that grant is
  sanctioned. Do not widen this query to source or initiative projects and call the result the census.

This is administrative retrieval. It adds no runtime predicate, endpoint or export.

## Repair — the existing CLI

The evidence panel grants no repair authority. Removal of a forbidden edge is the existing command,
whose argument order is **group slug first, project slug second**:

```text
repair-system-edge <group-slug> <project-slug> --actor <admin-email> [--team <id|slug>]
```

From a source checkout, with illustrative values only:

```sh
npx tsx --conditions react-server scripts/admin.ts repair-system-edge \
  'vendors' 'general' --actor 'authorized-admin@example.test' \
  --team '00000000-0000-0000-0000-000000000000'
```

**Not executed for this document.** The argument order, the flags and the tokenizer behaviour below
were confirmed by reading the command and tokenizer source.

- Use the **complete** slugs returned by the query above. Never build a command from a display label
  in the panel: a shortened label is not an identity, and this document gives no command form for one.
- `--actor` is required and must name the authorizing admin. Pass `--team` explicitly; the CLI
  otherwise defaults to `demo`.
- Each value flag takes its value as the **next, separate** argument. `--actor=value` is not a
  supported form.
- Quote real arguments, and never paste attacker-influenced text into a generated command line.
- The CLI tokenizer treats any token beginning `--` as a flag and has no positional terminator, so a
  slug that begins with `--` cannot be passed this way. Such an identity needs a maintainer-reviewed
  path through the existing repair writer using exact IDs; this change adds no workaround for it, and
  this document gives no command for it.
- The writer re-validates authority and that the edge is protected and unsanctioned before deleting,
  and audits a real deletion.

After a repair, a historical failed row stays as it was. Re-read the current state and watch later
scheduler ticks. `access-health <team-slug>` gives a short human diagnosis, not the complete list.

## Access and privacy boundary

- **Admin → Integrations** resolves the viewer's active membership and membership-derived posture,
  then applies the existing admin policy (admin role **and** unrestricted posture) *before* any
  elevated read. A denied viewer gets an empty page segment with HTTP 200; the layout's "Admins
  only" card stays the only denial copy. The layout by itself is not the boundary: a nested segment
  still runs, and can be requested without its layout.
- **Pulse (team home)** fetches pipeline health only for a viewer who passes that same policy. The
  health banner's full error text is serialized to the browser even though the banner shows 160
  characters and can be dismissed. Onboarding, usage/spend scope, metrics and LLM health still
  follow the admin role alone, unchanged.
- Per-team evidence is written only to that team's own row, once per tick, as the team completes.
  The recent-runs reader returns a team's own rows plus instance-wide rows, never another team's.
- Instance-wide rows written by this leg carry aggregate counts and a fixed reason only —
  `teams read failed` or `bootstrap threw` — never forwarded error text, ids, slugs or evidence. The
  distinct `access_bootstrap_all` row remains an `ok: true` liveness beat. A thrown fleet error is
  still rethrown to the scheduler unchanged, so server-side diagnostics keep the detail; the ledger
  is not a complete record of it.

Where bootstrap rows and leg errors are read, by source inspection during review: the two gated pages
are the only consumers of pipeline health and its banner; Integrations is the only web consumer of
the recent-runs reader; the scheduler leg is the only caller of the fleet bootstrap. The PM-sync
page, the data browser and the alert e-mails were each traced and do not receive bootstrap rows or
errors. Four other direct ledger readers — LLM health, graph efficiency, the context-backfill cursor
and the doc-task inference run — were found to filter on their own source and team; the focused
reviewer's read-back of those four is one of the pending items. The `access-health` diagnosis is
called only from the admin CLI.

## Unchanged, and limits to keep in mind

- **Writes are still best-effort.** The ledger writer swallows its own failures. Bounding and
  normalizing this payload removes two known causes of a lost row; it does not guarantee persistence.
- **No retention change.** A failing team adds up to 8 KiB of metadata per tick on top of the
  existing row. Nothing new prunes it.
- **The census is unchanged and unpaginated.** It still reads a team's whole edge set into memory.
  The bounded sample selection adds no second full copy, but that is not a memory, time or capacity
  bound on the census, and none is claimed for production.
- **Collapsed evidence is still transmitted.** A 30-row panel can hold more than 15 bootstrap rows.
  No lazy loading is added.
- **Team-creation rows are not enriched.** The row written when a team is created carries no evidence.
- **Mixed versions during rollout.** An older replica can omit evidence or serve the old pages. Do
  not treat the privacy boundary as complete until every serving replica has both page gates.
- **Browser state.** A response a browser already received is not recalled. Banner dismissal already
  stores an error-containing signature in `localStorage`. The gates stop new disclosure; they do not
  erase what a browser was sent or stored earlier.
- **Invited members on Pulse.** A membership is `invited`, `active` or `disabled`; there is no other
  state. Pulse uses the existing team context, which admits every membership that is not `disabled` —
  invited as well as active — while Integrations requires `active`. An invited admin with an
  unrestricted posture can therefore receive pipeline health on Pulse. This is the existing policy,
  kept unchanged.
- **Previews cut UTF-16 code units.** The 120-character panel preview and the 160-character banner
  preview are the existing slices, unchanged, and can end between the two halves of a non-BMP
  character. The stored error, the tooltip and the disclosure are cut on code-point boundaries. No
  rendering fault from this was demonstrated, and none was ruled out.
- **The provider-fault diagnosis is a text heuristic.** The health banner's headline classifier reads
  the stored error, which now contains more name text. Text inside a name could steer the headline it
  picks, as it could before. It supplies wording only — no command, markup or permission decision —
  and the actual error stays available to the admitted admin. The classifier is unchanged, and this
  document does not promise that diagnostic text cannot influence it.
- **Other instance-wide ledger rows are unchanged.** Producers of `team_id is null` rows that can
  carry raw text or identifiers **include** — this list is not exhaustive — `context_backfill_all`;
  `graph_project` sample/detail; `pret3_sweep` and `pret4_materialize`; the connector legs (errors and
  skipped repository names); `linear_inbound`; `dense`; `auth_cleanup`; and `graph_health` (group ids
  and reasons). Generic metadata on successful rows is unchanged too. The fixed reasons above apply to
  the bootstrap leg's own rows. This is not an audit of every instance-wide producer and makes no new
  claim that their rows are safe to disclose.
- **`describeUnsanctionedEdges`** as used by `access-health` keeps its short 200-character format.

## Verification status

Three states of the branch are kept apart.

- **Initial snapshot** — the implementation before any review follow-up; checkpoint commit
  `17a5c420ebb80fa27c97da1a571f00036204836c`.
- **Follow-up** — the first review corrections (the scroll region and wrapping, the sample heading,
  the decoder's empty-reason refusal, tests); production-file fingerprint
  `9779ac0e164dd7e0b73d8bbd8d137ae46697052eead977ef72096e899f2e59e4`.
- **Final source** — the follow-up plus the panel-only correction made after the actual-layout
  failure (the container-relative Details cap) and its panel test; production-file fingerprint
  `7b0cd9488479aa5e7593b843b733076c032a2e7783a9c3dfbdd6d25b9ef65a87`, checkpointed as commit
  `8a07f5c3d2e097a1f2b503281df05980e22a4789`. Each final run recorded that fingerprint before and
  after, unchanged.

The fingerprint covers tracked production files. It associates a run with source and a build; it is
not an audit of dependencies or the environment. The poller settings recorded with each HTTP run are
the settings the harness supplied — an allow-listed environment with the three poller toggles forced
off, pinned again in the HTTP test configuration and backed by in-test ledger-untouched assertions —
not telemetry read from the server. The PostgreSQL used is a local, synthetic, loopback-only
PostgreSQL 16 with durability settings off: functional evidence only, with no durability, performance
or capacity claim.

| Check | Result on the final source | Retained history |
| --- | --- | --- |
| Pure unit suite (`test/bootstrap-evidence.test.ts`) | **269 passed**, run on its own after the last mutation was restored. The same 269 also pass inside the broader unit run below | Before implementation it failed at collection because the module did not exist; that run executed no case and proved no expectation. 261 passed on the initial snapshot; 269 on the follow-up |
| Page-gate and panel unit suites | **75 passed** | 27 behavioural failures before implementation (43 of 70 passed). 70 passed on the initial snapshot; 75 on the follow-up |
| Real-ledger evidence suite (`test/datamechanics/bootstrap-evidence.datamechanics.test.ts`), real PostgreSQL | **57 passed** | 47 behavioural failures before implementation (1 of 48 passed). An earlier attempt was refused before execution because the database port was not loopback-only, and a first run against an empty schema failed at setup; neither is behavioural evidence. 57 passed on the initial snapshot and on the follow-up |
| Six existing policy, ledger and repair suites, real PostgreSQL | **70 passed** | 70 passed on the unchanged base, the initial snapshot and the follow-up |
| Production HTTP / RSC suite for this change | **12 passed**, against a production build bound to the final source | 6 behavioural failures before implementation (6 of 12 passed). 12 passed on the initial snapshot and on the follow-up |
| Shared production HTTP suite | **First attempt: 100 passed, 1 failed, 2 skipped.** The failure was a PostgreSQL `deadlock detected` in the fixture's per-test table reset, before the body of an unrelated items test ran; server cleanup succeeded. **Retry, run serially after the unit runs had finished: 101 passed, 2 skipped**, cleanup succeeded. The two skips are pre-existing optional gateway cases | Which sessions took part in the deadlock is unknown: the log names no blocking statement. It is not shown to have been caused by the broader unit run, and no change was made to the fixture, the tests or the configuration. 101 passed with the same 2 skips on the initial snapshot and on the follow-up |
| Typecheck and changed-file lint | **Passed** | Passed on the initial snapshot and on the follow-up |
| Production build | **Passed** (default build) | On the initial snapshot two Turbopack attempts failed with `EPERM`, and a Webpack build failed route-type validation on pre-existing exports outside this change. Those are retained as failures, not passes, and no common cause is claimed. The default Turbopack build from a clean cache then passed, and the default build passed again on the follow-up |
| Docs check | **Passed** before the documentation reconciliation, and again (exit 0) on the reconciled documents | **Pending** for wording changed after that run, until the coordinator reruns it |
| Broader unit run (the whole default unit selection, guards included) | **Not green as a single run** — see below | See below |
| Manual browser check of the disclosure | **Passed for the bounded scope** described under "What was observed in a browser"; forced colors not activated | Initial snapshot, standalone: **failed at narrow width** — at 390 px the container was 358 px and clipped a table of 934 px closed and about 1,971 px expanded, with the summary at about 489 px, outside the viewport; at 1280 px long expanded labels were visually clipped. After the follow-up the standalone preview passed, but in the actual team layout it **failed again**: region 84 px, Details box still 320 px, the focused summary spanning about 155–475 px, label and text clipped. The container-relative cap is the correction for that |
| The SQL and CLI command in this document | **Not executed** — checked against source only | Not executed at any state |

### The broader unit run

The whole default unit selection was run as an additional regression check. **It did not pass as a
single run, and is not reported as a pass.**

- **First attempt:** interrupted by the coordinator (exit 130). It ran under a restricted profile, had
  partial timeout failures, and the harness's synthetic secrets key violated the precondition of an
  existing missing-key test. No completed result is claimed from it.
- **Corrected attempt:** the harness no longer supplies that key to the whole-suite profile. No test,
  timeout or tracked configuration was changed. It exited non-zero: **513 files — 509 passed, 2
  failed, 2 skipped; 7,860 tests — 7,840 passed, 2 failed, 2 expected-fail, 16 skipped.**
- **Both failures are deadline expiries** in tests this change does not touch: an NDA-gate case over
  more than 100 commits (30-second deadline) and a staging-commissioning installation-refusal case
  (5-second deadline). Neither log shows a wrong assertion result, and neither shows how far the case
  had got. The cause is not established.
- **Each passes on its own with its original deadline.** The entire NDA-gate file: 29 passed. The
  complete commissioning case, all six of its installation variants: 1 passed. That rerun selected one
  case, so the file's 257 other cases show as skipped there — they are excluded by the selection, not
  newly skipped tests, and they had already run in the corrected attempt.

The corrected attempt together with those two isolated passes is accepted as the coverage for this
check. The counts are not added together, and the run is not relabelled as passing.

### Mutation controls

Twenty-one deliberate defects were introduced one at a time. Each produced a meaningful behavioural
failure in cases that actually ran; no syntax, import, collection or setup failure was counted as a
kill. Each was followed by restoration of the exact original bytes and a pass of the same selected
cases. Mutant runs select only the relevant cases, so the "skipped" figures in those runs are filter
exclusions. Each gate control (H01, H02) had its own successful production build for the mutant and
for the restoration.

| Control | Criterion | Defect introduced | First observed failure |
| --- | --- | --- | --- |
| T01 | AC01 | Callback metadata removed | Stored metadata was `{}` instead of the envelope |
| T02 | AC02 | Census error replaces the convergence error | The outcome's compound lacked the convergence arm |
| T03 | AC02 | Census skipped after a thrown convergence | The outcome lacked the census arm for a real forbidden edge |
| P01 | AC03 | Whole-compound clamp | The convergence arm was lost behind a long census reason |
| T04 | AC03 | Legacy 200-character pre-clamp restored | Later raw pairs and the sentinel were absent |
| P02 | AC04 | Size accounted on raw, unescaped text — an approximation | Too many samples kept at the exact 8,192-byte fixture: `omitted` 4, not 14 |
| P10 | AC04 | The final serialized-JSON measurement removed — distinct from P02 | All sixteen samples kept past 8,192 bytes: `omitted` 4, not 14. 3 selected cases failed, each at a strict DTO assertion; the same 3 passed after restoration. See the note below |
| P03 | AC04 | `omitted` not recomputed after the trim | `omitted` 4, not 14 |
| P04 | AC04 | Normalization removed | Real PostgreSQL rejected the row; own-row count 0, expected 1 |
| P05 | AC05 | Sampling in input order | Sampled identities differed |
| P06 | AC05 | ID tie-break removed | Equal-slug tuples in the wrong order |
| T05 | AC06, AC10 | A second summary write per team | Two rows where one was expected |
| T06 | AC06 | Returned global reason forwarded | The instance-wide row carried tenant-marked text instead of `teams read failed` |
| T06b | AC06 | Thrown global text forwarded | The liveness row's `threw` carried tenant-marked text instead of `bootstrap threw` |
| P07 | AC06 | Unguarded `Error.message` read | A throwing getter rejected the whole leg, in both arms |
| T08 | AC06 | Builder guard removed | See the note below |
| P08 | AC07 | Decoder ignores the envelope's team | Foreign, missing and numeric team identities were accepted |
| P09 | AC07, AC08 | Decoder object budget removed | An oversized object namespace was accepted |
| U01 | AC08 | Error-versus-metadata choice restored | No disclosure for valid failed evidence |
| H01 | AC09 | Integrations page gate removed | A denied member retrieved the markers over HTML, full RSC and targeted RSC |
| H02 | AC09 | Pulse gate made role-only | An external-posture admin received the serialized health props, beyond the preview |

- **T08.** With the guard removed, the injected builder fault escapes as a `TypeError` from the first
  fleet-bootstrap call in each of the two selected cases, **before** the later leg run and before any
  fallback, progress or ledger assertion. That is the containment failure the control exists to
  expose; it is not a failed assertion of a particular form and not a setup failure. Because those
  later assertions were never reached in the mutant run, nothing is claimed about them from it. The
  restored run of the same two cases passes, which is where they execute.
- **P10.** The independent adjudication covers all twenty-one controls; its inspection of P10 is
  complete, as recorded by the coordinator. The 3 failures in the mutant run are strict DTO assertion
  failures, and the same 3 cases passed after restoration, followed by the pure suite's 269 passing on
  its own. The byte assertions that come later in those cases were never reached in the mutant run, so
  nothing is claimed about them, and no measured size is claimed, from it.
- Two further optional controls (the reader's team filter removed; arbitrary failed metadata dumped)
  were prepared and **not run**. No kill is claimed for them.
- A stale build manifest was refused before any server or test started. That is a provenance control,
  not one of these twenty-one.

### Reviews

- **Independent security code review (Astra, fresh context)** of the exact sixteen-file bundle
  (SHA-256 `73c0dbe179000d0fde50d4cbe7dbb8282551b4adf2d00389e6fae1f702139a5a`): pass, with no
  actionable finding. It ran nothing and is not an acceptance verdict.
- **Final code review (Opus, fresh context)** of the same bundle: no high-severity defect
  demonstrated. It raised a conditional finding — that other surfaces might serve bootstrap rows — for
  which it had not been given the source, four evidence and documentation gaps, and seven lower
  findings.
- **The conditional finding was refuted twice**, by an independent Astra trace of the actual consumers
  and by a focused Opus closure review, for all three named surfaces.
- **The seven lower findings** were adjudicated with no runtime change. Those that remain as limits
  are recorded in this document: the query-container parent, invited members on Pulse, the silent
  builder fallback, the UTF-16 previews, the diagnosis heuristic, the narrow-width height and the
  harness provenance.
- **Pending:** the last focused review, of the published source, covering the four raw ledger
  readers' context and this updated document. This update was made after the reviews above, and none
  of them covers it.

No pull request exists. No final publication, acceptance or rollout is claimed until the coordinator
closes the pending items.

## Acceptance criteria

AC01–AC12 have recorded observable evidence on the final source. AC13 — the verification and review
criterion — is pending the closure items above. The controls are those listed under "Mutation
controls".

| Criterion | Evidence | Limits |
| --- | --- | --- |
| AC01 structured transport | Real-ledger suite: a real forbidden edge gives one failed row with matching evidence, exact IDs and the full count; a clean team has none. Control T01 | — |
| AC02 independent phases | Pure and real-ledger suites: returned and thrown convergence still run the census; an unreadable census is unavailable, not zero. Controls T02, T03 | Phase failures at the seams are injected; the edges, writer, JSONB and reader are real |
| AC03 independent error budgets | Pure and real-ledger suites, through the real 500-character writer clamp, both long-arm directions, the post-200 sentinel and the repair suffix. Controls P01, T04 | — |
| AC04 serialized bound | Pure suite at exactly 8,192 and 8,193 bytes; real JSONB persistence of hostile text. Controls P02, P10, P03, P04 | Presentation budget only. P10's mutant run shows the strict DTO failures, not the later byte assertions |
| AC05 deterministic samples | Pure suite: permutations and ID ties. Controls P05, P06 | Bounded selection was confirmed by reading; no measurement of census memory |
| AC06 ledger compatibility and privacy | Real-ledger and existing ledger suites: one row per team per tick, a separate liveness beat, fixed global reasons, safe extraction in each arm, builder-fault fallback. Controls T05, T06, T06b, P07, T08 | T08 shows the escape, not the later assertions. The fallback does not record its cause |
| AC07 reader isolation | Real own-team-plus-instance-wide reader with two teams; decoder refusals. Controls P08, P09 | The control that removes the reader's team filter was not run |
| AC08 failed-row UI | Panel suite and the full producer → JSONB → reader → decoder → panel round trips. Control U01 | The control that dumps arbitrary metadata was not run |
| AC09 HTML and RSC authorization | Page-gate units; production HTML, full RSC and targeted RSC for admitted and denied personas, with the layout discriminator and cache directives. Controls H01, H02 | Test-environment personas and synthetic data. Invited members on Pulse follow the existing policy |
| AC10 health and detector compatibility | The six existing suites; two-tick health with a healthy second team; short and long previews. Control T05 | The long preview does not show both arms. Preview boundaries and the diagnosis heuristic are unchanged |
| AC11 bounded display smoke | Manual observation in the actual team layout at 1280 px and 390 px | 68 px column and 7,452 px height at narrow width. Forced colors not activated; no focus-cue result. One layout, synthetic data |
| AC12 operational documentation | This document, reconciled against the source by reading | The SQL and the CLI command were not executed. The docs check passed (exit 0) on the reconciled documents; wording changed after that run awaits the coordinator's re-check and the pending review |
| AC13 verification and review | Baseline failures, the final results, the twenty-one controls and the reviews above are retained with their source identities | **Pending:** the last focused review, of the published source; the coordinator's checks on wording changed after its docs run; final acceptance and publication. The broader unit run is not green as a single run. No publication or rollout acceptance |

## Where the behaviour lives

- `lib/access/bootstrap-evidence.ts` — the builder, the guarded message extraction and the decoder.
- `lib/access/bootstrap.ts` — `ensureAccessBootstrapAllTeams`: the two phase guards, the builder
  guard and its fixed fallback, the per-team callback.
- `lib/ingest/access-bootstrap-leg.ts` — the per-team row with its evidence, and the fixed
  instance-wide reasons.
- `components/admin/ingest-runs-panel.tsx` — the disclosure, the scroll region and the Details cap.
- `app/t/[team]/admin/integrations/page.tsx`, `app/t/[team]/page.tsx` — the two page gates.
- `lib/access/groups.ts` (`censusTeamSystemEdges`), `lib/access/system-projects.ts`
  (`isSanctionedSystemEdge`) — the unchanged detector and sanctioned pairs.
- `lib/access/repair-verb.ts`, `scripts/admin.ts`, `lib/admin/args.ts` — the unchanged repair command
  and its tokenizer.
- `lib/ingest/runs.ts` — the unchanged best-effort writer and own-team-plus-instance-wide reader.
