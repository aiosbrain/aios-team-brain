# AIO-1170 — Inactive preparation of completed-root reconciliation work

Specification round 3 of 3. Final Astra architectural adjudication.

**Decision:** Implement an inactive, schema-free enumeration and preparation primitive that recreates missing pending work for previously published, provably canonical Slack roots. Preserve delete-on-publication acknowledgement and existing pending-row semantics. Export pure failure-classification and page-accounting helpers within the same inactive packet.

**AC-02 NOT COMPLETE. This inactive primitive does not complete AC-02, implement the rotating runtime reconciler, authorize activation, or complete AIO-1170.**

## 1. Evidence boundary and final dispositions

This adjudication used local, read-only inspection. No repository files were edited, tests or performance probes run, network accessed, implementation performed, or agents delegated.

| Identity | Pinned snapshot |
|---|---|
| Documentation HEAD, locally confirmed | `12bca192c6ea7a6c048546ca24e45034df0c1c0d` |
| Source/test candidate | `865c579357311502f89bb35844ecaf480ccc9cdb` |
| Staging merge base, retained from the pinned context | `c5e832c2ff179ee5c99f95966fba1ed9ce77ae3e` |
| User-supplied publication context | Draft PR714 into `staging` |
| Pinned PR743 path inventory | `e1ba30c4c55cc9aee9c7781394c01546c27830bc` |

The candidate-to-documentation-HEAD diff contains only `docs/design/slack-timeline-build-record.md`. Historical tests, reviews and publication observations in that record are not verification performed in this adjudication. Live PR714/PR743 status, remote heads, query plans, performance and integrated behavior remain unverified.

Round-three inputs were the complete round-two specification and independent Opus review, plus the necessary local transaction, binding, ledger, schema, publication, discovery, selector, namespace, secret-encryption and build-record source. Earlier review coverage is inherited evidence, not a claim that every previously inspected file was reread in full this round.

### Final round-two disposition

| Finding | Final disposition | Exact resolution |
|---|---|---|
| R2-1 MEDIUM | Accepted; resolved in specification | §5.3 pins the conflicting-thread predicate to exact team/workspace/channel plus `root_ts = rootTs AND item_id <> itemId`, including deleted rows. §7.5 inventories the unindexed root scan, fixes the single-channel fixture and imposes 200 ms statement / 750 ms operation stop thresholds. M1h and KR-17 provide explicit falsifiers. |
| R2-2 MEDIUM | Accepted; resolved in specification | §8 assigns exported pure classifier and tally reducer to the allowed requeue module. Terminal transaction receipts, retry inputs, duplicate handling and unknown commits have exact product contracts. KR-10 and M15 test those contracts. No driver is added. |
| L-a LOW | Accepted; resolved in specification | §11 pauses A through a test-only executor wrapper after its empty queue read, with no in-flight SQL or item-lock wait. C commits before A resumes. |
| L-b LOW | Accepted; resolved in specification | §14 records `1a907348…` as structural red and `883aa24d` as implementation. Historical records remain intact. |
| L-c LOW | Accepted; resolved in specification | KR-16 covers validation/redaction; KR-17 covers plans and the numeric stop; KR-12 explicitly covers timeout restoration on every normal and throwing outcome. |
| L-d LOW | Accepted; held capacity limitation | §9 and §15 retain the minimum 1,000 page transactions for 100,000 arbitrary team items at page size 100. |
| L-e LOW | Accepted; resolved in specification | §11 specifies encrypted synthetic-token rotation by updating only `secret_ciphertext`, verifying unchanged `updated_at` and configuration revision, without importing or editing integration management. |

The earlier decisions remain:

| Earlier finding | Preserved resolution |
|---|---|
| F1 — noncomposable interfaces and self-fulfilling pin | Durable page locators, independently captured authority pins, preparation from team plus page output. |
| F2 — unenforceable cancellation | Statement/lock limits and deadline admission checks; no hard cancellation claim. |
| F3 — FIFO starvation | Both starvation directions, absent provenance and the 601-root characterization remain held. |
| F4 — invalid red plan and mutants | Compiling normal-returning stubs, behavioral assertions and non-equivalent mutations. |
| F5 — contention versus cursor progress | Enumeration advances independently; failed preparation awaits a later sweep. |
| F6 — conflict ambiguity and cost | Exact predicates and the numeric schema-owner stop in this final specification. |
| F7 — historical record integrity | Separate append-only entry under §14. |
| L1–L7 | Plain early queue read; UUID upper bound and empty-team behavior; fixed range rather than fixed population; validation/redaction; real token resolution; orphan/recreation limitation; database clock and upward rounding. |

No further specification-review round is required. Implementation evidence and exact-snapshot code review remain required.

## 2. Confirmed gap and bounded outcome

The pinned source exhibits these behaviors:

- `slack-source-discovery.ts` enqueues roots present in an accepted history page, then advances the frontier in the same transaction. The existing application enqueue inventory identifies no independent completed-root revisit producer.
- `claimSlackChannelPage` selects newest catch-up after the historical floor is reached in the normal completed-history state.
- `finishSlackPublication` deletes the fenced queue row after item/ledger work. The snapshot foreign key cascades staging deletion.
- `claimDueSlackThread` orders by `due_at, root_ts`; it has no changed/new-versus-reconciliation lane.
- `enqueueSlackThread` preserves conflicting pending rows with `ON CONFLICT DO NOTHING`.
- The publication fixture’s `restage()` explicitly calls enqueue. That fixture operation is not an application revisit producer.

Counterexample: publish an old root, complete initial history, then return only recent roots in newest history. Publication deleted the old queue row. A new remote reply does not itself change local durable state. Nothing independently schedules that root.

The required bounded outcome is:

> After real existing publication deletes an old root’s queue row, explicit test invocation enumerates its durable locator and recreates exactly one due pending row, without another history response containing that root or fixture-supplied source authority.

Coverage remains narrower than all historical roots. Eligibility requires a surviving canonical item and a live root-ledger witness. Legacy items awaiting repair, unattested scoped-looking items, never-published roots, purged items and unseen roots outside retained source history remain uncovered.

## 3. Scope, ownership and exclusions

### Allowed files

| File | Responsibility |
|---|---|
| `lib/ingest/slack-known-root-page.ts` — new | Enumeration, continuation validation and slice-local execution-budget utilities |
| `lib/ingest/slack-known-root-requeue.ts` — new | Current authority, canonical proof, due calculation, enqueue composition, exported pure failure classifier and page tally reducer |
| `test/slack-known-root-requeue.test.ts` — new | Validation, redaction, deadline mechanics, scalar boundaries, classifier/reducer contracts and negative controls |
| `test/datamechanics/slack-known-root-requeue.datamechanics.test.ts` — new | PostgreSQL preparation, publication interaction, persistence, retries, races, restoration and query-plan evidence |
| `test/guards/slack-known-root-requeue-not-wired.test.ts` — new | Dependency, write-boundary, outside-import and pinned ownership checks |
| `test/guards/slack-source-not-wired.test.ts` | Add both modules and synthetic reachability controls without weakening existing protection |
| `docs/design/slack-known-root-requeue-spec.md` — new | Accepted specification |
| `docs/design/slack-timeline-build-record.md` | Separate evidence entry under §14 |

The timeout decorator remains slice-local in the page module. It is not a shared transaction facility. The classifier and tally reducer remain in the requeue module; they introduce no third production module or execution driver.

