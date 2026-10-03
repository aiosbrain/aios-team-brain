# Access bootstrap evidence — operations companion (AUDITFIX-25 / AIO-1062)

Companion to the accepted specification, whose exact copy is
[`docs/design/auditfix25-bootstrap-evidence.md`](../design/auditfix25-bootstrap-evidence.md)
(SHA-256 `37416615842ce787d6730aa48ae7c6d909a029a9d6ed0778658d07be9f89cddb`). That copy is immutable;
this file describes the implementation and how an operator uses it.

## Status of this document

| Statement kind | Status |
| --- | --- |
| Behaviour described under "What is implemented" | **Implemented in source** on `codex/auditfix-25-bootstrap-evidence`. Reconciled against the code by reading it. **Not yet verified by execution** — see "Verification status". |
| The SQL and CLI command below | Checked against the current schema, census and CLI source by reading them. **Never executed** for this document, against any database. |
| Acceptance criteria AC01–AC13 | **All pending.** Nothing here attests a passing test, a build, a browser observation, a review or a rollout. |

Replace a "pending" with a result only when the coordinator has recorded that result.

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
  UUID, headed "not the complete set".
- A `(shortened)` marker on any reason that was cut, and `(label shortened)` on any display label
  that was cut.

Only rows the decoder recognizes get a disclosure. Older failed rows, rows from other sources,
instance-wide (`team_id is null`) rows, and rows whose metadata is malformed, oversized, of another
version, healthy-shaped or naming a different team keep their existing presentation with no
disclosure. A healthy tick writes no evidence at all.

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

- Use the **complete** slugs returned by the query above, never a display label from the panel.
- `--actor` is required and must name the authorizing admin. Pass `--team` explicitly; the CLI
  otherwise defaults to `demo`.
- Quote real arguments, and never paste attacker-influenced text into a generated command line.
- The CLI tokenizer treats any token beginning `--` as a flag and has no positional terminator, so a
  slug that begins with `--` cannot be passed this way. Such an identity needs a maintainer-reviewed
  path through the existing repair writer using exact IDs; this change adds no workaround for it.
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
- **Browser state.** Banner dismissal already stores an error-containing signature in
  `localStorage`. The gates stop new disclosure; they do not erase what a browser stored earlier.
- **Adjacent surfaces not changed here:** `context_backfill_all` raw text; `graph_project`
  instance-wide sample/detail; `pret3_sweep` / `pret4_materialize` instance-wide errors; generic
  metadata on successful rows; `describeUnsanctionedEdges` as used by `access-health`, which keeps
  its short 200-character format. This is not an audit of every instance-wide producer.

## Verification status

Recorded by the implementer; no command was run by the implementer.

| Check | Status |
| --- | --- |
| Pure unit suite (`test/bootstrap-evidence.test.ts`) | **Pending.** Previously failed at collection because the module did not exist; that run executed no case and proved no expectation |
| Page-gate and panel unit suites | **Pending** re-run. 27 behavioural failures were recorded before implementation |
| Real-ledger suite (`test/datamechanics/bootstrap-evidence.datamechanics.test.ts`) | **Pending** re-run. 47 behavioural failures were recorded before implementation. The builder-fault and decoder round-trip cases added with the implementation have never been executed |
| Production HTTP / RSC suite | **Pending.** 6 behavioural failures were recorded before implementation |
| Mutation controls (each page gate, third guard, budgets, preclamp, row scope, getter, panel) | **Pending** |
| Typecheck, changed-file lint, docs check, production build | **Pending** |
| Manual browser check of the disclosure (keyboard, desktop and narrow widths) | **Pending** |
| Independent code reviews | **Pending** |
| The SQL and CLI command in this document | **Not executed** |

## Where the behaviour lives

- `lib/access/bootstrap-evidence.ts` — the builder, the guarded message extraction and the decoder.
- `lib/access/bootstrap.ts` — `ensureAccessBootstrapAllTeams`: the two phase guards, the builder
  guard and its fixed fallback, the per-team callback.
- `lib/ingest/access-bootstrap-leg.ts` — the per-team row with its evidence, and the fixed
  instance-wide reasons.
- `components/admin/ingest-runs-panel.tsx` — the disclosure.
- `app/t/[team]/admin/integrations/page.tsx`, `app/t/[team]/page.tsx` — the two page gates.
- `lib/access/groups.ts` (`censusTeamSystemEdges`), `lib/access/system-projects.ts`
  (`isSanctionedSystemEdge`) — the unchanged detector and sanctioned pairs.
- `lib/access/repair-verb.ts`, `scripts/admin.ts`, `lib/admin/args.ts` — the unchanged repair command
  and its tokenizer.
- `lib/ingest/runs.ts` — the unchanged best-effort writer and own-team-plus-instance-wide reader.