Do not edit discovery, channel state, thread state, hydration, publication, ledger writers, namespace/binding helpers, `ingestItem`, integration management, purge, shared transaction infrastructure, schema, migrations or existing test helpers.

All eight allowed paths are absent from the inspected pinned PR743 inventory. That inventory includes `lib/db/types.ts`, `lib/db/pg/tx.ts`, `lib/db/pg/bounded-lock.ts`, `lib/ingest/index.ts`, integration management, purge, schema and broad identity/cache surfaces. None becomes an implementation file here. Existing dependencies and the pinned data-only path inventory may be read or imported where appropriate without editing them.

AIO-1170 owns these two inactive modules and their pure helpers. Existing dependency owners retain their behavior. Preserved older Slack worktree changes must not be adopted, overwritten, cleaned or duplicated. Before implementation, the coordinator must recheck active worktree diffs and ownership; this offline adjudication establishes no new agreement with another worker.

Before publication, refresh PR743 paths and compare the packet against the union of the fresh and pinned inventories. Before integration, reconcile transaction and shared behavior, honor the recorded integration order or an explicitly agreed combined branch, and rerun affected obligations from both branches. **Live PR743 and integration remain unverified.**

### Exclusions

No active driver, runner, scheduler, route, action, manual trigger, provider HTTP, publisher wiring, repair apply, historical provenance repair, identity cutover, UI/cache change, guard removal, merge, deployment, main/production write, force operation or live acceptance/soak.

No new schema, queue lifecycle, lane representation, durable sweep cursor, ACL model, identity resolver, provider reservation, private-channel/DM ingestion, attachment expansion, Events delivery or replacement of correction-lock semantics.

Preparation does not write items, ledger evidence, identities, memberships, grants, channel coverage, generations, method budgets, run logs or diagnostic stores.

Test fixtures may perform isolated setup DML in the new test files. That does not authorize equivalent production writes or changes to shared setup helpers. Disposable dependency mutations under §12 are evidence experiments, never accepted implementation changes.

## 4. Composable enumeration contract

### 4.1 Interfaces and authority provenance

The interfaces are internal and inactive:

```ts
readSlackKnownRootItemPage(session, request, execution)

prepareSlackKnownRootRequeue(session, {
  teamId,
  entry,
}, execution)

classifySlackKnownRootPreparationFailure(error)

tallySlackKnownRootPage({
  examined,
  receipts,
})
```

The first two use the caller’s transaction session. The latter two are pure, perform no I/O and own the contracts in §8.

The first-page request contains:

- `teamId`;
- integer `pageSize`, 1–100;
- required integer `revisitAfterMs`, 60,000–86,400,000;
- no cursor.

Continuation requests retain the revisit policy and supply the structured cursor. There is no runtime default revisit interval.

Every returned entry contains:

- `teamId`;
- `itemId`;
- the validated, echoed `revisitAfterMs`;
- either a complete locator or a closed `unlocated` category.

A complete locator contains exactly:

| Field | Durable source read during enumeration | Meaning |
|---|---|---|
| `workspaceId` | Item’s string `frontmatter.workspace_id` | Byte-exact candidate identity |
| `channelId` | Item’s string `frontmatter.channel_id` | Byte-exact candidate identity |
| `rootTs` | Item’s string `frontmatter.ts` | Byte-exact candidate root |
| `integrationId` | Exact scoped channel row’s `binding_integration_id` | Expected binder identity |
| `bindingConfigRevision` | Same channel row’s `binding_config_revision` | Expected binding revision |
| `namespaceRevision` | Gate row for exact team/raw channel, read as decimal text and safely validated | Expected namespace revision |

Enumeration derives these values through read-only, nonlocking SQL. It does not call `ensureBlockedSlackNamespaceGate`, create readiness, decrypt a token or prove canonical eligibility.

Preparation independently derives and checks:

- current item metadata and Slack project;
- current selected integration configuration and effective-token fingerprint;
- locked binding and public channel proof;
- locked namespace readiness;
- live root-ledger witness and conflicts;
- observation-based due time.

The caller supplies team, the complete enumerated entry and execution policy. It supplies no additional workspace, channel, integration, root, token, fingerprint or revision constant. The authority pins originate in the earlier page read.

`revisitAfterMs` is echoed policy, not durable source evidence or an authority credential. KR-01 must therefore work from **only teamId plus enumerated output**, apart from transaction/execution context.

The locator is not a capability. Preparation validates it again and compares it with locked current facts. Fabricating a locator cannot bypass those checks.

**The namespace pin protects the interval between enumeration’s gate observation and preparation’s locked check.** If invalidation and rereadiness increase the revision, the old entry refuses even if the workspace is ready again. Preparation must never replace the captured pin with a fresh revision. The pin neither proves live access nor detects changes before enumeration.

### 4.2 Enumeration algorithm

1. Capture the team’s upper UUID:

   ```sql
   select id
   from items
   where team_id = $1
   order by id desc
   limit 1
   ```

   Do not use `max(uuid)`.

2. For an empty team, return `entries: []`, `nextCursor: null`, `exhausted: true`, `examined: 0`. Do not invent a sentinel UUID.

3. Read at most `pageSize + 1` IDs with exact team, optional `id > afterItemId`, and `id <= upperItemId`, ordered by PostgreSQL UUID order. No OFFSET.

4. Enrich only the first `pageSize` IDs with bounded scalar locator metadata. The extra ID is lookahead, not an examined or prepared item. Classification must not determine which IDs enter the bounded page.

5. Return one entry per examined ID, including non-Slack, concurrently missing, malformed and unlocated candidates. Do not search forward for enough qualifying roots.

6. Continue after the last examined ID. The cursor carries version, team, fixed upper bound, last examined ID and revisit policy. Validate all fields and bounds. A deleted cursor item need not exist.

Locator reads may use one limited relation followed by bounded joins, or a fixed set of batched statements over the selected IDs. No per-ledger-message loop, full frontmatter read or unbounded candidate search is allowed.

An entry lacking a complete validated locator carries one closed category: `not_slack`, `invalid_metadata`, `missing_channel_binding` or `missing_namespace_pin`. Its preparer result is `unattested` for that observation, with no mutation. It may qualify on a later sweep; this is unresolved coverage, not proof that no Slack root exists.

### 4.3 Snapshot and continuation limits

The upper bound freezes a **key range**, not its population:

- Inserts below or equal to the consumed cursor wait for a later sweep.
- Inserts strictly above the cursor and at or below the upper bound can appear on later pages.
- Inserts above the upper bound wait for a later sweep.
- Concurrent deletion can remove an item before enrichment or preparation.
- A failed page supplies no successful new continuation.

For a fixed nonempty population of N items, enumeration requires at most `ceil(N / pageSize)` nonempty pages. This bound does not apply under concurrent inserts.

Cursors and entries are detached immutable internal metadata. They are not viewer APIs, authorization tokens, persistent sweep state or point-in-time inventory certificates.

## 5. Preparation algorithm

One call handles one entry in one caller-owned READ COMMITTED transaction. Do not combine multiple preparations, enumeration and preparation, or provider work in the same transaction.

### 5.1 Current source authority

For a complete locator, acquire and validate in this order:

1. Namespace gate through `lockReadySlackNamespaceGate`, using the enumerated revision, exact raw channel and exact workspace.
2. Integration through `lockSlackSelection`, using the enumerated integration ID.
3. Binding row.
4. Exact scoped channel row.

Require:

- enabled Slack integration in the exact team;
- current selection includes the exact channel;
- current configuration revision equals the captured binding revision;
- verified binding with matching integration, configuration revision, effective-token fingerprint, workspace, valid app ID and selected channel;
- channel binding matches the same integration/revision;
- `public_state = 'public'` and finite recorded public-check time;
- namespace readiness at the captured revision containing the exact workspace.

`lockSlackSelection` reads configuration, decrypts a saved secret locally and resolves the environment fallback. This is permitted. “DB-only” means no provider request or external side effect; it does not mean no secret enters memory. Tokens, fingerprints, ciphertext and rejected selection values must not enter results or telemetry.

These checks use stored proof and current local configuration. They do not refresh provider metadata or certify live freshness. Transient metadata uncertainty must not become private/revoked state.

### 5.2 Queue and item order

After the authority locks:

5. Perform a plain exact-scope queue existence read, without `FOR UPDATE` or `SKIP LOCKED`.
6. If present, return `already_pending` without queue mutation. This says work existed when read; it does not attest the item or promise the row survives later deletion.
7. Otherwise lock the exact team/item row with a narrow scalar `SELECT … FOR UPDATE`.
8. Validate the locked item.
9. Read ledger facts and conflicts after the item lock.

The plain queue read avoids an unnecessary queue lock that could cause `claimDueSlackThread … SKIP LOCKED` to bypass useful work. Authority locks already serialize preparation with the same-channel publisher.

The early read is an optimization. A concurrent direct enqueue can insert afterward; §5.5 handles that through the dependency’s `inserted` result.

Do not introduce an item-first then queue-row-lock cycle. Absence leads only to the existing enqueue helper; this primitive does not explicitly lock an existing queue row. Do not acquire ledger row locks before the item.

### 5.3 Canonical proof and exact ledger contradictions

The locked item must have:

- exact requested team and item ID;
- a project belonging to the same team with slug `slack`, matching the internal publication project;
- `kind = 'transcript'`, `access = 'team'`;
- exact path `scopedSlackItemPath(workspaceId, channelId, rootTs)`;
- string frontmatter values: source exactly `slack`, workspace/channel exactly equal to the locator, and both `ts` and `thread_ts` exactly equal to the root;
- a timestamp accepted by `parseSlackTimestamp`, preserving its bytes.

The path builder lowercases workspace/channel path segments. **Never recover provider IDs by parsing or uppercasing path segments.** Exact IDs originate in durable frontmatter and must agree with binding, channel, gate and ledger facts.

Require a live root witness in `slack_messages`:

```sql
team_id = $teamId
and workspace_id = $workspaceId
and channel_id = $channelId
and message_ts = $rootTs
and root_ts = $rootTs
and is_root = true
and item_id = $itemId
and deleted_at is null
and isfinite(observed_at)
```

Reject either contradictory binding using `EXISTS`.

**Same item bound to another thread or scope:**

```sql
exists (
  select 1
  from slack_messages
  where team_id = $teamId
    and item_id = $itemId
    and (
      workspace_id <> $workspaceId
      or channel_id <> $channelId
      or root_ts <> $rootTs
    )
)
```

**Same scoped thread bound to another item:**

```sql
exists (
  select 1
  from slack_messages
  where team_id = $teamId
    and workspace_id = $workspaceId
    and channel_id = $channelId
    and root_ts = $rootTs
    and item_id <> $itemId
)
```

Both predicates include deleted ledger rows: neither contains a `deleted_at` filter. A deleted row still records binding.

The second predicate is explicitly on **`root_ts`**, not `message_ts`. A reply belonging to this root but bound to a second item must refuse preparation. Restricting this check to `message_ts = rootTs` is incorrect and is killed by M1h.

Do not load full message sets. These are existence checks, not new ledger ownership writes.

The witness is justified by the current writer: `reconcileCompleteSlackThreadEvidence` requires complete evidence containing exactly one root, locks the item before ledger work, and publication commits reconciliation and queue acknowledgement together. It is not a new “last complete read” field or proof against arbitrary out-of-contract database writes.

Do not substitute `synced_at`, item age, participant counts, eligibility, mapping or generation for the witness. Bot, unmapped, zero-reply and root-tombstone cases remain eligible when a live witness survives. A tombstone exclusion reason differs from ledger `deleted_at`.

### 5.4 Exact path conflicts

Use the existing `scopedSlackItemPath` and `slackChannelPathPrefix` helpers.

```text
scopedPath = scopedSlackItemPath(workspaceId, channelId, rootTs)
legacyPath = slackChannelPathPrefix(channelId) + rootTs + ".md"
```

Require both predicates to be false:

```sql
exists (
  select 1 from items
  where team_id = $teamId
    and path = $scopedPath
    and project_id <> $slackProjectId
)
```

```sql
exists (
  select 1 from items
  where team_id = $teamId
    and path = $legacyPath
)
```

These match the publication conflict predicates in `lib/ingest/index.ts`. “Live legacy path” means an extant item row in any project, irrespective of access, kind or frontmatter. There is no item soft-delete predicate.

Within the Slack project, `(team_id, project_id, path)` uniqueness prevents a second owner. Exact candidate project/path proof remains required.

These are read-time checks, not predicate locks preventing every future conflicting insertion. Preparation adds no table locks and grants no publication authority. A conflict inserted after the check can leave pending metadata; actual publication must still perform its existing locked conflict checks. Namespace activation still requires draining legacy writers.

### 5.5 Due time and insertion

After proof:

1. Compute the exact due instant in PostgreSQL:

   ```text
   exactDue = observed_at + revisitAfterMs
   ```

2. Validate finite observation and finite, representable due output before JavaScript conversion. Guard arithmetic against corrupt extreme timestamps; no infinity-to-Date conversion.

3. Compare `exactDue <= clock_timestamp()`. Do not use transaction-start `now()` or an application wall clock.

4. If false, return `not_due`.

5. Round upward using exact database numeric arithmetic:

   ```text
   dueEpochMs = ceil(extract(epoch from exactDue) * 1000)
   ```

   Validate a safe, Date-representable integer before constructing the Date. Do not round the observation before adding the interval.

6. Call `enqueueSlackThread` on the decorated caller session with exact locator scope and rounded due time.

7. Return `enqueued` only for `inserted: true`; otherwise return `already_pending`.

The exact due instant can have passed while its upward-rounded millisecond lies less than 1 ms in the future relative to the decision clock. `enqueued` is correct there; it does not promise an immediate successful claim.

Never replace historical due time with invocation time. Unchanged witness facts derive the same rounded instant.

Every callback result is provisional until commit. A later operation failure must escape and roll back; it must not become a committing refusal.

## 6. Validation, results and redaction

Capture and validate inputs before the first await. Copy nested cursor/locator metadata rather than retaining mutable caller objects.

Validate:

- UUID syntax for team, item and integration;
- equality of request team, entry team and cursor team where applicable;
- nonempty ASCII alphanumeric provider IDs;
- revision as a nonnegative safe integer, losslessly parsed from stored decimal text;
- configuration revision as lowercase SHA-256 hex;
- root timestamp through the existing exact parser;
- integer page size and revisit interval;
- cursor version, ordering bounds and policy;
- execution deadlines, monotonic-clock values and timeout values;
- the closed receipt shapes and categories in §8.

New SQL projections must check JSON string types and byte lengths before returning values. Bounds are 256 bytes per provider ID, 128 bytes per timestamp and 2,048 bytes per path. Oversized stored values are `invalid_metadata`, never silently truncated into accepted identities. These are private primitive bounds, not shared schema/provider syntax changes. Excess-size refusals remain coverage gaps.

New code must not select item bodies, complete frontmatter objects, directories, staged messages or full ledgers. Existing integration configuration/secret and gate/binding-array reads retain their existing behavior; this packet does not claim a new global dependency memory bound.

Successful preparation vocabulary:

- `enqueued`;
- `already_pending`;
- `not_due`;
- `unattested`, with `not_slack`, `invalid_metadata`, `missing_channel_binding`, `missing_namespace_pin`, `item_missing`, `canonical_mismatch`, `missing_root_witness` or `contradictory_ledger`;
- `refused`, with `namespace_changed_or_unready`, `source_not_current`, `binding_changed`, `channel_not_public`, `scoped_path_conflict` or `legacy_path_conflict`.

Invalid caller contracts throw a static validation error before data SQL. Stored-value refusals and validation errors must not quote rejected values. Prevalidate values passed to dependencies that can quote inputs, including stored root timestamps.

Unexpected SQL, timeout, connection and dependency failures throw. The safe reporting vocabulary is:

```text
lock_timeout
statement_timeout
deadline_exceeded
serialization_failure
deadlock
database_failure
dependency_failure
commit_unknown
```

Do not return `{ok:false}` for ordinary refusals; the transaction engine assigns that shape special rollback meaning.

The transaction engine can replace a callback exception with `TransactionExecutionError`, carrying `.sql`, `.cause` and driver text. Preserve that internal exception identity for rollback/retry. Classify **outside the complete `runContextTransaction` promise**, before reporting or logging.

The pure classifier must not serialize, spread, log, attach or return the original exception. Its exact contract is in §8. Raw private transaction exceptions can contain sensitive data; only the classified static result is reportable. Tests must distinguish those boundaries rather than falsely asserting that shared internal exceptions have been scrubbed.

KR-16 must inspect:

- new validation exceptions and successful outputs;
- classifier outputs and their own/nested fields;
- tally outputs;
- telemetry captures;
- outer transaction exceptions supplied to classification.

Use unique synthetic canaries for rejected metadata, token, fingerprint, ciphertext and SQL. None may enter reportable objects or telemetry. This packet does not modify the shared transaction error class.

## 7. Execution limits and numeric plan stop

### 7.1 Supported guarantee

The caller owns session and connection. `SqlExecutor` exposes no abort signal. The primitive cannot cancel an in-flight driver call, destroy the connection or independently roll back the caller transaction.

There is no AbortSignal API and no `Promise.race` abandoning a still-running statement.

The contract supplies:

- an absolute monotonic operation deadline;
- admission checks before and after awaited work;
- PostgreSQL per-statement and per-lock-wait limits;
- whole caller transaction rollback on failure.

It does not promise that checkout, transport, cleanup, commit or rollback finishes within a hard wall-clock deadline.

### 7.2 Budget ownership and retries

Create execution context before entering `runContextTransaction`.

- Default allowance: 2,000 ms.
- Configurable allowance: integer 1,000–5,000 ms.
- Effective deadline: minimum of operation deadline and any supplied ambient deadline.
- Caller explicitly supplies an ambient deadline or declares none. The session cannot discover it.
- Reuse the same context across transaction attempts. A retry receives no fresh allowance.
- An earlier ambient deadline can leave less than 1,000 ms.

Use a monotonic clock. A test-controlled clock may be supplied through the slice-local execution context; production defaults to the real monotonic clock. Invalid or failing clock reads throw safely.

`runContextTransaction` retains its existing retry policy. This packet neither expands nor suppresses it. A second callback checks the original deadline before data SQL. The current wrapper does not retry lock timeout or unknown commit.

### 7.3 Decorated session

Every dependency receives the same slice-local decorator:

- `executeSql` delegates to the original connection-bound executor.
- Data statements are sequential.
- `db` and `optionalAudit` fail closed if used; the required inspected helpers use `executeSql`.
- No pool access, nested transaction, savepoint, concurrent query or retained usable executor after exit.
- Mark the decorator inactive on exit.

Read original `statement_timeout` and `lock_timeout` through the original executor at entry. Parse server-normalized settings correctly; zero means disabled.

Before every data statement, including internal helper statements:

1. Check deadline.
2. Calculate remaining whole milliseconds; throw if less than 1.
3. Set statement timeout no greater than remaining allowance and any stricter original nonzero statement timeout.
4. Set lock timeout no greater than 250 ms, remaining allowance, and stricter original nonzero lock or statement limits.
5. Apply both transaction-local settings with `set_config(..., true)`.
6. Recheck deadline after setup.
7. Execute the statement and check deadline after completion.

Refresh each time. Do not cache assumed settings. Timeout-control SQL uses the underlying executor to avoid recursion.

Setup SQL runs under preceding server settings. Settings/read/dispatch round trips prevent an exact end-to-end deadline promise.

### 7.4 Restoration and throwing outcomes

For every normal return, including every `unattested`/`refused` reason, `not_due`, early `already_pending`, conflict-path `already_pending` and `enqueued`, restore both original settings on the same connection before resolving. Restoration failure throws.

After a SQL failure, the transaction can already be aborted. Do not issue restoration that masks the primary error. Propagate; rollback restores transaction-local changes.

A local deadline or dependency exception must also escape the callback. A decorator-only exception is not necessarily recorded by the underlying SQL failure tracker. Catch-and-continue is unsupported and must not be described as automatically poisoned.

No operation uses `optionalAudit` or savepoint recovery. A server timeout is recorded by the tracker and forces rollback even if a callback accidentally catches it.

KR-12 must distinguish:

- **Normal returns:** same-transaction readback equals the values immediately before the primitive.
- **Throw with reusable connection:** after whole-transaction rollback, the same physical connection equals its pre-BEGIN session settings. Prior transaction-local overrides appropriately disappear on rollback.
- **Connection loss, failed rollback or unknown commit:** prove discard through the existing transaction mechanism; do not claim readback from a dead connection. A replacement connection has its established baseline and no leaked settings.
- **Validation before setup:** no timeout mutation occurred.
- **Restoration failure:** no success receipt; rollback or connection discard is observed.

### 7.5 Physical work, fixture and mandatory numeric stop

Bounded output and fixed statement count do not bound scanned tuples.

The pinned schema provides:

- `(team_id, id)` for item enumeration;
- `(team_id, item_id, occurred_at)` for per-item ledger lookup;
- unique `(team_id, workspace_id, channel_id, message_ts)` for a root witness.

It does **not** provide:

- `(team_id, path)` for cross-project path conflicts;
- an index containing `root_ts` for the second contradictory-ledger predicate.

The latter may scan the channel’s ledger through a scope-prefix access path or another chosen plan for every preparation. An index helping exact `message_ts` lookup does not make a `root_ts` lookup indexed.

Use this minimum isolated-PostgreSQL plan fixture:

- one team with 100,000 non-Slack items;
- an additional 601 canonical Slack root items;
- all 601 roots in **one exact workspace and one exact channel**;
- one root witness and 100 distinct valid reply rows per root: 60,701 ledger rows in that channel;
- schema-valid live and deleted replies;
- at least one root established through real publication;
- other bulk members explicitly labeled synthetic capacity fixtures.

Keep every root’s complete cohort in that channel; splitting roots across channels does not satisfy the fixture. Extra conflict rows/items may be added in separately identified hit cases. Record actual cardinalities.

Capture isolated `EXPLAIN (ANALYZE, BUFFERS)` for the actual SQL shapes of:

- upper-bound read and continuation read;
- locator enrichment;
- root witness;
- both contradictory-ledger checks, including live/deleted second-item reply hits and no-hit scans;
- both path-conflict checks, with hit and no-hit cases;
- remaining data statements used by complete preparation, including the enqueue path in rollback-controlled measurements.

No provider calls are involved. Do not force planner methods or add indexes to obtain a passing result.

**Astra-owned stop thresholds:**

- Every measured data statement must be **at most 200 ms**.
- A complete page operation and a complete preparation operation must each be **at most 750 ms**.

For each required query/case, retain five measured observations after fixture loading and statistics collection. For plan observations, compare planning plus execution time with 200 ms. Separately measure five ordinary executions of each statement and complete operation; compare ordinary statement elapsed time with 200 ms and operation elapsed time with 750 ms. Report every retained observation and their maximum. Do not use a median to hide an exceedance.

Measure complete operations from primitive entry through successful restoration. Include settings round trips, validation and local secret resolution. Exclude checkout, outer commit/rollback and `EXPLAIN` instrumentation from that operation measurement. Use real monotonic time, the default 2,000 ms allowance, no tighter ambient deadline, controlled original settings and no intentional lock contention. Reset queue state between due/enqueue measurements so an early-existing-row shortcut cannot substitute for the full path.

These are fixture admission thresholds, not runtime timeout settings or production capacity claims. Cold-cache behavior is not certified merely by these observations.

The 750 ms threshold leaves 250 ms within the minimum configurable 1,000 ms allowance and 1,250 ms within the default allowance. The 200 ms statement threshold is below the 250 ms lock-wait cap and prevents one uncontended scan from consuming most of the minimum allowance. The thresholds provide headroom; they do not guarantee that contention, transport or retries will fit.

**If any retained observation exceeds either threshold, or the measurement times out or cannot complete, stop further implementation of the affected slice and block implementation acceptance/publication pending schema-owner adjudication.** Evidence collection and preservation may continue. A measurement failure is not a passing plan.

Do not raise thresholds, increase runtime limits, silently add an index, edit PR743-owned schema, discard a slow sample or call recurring timeout successful enumeration. A documented infrastructure fault requires an explicit adjudicated rerun; it is not a unilateral waiver. Any schema-owner remedy requiring out-of-allowlist work needs a separately owned change.

Record environment, PostgreSQL version, statistics preparation, fixture cardinalities, sanitized parameter descriptions, rows, loops, buffers, timings and snapshot identity. No plan or threshold result has been verified in this adjudication.

## 8. Concurrency, progress and product-owned accounting

Preparation serializes on shared gate/integration locks. The integration lock can contend across channels of one integration. The 250 ms cap does not guarantee progress for each root.

**Chosen failure policy:** enumeration progress is independent of preparation outcome. After a page commits, its continuation may be retained even when a later preparation fails. That entry waits for a later sweep.

There is no internal retry loop, per-root retry queue, cursor pinning or durable retry mechanism. A future caller needs separate review for such mechanisms.

### 8.1 Pure failure classifier

Export from `slack-known-root-requeue.ts`:

```ts
classifySlackKnownRootPreparationFailure(error: unknown): FailureCategory
```

It returns exactly one §6 failure category, with no error object, message, SQL, identifier or cause attached.

Precedence:

1. A true outer `unknownCommit` marker yields `commit_unknown`, regardless of callback result or SQLSTATE.
2. The slice’s explicit deadline-error marker yields `deadline_exceeded`.
3. SQLSTATE `55P03` yields `lock_timeout`.
4. SQLSTATE `57014` yields `statement_timeout`.
5. SQLSTATE `40001` yields `serialization_failure`.
6. SQLSTATE `40P01` yields `deadlock`.
7. Other database SQLSTATEs or the shared transaction-execution error type yield `database_failure`.
8. Other exceptions yield `dependency_failure`.

Read only the allowlisted markers/code and known error identity needed for this mapping. Do not inspect message, SQL, stack or nested causes. Inspection must fail safely for malformed objects or throwing property access; it must not expose the object or throw its content.

Use the final rejection from the complete transaction promise. This classifier does not decide retries, suppress errors or open transactions.

### 8.2 Pure page tally reducer

Export from the same module:

```ts
tallySlackKnownRootPage({ examined, receipts }): PageTally
```

The tally belongs to one successfully committed enumeration page. `examined` is its integer count, 0–100. The page’s entry order defines stable `entryIndex` values `0 … examined - 1`.

Each receipt is exactly one of:

```ts
{
  entryIndex,
  state: "not_attempted",
  attempts: 0
}
```

```ts
{
  entryIndex,
  state: "committed",
  attempts: 1 | 2,
  result: /* complete closed preparation result from §6 */
}
```

```ts
{
  entryIndex,
  state: "failed",
  attempts: 1 | 2,
  failure: /* closed FailureCategory */
}
```

`committed` is legal only after the complete `runContextTransaction` promise resolves. `failed` is legal only after that promise finally rejects, following any existing permitted retry. `not_attempted` means no preparation invocation was started for that slot.

`attempts` records how many callbacks actually ran; a transaction setup failure before any callback may use `attempts: 0` on a failed receipt. Thus failed receipts accept 0, 1 or 2; committed receipts require 1 or 2. A failed callback is not itself a final failed receipt while the wrapper is retrying.

The reducer:

- validates and copies inputs;
- requires coverage of every page index;
- rejects out-of-range/missing indices, invalid categories, invalid counts, provisional callback results and per-attempt records with a static error;
- collapses exact duplicate receipts for one index;
- rejects conflicting receipts for one index;
- returns only counters and closed category counts, without retaining or returning receipts, item IDs, page cursors or errors.

Complete accounting is produced only after every started invocation settles. An in-flight preparation cannot be represented as `not_attempted`. Partial page execution is expressible by explicit not-attempted receipts for entries never started; no active worker is added to enforce or execute that scheduling.

The result satisfies:

```text
examined
  = enqueued
  + already_pending
  + not_due
  + unattested
  + refused
  + preparation_failed
  + not_attempted
```

The sum of `failureCounts` equals `preparation_failed`. Successful subreason counts, if returned, must likewise sum to their parent category.

### 8.3 Exactly-once logical counting and unknown commit

Exactly-once here means one contribution per enumerated page slot after a logical transaction invocation settles. It is not durable cross-process exactly-once delivery.

Examples:

- Attempt 1 rolls back with `40001`; attempt 2 commits `enqueued`: one committed receipt with `attempts: 2`; `enqueued = 1`, `preparation_failed = 0`.
- Both attempts fail: one final failed receipt with `attempts: 2`; `preparation_failed = 1`.
- Callback returns `enqueued`, but commit acknowledgement is unknown: one failed receipt with `failure: "commit_unknown"`; `enqueued = 0`.
- The same final receipt is delivered twice: counters are unchanged by the duplicate.
- Two conflicting final receipts for the same slot: static contract failure; neither is silently chosen.
- No preparation was started for a slot: exactly one `not_attempted` contribution.

This follows from the reducer’s unique page-index reduction, terminal-only input validation and disjoint category assignment. Tests must exercise the exported implementation, not compute expected counters in a test-owned replacement.

An unknown commit is never relabeled insertion success or proven absence. Replay checks durable state, but does not retroactively rewrite the original failed receipt. A later explicit replay belongs to a separately identified invocation/report; this packet supplies no durable deduplication across reports or sweeps.

KR-10 must feed real transaction-wrapper retry outcomes into these exported helpers. M15 must demonstrate that counting attempts or treating unknown commits as successes changes product output.

### 8.4 Concurrency consequences

Required consequences remain:

- Two preparers insert at most one row; the other observes or races into existing work.
- Publisher first: preparation sees the refreshed observation and removed queue.
- Preparer first: publisher waits for shared authority locks.
- Direct enqueue after the plain queue read: preserve the inserted row and return `already_pending`.
- Crash before commit: no durable insertion.
- Commit with lost receipt: replay preserves the single durable row.
- Lost cursor: safe replay is possible, but repeated restarts can prevent eventual sweep progress.

A failed preparation is not `refused`, `not_due` or completed work. Exhaustion means traversal of the key range ended, possibly with failures and unattempted entries. It never means source synchronization or completed reconciliation.

No `SKIP LOCKED` disguises a failed preparation as processed work.

## 9. FIFO starvation, missing provenance and sweep cost

Historical `due_at` preservation accurately represents overdue observation and is retained.

If 601 completed roots have due dates days in the past, a fresh root enqueued now sorts behind all 601. At one replies request per minute, even one request per old root delays the fresh root approximately 601 minutes—10 hours and 1 minute. Multi-page threads, retries and competing work can increase that delay.

A finite old cohort causes long delay, not necessarily infinite starvation. Repeated admission of earlier-due work can sustain starvation. Conversely, busy recent traffic provides no guarantee that old roots are revisited without a producer or reserved lane.

The inserted row has neither producer provenance nor a reconciliation lane. Discovery and preparation can produce indistinguishable rows. A later selector cannot reliably recover provenance from `due_at`, attempts, timestamps or item existence; a previously published root may receive changed/new discovery work.

Enumeration also scales with **all team items**. A fixed population of 100,000 arbitrary team items requires **at least 1,000 page transactions at page size 100**, before preparation transactions, retries or replay. With 100,000 non-Slack items plus 601 roots, the §7.5 fixture requires at least 1,007 nonempty pages at that size. This is a held capacity limitation, not a certified feasible sweep cadence.

KR-15 characterizes FIFO delay and this traversal cost. Neither is fairness or capacity acceptance.

Before activation, assign one owner and choose durable representations for sweep progress, lane classification/turn, changed-root observations and fair provider allocation. Alternating replies slots, lending empty slots and persistent turns under one-request budgets remain unsatisfied.

Preparation makes no provider reservation and changes no Retry-After, backoff, lifetime claim ordinal, lease, staging or method-budget behavior.

## 10. Deletion, access and queue lifecycle

- Deletion before the item lock yields no enqueue; ledger rows cascade with the item.
- Preparation never recreates content or ledger evidence.
- Queue rows have no item foreign key. Deletion after preparation can leave an orphan.
- Deterministic orphan race: preparation holds the item lock; deletion waits; preparation commits enqueue; deletion then commits and cascades ledger evidence while leaving the queue.
- If later hydration/publication lacks a deletion-aware canonical/access check, `ingestItem` can recreate an item at that path. The queue does not encode intentional item deletion.

Scoped purge fan-out and pre-request/pre-publication revalidation remain activation blockers. This inactive slice does not solve them.

Revocation after enqueue can likewise leave inert pending metadata. Stored preparation never authorizes provider HTTP or publication.

No mapping, correction owner, contributor count or member eligibility controls root scheduling. Identity is attribution only and grants no access.

Keep delete-on-publication. Retaining successful rows would change acknowledgement, snapshot cleanup, attempts, pending counts, generations and leases, while still failing to supply historical seeding or durable lane fairness. That redesign remains excluded.

## 11. Acceptance matrix and behavioral red plan

All KR IDs are slice criteria. Passing them does not close AC-02.

### Red sequence

1. Add a permanent discovery characterization using existing helpers: real publication deletes queue/staging; completed-history newest discovery omits the old root; its queue remains absent. It passes before and after this slice and is gap evidence, not red-to-green proof.
2. Add compiling, callable stubs. Missing imports, “not implemented” exceptions and type failures do not count as behavioral red.
3. An empty-page reader stub must fail the exact expected published item/locator assertion.
4. Once the reader exists, retain a normal-returning no-op preparer. KR-01 uses only team plus its real page entry and expects the exact queue row. Absence is the behavioral red.
5. Implement without weakening those expectations. Record the green transition and controls.
6. Give the pure classifier/reducer compiling stubs and behavioral assertions for final retry accounting, duplicate receipts and unknown commits. Their product behavior must become green.

Stubs and red evidence remain checkpointed history; no stub is accepted in the final implementation.

| ID | Required proof |
|---|---|
| KR-01 | Real `ingestItem` publication commits canonical item/ledger and deletes queue/staging. Explicitly age test observation or use controlled fixture time. Enumerate on a fresh connection; prepare using team plus entry only. Recreate exactly one row without another history occurrence or fixture authority constants. |
| KR-02 | At least 601 canonical roots plus unrelated items, multiple page sizes, exact IDs/counts and exhaustion. At least one root comes through real publication. Bulk-seeded members are labeled capacity fixtures. |
| KR-03 | Project, kind, access, typed metadata, path, missing/deleted/nonfinite witness, both ledger contradictions and both path conflicts refuse without mutations. Include a same-root reply owned by another item, both live and deleted. |
| KR-04 | Same timestamps across teams/workspaces/channels, mixed-case provider IDs and byte-distinct timestamp spellings never cross scope. Lowercased path segments never become provider IDs. |
| KR-05 | Unmapped root with mapped human replies, bot root, zero-reply root and tombstone root remain schedulable with live witnesses. No attribution eligibility filter. |
| KR-06 | Existing queued, backed-off, running, expired, partial-snapshot and complete-snapshot rows remain byte-identical, including attempts/timestamps. Exercise the deterministic conflict branch below. |
| KR-07 | Past/future and exact-microsecond due values; finite bounds; ceiling rather than truncation; `clock_timestamp()` rather than transaction-start time. Unchanged publication refreshes observation without semantic-generation churn. |
| KR-08 | Two preparers, both publisher orderings, rollback after enqueue, fresh-connection replay, lost receipt and stale-claim dependency characterization. |
| KR-09 | Disabled/deleted integration, deselection, stale binding/config, workspace change, nonpublic/unknown channel, real stored-secret rotation, real environment rotation and stale namespace revision refuse. Invalidate then reready between enumeration and preparation; old entry refuses. |
| KR-10 | Empty team, sparse/all-invalid pages, deleted cursor and bounded output. Contention throws while the next page remains obtainable. Exported classifier/reducer prove one final contribution after a real two-attempt retry, exact duplicate idempotence, conflicting/provisional receipt rejection, not-attempted accounting and unknown-commit precedence. |
| KR-11 | Inserts below cursor, between cursor and bound, and above bound have the specified behavior. Queue traffic preserves old due values and does not reset enumeration. |
| KR-12 | SQL failure, `55P03`, `57014`, local deadline, retry exhaustion, dependency throw, restoration failure and rollback after mutation never become successful empty/refused completion. Prove both timeout settings restored for every normal result/reason, rollback restoration on reusable throwing paths, and discard/baseline behavior for unusable connections under §7.4. |
| KR-13 | No item/version/ledger/identity/access/generation/channel/budget/run mutations; exact snapshots and caller rollback. |
| KR-14 | Both modules and all exports remain unreachable from execution entries. Outside imports and unauthorized writes fail guards. Local secret decryption is allowed; provider calls are not. |
| KR-15 | Characterize FIFO delay, 100,000-item traversal cost, lost-cursor replay, failures awaiting later sweeps, and orphan/recreation risk. None completes parent acceptance. |
| KR-16 | Every validation family in §6 has valid, invalid and boundary controls. Caller mutation after invocation cannot change captured inputs. Stored projections enforce type/byte bounds. Synthetic rejected-value, secret, fingerprint, ciphertext and SQL canaries are absent from all reportable outputs and telemetry, including classification after outer transaction replacement. |
| KR-17 | Exact §7.5 single-channel fixture, full required plan inventory, five retained observations per case, real-clock statement/operation measurements and explicit threshold comparison. Evidence records pass or stop; any exceedance blocks further implementation and acceptance pending schema-owner adjudication. No performance result is inferred from `LIMIT`, an index name or a test timeout alone. |

### Deterministic conflict-do-nothing race

Use preparation connection A and independent queue-writer connection C:

1. A obtains authority locks and executes the plain queue existence read.
2. A’s test-only executor wrapper observes that the actual query returned no row, signals a barrier, and withholds resolution to the preparer.
3. At this point A has no in-flight SQL and has not requested the item lock. No 250 ms lock wait is running.
4. C calls existing enqueue directly, then existing claim/release helpers as needed to commit a recognizable backed-off row with nondefault attempts/state.
5. Read and retain the committed row snapshot.
6. Release A’s barrier. A locks the item, completes proof and reaches the existing enqueue conflict clause.
7. Assert `inserted: false` was exercised, final outcome `already_pending`, and every queue field remains identical.

Do not substitute discovery for C; discovery requires A’s held integration lock. No item-lock holder B is required for this race. Item-lock contention is tested separately.

Use observable barriers, never sleeps. The synchronization hook exists only in the test executor wrapper, not production code. Use the §7.2 controlled test clock to exclude only the artificial barrier pause from A’s monotonic operation budget; restore ordinary progression on release. This fixture is not timeout or performance evidence. Real-clock tests independently prove deadline behavior.

### Timeout and restoration fixtures

Hold the item or integration lock until preparation fails with `55P03`, approximately the configured cap plus measured transport/test slack. Assert rollback and absence of a new row.

Inject a genuinely slow dependency statement to produce `57014`. Verify later helper statements receive reduced remaining timeouts.

Table-drive all normal result/reason paths and all throwing classes in KR-12. Check both settings at the correct transaction boundary defined in §7.4. Restoration failure itself must prevent a successful receipt.

### Retry and accounting fixtures

Use the actual `runContextTransaction` wrapper and a real PostgreSQL retryable failure on attempt 1. Verify attempt 2 shares the original deadline.

Feed only the final promise result/rejection into the exported classifier and reducer. Assert:

- retry then commit counts one success;
- retry then terminal failure counts one failure;
- attempt-level records are rejected;
- duplicate final receipts count once;
- unknown commit overrides provisional callback success;
- a failed entry does not prevent obtaining the next enumeration page.

An already-expired ambient deadline issues no data SQL.

### Stored-secret rotation fixture

Use only synthetic tokens and the existing crypto/selection helpers:

1. In an isolated test environment, install a synthetic 32-byte `SECRETS_KEY`, preserving its prior presence/value for `finally` restoration.
2. Encrypt synthetic token A with real `encryptSecret`. Create an enabled Slack integration with fixed `status`, `type`, `config` and microsecond-preserving `updated_at`.
3. Establish valid binding/channel/gate fixtures for token A and obtain an entry through real enumeration.
4. Read the authoritative configuration revision through real `lockSlackSelection` in a separate completed transaction; retain it privately.
5. Encrypt distinct synthetic token B.
6. In a separate test setup transaction execute only:

   ```sql
   update integrations
   set secret_ciphertext = $ciphertextB
   where team_id = $teamId
     and id = $integrationId
   ```

7. Do not modify `updated_at`, `config`, `status`, `type`, binding rows or channel binding stamps.
8. Read back and assert exact unchanged `updated_at` and unchanged real selection `configRevision`, with changed effective token fingerprint.
9. Prepare using the pre-rotation enumerated entry. It must refuse current-source/binding authority and insert nothing.
10. The M6a fingerprint-check mutant must incorrectly enqueue under this same otherwise-valid fixture.

Do not import or edit `lib/integrations/manage.ts`. The direct update is explicitly synthetic fixture construction, not an approved production rotation path.

Separately test real environment fallback with no stored ciphertext. Temporarily control both `SLACK_BOT_TOKEN` and `slack_bot_token`, prove alias precedence and effective-token rotation, and restore both variables exactly in `finally`. Do not add a preparer `envToken` seam or rely on fixture constants without real token resolution.

### Namespace rereadiness fixture

Use the real invalidator, then a schema-valid test-only readiness fixture at the greater revision. Do not use the empty-new-channel producer as if it repaired a channel with canonical items. Old enumeration refuses; fresh enumeration may proceed.

## 12. Mutation matrix

Each mutation requires a named behavioral assertion and green baseline. Dependency experiments are disposable and isolated, never committed implementation edits, and restored byte-identically.

| Mutant | Exact change and non-equivalent falsifier |
|---|---|
| M1a — enumeration team | Remove team filtering from the bounded item relation. Second-team IDs inside the UUID range violate exact returned IDs. |
| M1b — workspace metadata | Remove only locked frontmatter workspace equality. After enumeration, change workspace only by case; retain original path, witness and authority. Lowercased path equality cannot hide the missing check. |
| M1c — channel metadata | Corresponding channel-only equality removal and case-only stored change. |
| M1d — contradictory workspace | Remove only workspace difference from the same-item predicate. Add a schema-valid extra row for that item with another workspace and otherwise matching channel/root. |
| M1e — contradictory channel | Same construction with only channel differing and only that disjunct removed. |
| M1f — contradictory root | Same-item extra row with a different root, valid nonroot message timestamp and schema codec; remove only root-difference detection. |
| M1g — canonical path | Remove exact path equality. Change only the item path to noncanonical while preserving other facts. |
| M1h — second item owns a reply | Replace the second §5.3 predicate’s `root_ts = rootTs` with `message_ts = rootTs`. Keep candidate I1’s valid live root witness. Add reply `message_ts = replyTs`, `root_ts = rootTs`, `is_root = false`, `item_id = I2` in the same exact team/workspace/channel, with `replyTs <> rootTs` and schema-valid evidence. I2 has an unrelated nonconflicting item path. Baseline returns `unattested/contradictory_ledger`; mutant enqueues. Repeat with that reply’s `deleted_at` set; a separate variant adding `deleted_at IS NULL` to the contradiction check must also fail. |
| M2 — witness | Bypass root-witness existence while deliberately supplying a due observation in the mutant. An unattested canonical-looking item must not enqueue; a null dereference is not a kill. |
| M3 — attribution | Add eligibility/mapped-author gating. Witnessed unmapped, bot and tombstone roots incorrectly fail. |
| M4 — conflict update | Replace dependency conflict-do-nothing with a resetting update. The §11 executor-barrier race detects changed state or incorrect insertion outcome. Early-existing-row tests alone do not count. |
| M5 — age | Substitute invocation time for observation-derived due time. Assert exact persisted due instant. |
| M6a — token currency | Remove only current-token fingerprint equality. The exact stored-secret fixture preserves real configuration revision; mutant incorrectly enqueues. |
| M6b — revision pin | Substitute a freshly read gate revision for the captured one. Invalidate/reready between page and preparation. |
| M7 — cursor classification | Advance only past Slack-looking entries. An all-non-Slack page must advance to later items. |
| M8a — upper bound | Remove `id <= upperItemId`; a newly inserted above-bound item is incorrectly included. |
| M8b — OFFSET | Substitute offset pagination; deletion before page two causes an exact-ID omission. |
| M9 — swallowed failure | Catch executor failure and return successful empty/refused output. Direct rejecting-executor tests detect it. Separately prove real transaction-tracker rollback without mislabeling existing protection as the mutation kill. |
| M10 — transaction escape | Enqueue on another connection in an isolated mutant. Caller rollback leaves an independently committed row. |
| M11 — owner fence | Remove the owner-token condition from one named fenced dependency write. Delete/recreate/reclaim with matching generations but different owner tokens; old claim must not mutate replacement. |
| M12 — wiring | Synthetic reachable route, scheduler-chain, script and root-instrumentation imports must each fail; unreachable test imports remain controls. |
| M13 — timeout refresh | Reuse initial timeout for later statements. A later slow statement fails the reduced-remaining-budget assertion. |
| M14 — settings leak | Omit either timeout-setting restoration on normal return. Same-transaction readback fails, including refused outcomes. |
| M15a — count attempts | Change reducer contribution from one per terminal slot to `attempts` contributions. Real two-attempt committed/failed fixtures violate exact counts and the accounting identity. |
| M15b — duplicate receipt | Remove same-index duplicate collapse. Duplicate terminal receipts incorrectly increment counts. |
| M15c — unknown commit | Remove classifier unknown-commit precedence. An outer unknown-commit error with a retryable SQLSTATE and provisional callback success must still yield exactly one `commit_unknown` failure. |

Do not claim arbitrary namespace predicate removal is non-equivalent. Redundant root-scope checks may remain protected elsewhere; the M1 fixtures isolate operative predicates.

Deleting the early existing-row shortcut can be observationally equivalent because enqueue preserves conflicts. No such kill is required.

Record baseline/mutant/restored hashes, exact test names, commands, expected behavioral failure and actual result. Compile failures, fixture errors and unrelated timeouts are not kills. Restore sources and rerun affected green checks.

## 13. Guards, observability and later verification

Extend the existing reachability guard without weakening it. Add both modules to the forbidden set and cover alias, relative, re-export, dynamic import and require edges from actual entry classes.

The new boundary guard rejects:

- application callers outside this packet importing any export;
- provider HTTP/transport dependencies;
- pool or independent transaction access;
- direct production queue DML;
- item/ledger/identity/channel/budget/run writes;
- schema/shared-file changes outside the allowlist.

Allow the existing enqueue helper as sole production queue writer, authority locks, timeout SQL and selection-helper local secret resolution. Pure helpers have no I/O.

Safe reporting consists of counts, closed outcome/failure categories, elapsed time and traversal exhaustion. Internal IDs/cursors belong in necessary API inputs/results, not telemetry. No content, paths, message IDs, item IDs, workspace/channel IDs, authors, email, tokens, fingerprints, ciphertext or raw errors enter logs.

Later verification includes:

- focused new unit and guard suites;
- isolated real-PG new suite;
- existing thread-state, publication, discovery, ledger and `slack-source-fences.datamechanics.test.ts` regressions;
- typecheck, targeted ESLint, docs drift and diff checks;
- required plans and numeric stop evidence;
- controlled mutation evidence;
- independent exact-snapshot code review.

These are obligations, not results of this adjudication. Broad-suite failures remain unresolved unless separately investigated and recorded.

Cross-references and ownership remain closed: accounting is owned by §8 in the allowed requeue module; KR-12 proves §7.4; KR-16 proves §6; KR-17 proves §7.5; the new M1h and M15 cases map to KR-03 and KR-10. No additional production, test-helper, management or schema path is required by these amendments.

## 14. Build-record append contract

The existing section beginning **“AC-09 inactive aggregate Slack pagination — implementation packet, recorded October 6”**, through its final-review continuation and final prohibitions, was inspected.

Preserve its distinct historical identities:

- structural red: `1a9073488476f931aa5fe9bdf0783da9d4a07e90`;
- initial implementation: `883aa24d027094741e68da3140f4e0e1e4eb9fe4`;
- hardening: `dc4fbf8487f0aa087eb0b8e4f0b3ee0fb8db27a8`;
- later behavioral red: `7ff1cd8b619b96065189117d696c20649d4f11a6`;
- converged source correction: `865c579357311502f89bb35844ecaf480ccc9cdb`;
- the recorded focused reviews, historical remote observations, broad-suite failures and outstanding acceptance/PR/CI work.

`883aa24d` is not the structural-red checkpoint. Correcting this specification’s prior wording does not rewrite the existing historical record.

Append a new level-three section after that continuation:

**“AC-02 inactive known-root requeue — specification and implementation record”**

At specification time record only:

- final round number, specification identity/hash once saved, and dispositions;
- pinned documentation/source/base identities;
- implementation, tests, query plans and live PR verification not yet performed for this specification;
- inactive scope, numeric plan gate and remaining AC-02 obligations.

As implementation proceeds, append dated subsections for red checkpoints, implementation, plans, verification, mutations, reviews and publication observations. Update only explicitly current status fields in the new section. Correct historical statements through dated superseding notes.

Never:

- replace historical heads with later SHAs without context;
- attribute old passing tests to new code;
- turn structural red into behavioral red;
- overwrite the AC-09 final-review continuation;
- claim the broad suite green;
- claim PR743 integration complete;
- mark AC-02 or AIO-1170 complete from KR acceptance.

Checkpoint records distinguish reviewed source identity, documentation identity, local recovery commit, verified remote backup and observation time. Preserve sanitized evidence durably under existing checkpoint rules.

## 15. Remaining acceptance and integration gates

This final specification resolves the primitive’s material design questions without expanding shared ownership. Implementation still requires behavioral red, successful acceptance evidence, query plans within the numeric gate, mutation evidence and independent code review.

Exceeding §7.5 is a stop for schema-owner adjudication, not authority to expand the allowlist. No such exceedance or passing result has been measured here.

The following remain held:

- full retained-history discovery and historical canonical seeding;
- durable, restart-safe sweep rotation;
- changed/new-versus-reconciliation fairness and immediate changed-root prioritization;
- fair multi-page replies and provider reservations;
- the minimum 1,000 page transactions per 100,000 arbitrary team items, plus preparation/retry work;
- provider reads, complete hydration and atomic publication wiring;
- current source/access checks before requests;
- scoped purge, orphan prevention and deletion-safe publication;
- provider-fixture runner → real DB → timeline AC-02 proof, including mapped replies beneath unmapped roots;
- conservative and verified-higher-budget cycle measurements;
- incident traces, capacity certification, identity/timeline/access integration, live acceptance and soak;
- PR743 semantic integration, both branches’ affected checks and fresh reviews;
- all activation, repair, cutover, merge and deployment gates.

The bounded success claim remains exactly:

> Explicit inactive preparation can reconstruct missing pending work for a witnessed completed canonical root from durable enumeration output.

**AC-02 NOT COMPLETE. This inactive primitive does not complete AC-02, does not implement the rotating runtime reconciler, does not establish full retained-history or reply coverage, does not satisfy fairness, capacity, deletion, integration or live acceptance requirements, does not authorize activation, and does not complete AIO-1170.**

READY FOR LINEAR ATTACHMENT AND RED-FIRST IMPLEMENTATION