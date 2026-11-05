# AIO-1167

Google Docs connector — upgrade and prove reliable ingestion

Build with: gpt-5.6-sol / high

## What

Upgrade the existing `gdrive` connector end to end, including authenticated selection, complete content, resumable synchronization, access/removal, shared person identity and visible Timeline evidence. The requirements and exclusions below remain authoritative.

## Why

The existing adapter does not establish complete readable extraction, durable Drive changes consumption or correct authorized person/day evidence. Administrators need reliable ingestion whose completeness, attribution, access and recovery can be verified, with live certification distinguished from automated implementation tests.

## Dependencies

- AIO-1166: check and reuse its shared completeness contract/implementation; do not assume it has shipped or create an incompatible duplicate.
- Otherwise none.

## Specification authority and outcome

This document normalizes the **existing specification on [AIO-1167](https://linear.app/je4light/issue/AIO-1167)**, including its person-identity and timeline addendum dated 2026-09-09. It preserves that scope; it is not a replacement feature proposal. Source inspection below updates implementation assumptions against repository commit `5b9400e74ff9b470682b785dcd33366cfbd74172`.

Upgrade source `gdrive` so an administrator can select Google documents or folders, import their complete readable content into Team Brain, and maintain accurate content, access, person attribution and timeline evidence through edits, moves, deletion, permission changes, restarts and provider outages.

The integration is read-only against Google. Document creation/editing, Gmail, Calendar, Sheets/Slides fidelity, arbitrary Drive binary formats and broad permission-system redesign remain outside this ticket. Do not introduce a competing Google ingestion path or a connector-specific people directory. The existing `google` integration type stores an LLM provider key; it must not be repurposed as `gdrive`.

Implementation acceptance and live certification are separate gates. Neither this document nor green mocked tests establish that authenticated ingestion, deployment or live certification has happened.

## Verified baseline and existing owners

The ticket’s original inspection at `da27eb6bea53c5f22a454b29872e6dc0a7fcd586` remains useful history. The current tree confirms these gaps:

- `ingestion/aios_ingest/sources/gdrive.py` wraps `GoogleDriveReader`, accepts `folder_id` or `file_ids` and an optional service-account key path, and ignores `since`.
- `ingestion/aios_ingest/sources/gdrive_watch.py` obtains a new start token during renewal, discards the watch response and saves the token as `resource_id`. Requested expiry is stored instead of provider-returned expiry. The source remains pull-only; the generic webhook route does not constitute a working Drive notification implementation.
- `ingestion/aios_ingest/state.py` stores SQLite cursors and one channel per connection **name**. `ingestion/aios_ingest/scheduler.py` advances a successful poll to its start timestamp. Neither is a valid opaque Drive changes cursor implementation or sufficient namespace for independent teams, credentials and scope generations.
- `ingestion/aios_ingest/engine.py` materializes a complete fetch and creates a push coroutine for every document. Existing HTTP rate limiting does not bound all fetch memory, work queues or document concurrency.
- `gdrive` is absent from `INTEGRATION_TYPES`, the non-secret config schemas, `lib/integrations/build-config.ts` and the selection translator. Existing Admin integration scaffolding therefore needs end-to-end wiring.
- Credential comments saying “the brain never stores secrets” are stale. `lib/integrations/manage.ts` owns encrypted `integrations.secret_ciphertext` and dedicated credential readers/writers. The sidecar selection endpoint intentionally returns non-secret selections. Adding a Drive config field must not accidentally turn that endpoint into credential transport.
- `ingestion/aios_ingest/sources/_llamahub.py` already rejects missing stable document IDs and normalizes work-time metadata spellings. It still flattens metadata and supplies a scalar author; that does not prove complete tabs, structured Google identity evidence or separate contribution roles.
- Shared attribution already exists. `member_identities` and `member_emails` are the account/alias registries; `lib/identity/context.ts` reads profile context. `lib/identity/provider-sync.ts` currently calls a resolver with heuristic fallbacks, so “by email” in its comment does not prove exact, verified auto-linking.
- `reconcileAttribution` already propagates mapping changes and invalidates learning caches, but is best-effort and coalesced only within a process. `reattributeItems` intentionally retains a previously resolved human when resolution disappears. These defaults do not satisfy this ticket’s durable unlink/remap repair requirement by themselves.
- Timeline attribution uses the common contributor oracle over `item_versions`, but ordinary document evidence currently uses one primary contributor and the item’s current source work time. Merely supplying an owner and a modified timestamp cannot preserve every observed person/day contribution.
- `purgeItemIds` already removes content through the ingest owner, cascades dependent rows, retires graph episodes with retryable tombstones and busts learning caches. Cache invalidation is best-effort; this is an integration seam, not proof that stale restricted prose can never be served.

`docs/ARCHITECTURE.md` is the data-ownership reference. Membership-based context enforcement is already live; do not design against retired permissive-mode columns. This product is normally self-hosted per organization, but team, connection and credential boundaries still require isolation tests. There is no RLS safety net.

| State | Existing owner and required use |
|---|---|
| Integration configuration and status | `integrations`, through `lib/integrations/manage.ts`; Admin role authorization on reads and writes |
| Connector secrets | Approved encrypted integration-secret path or documented local service-account installation; never selection JSON |
| Provider fetch, normalization and delivery | Existing Python `gdrive` source, sidecar engine and `BrainClient`; HTTP-only access to the brain |
| Durable connector progress | Existing connector-state boundary, extended with namespaced opaque cursors, generations, bounded pending work and overlapping watch records |
| Content, versions and removals | `lib/ingest` single writer; retain item identity and use shared purge/derived cleanup |
| Provider accounts and aliases | `setMemberIdentity` / `removeMemberIdentity`, shared provider synchronization/resolution and alias writers |
| Person attribution and repair | Common author/contributor resolution and `lib/ingest` repair path; honor correction locks |
| Audience and visibility | Existing context units, memberships, project/group grants and visibility choke points; attribution grants no access |
| Timeline and summaries | Common contributor evidence → `lib/dashboard/work-timeline.ts` → grouping/cache/API/UI; existing cache writers |
| Operational evidence | Durable run records and connector state; sanitized Admin diagnostics |

Physical schema changes must preserve these owners. Extend existing stores rather than creating parallel authorities. Existing-table additions require additive migrations and matching canonical schema; verify both upgrade and from-zero paths. Update the architecture map and drift inventories in the same change.

Installed Next.js documentation was unavailable because `node_modules/next/dist/docs/` was absent during this inspection. Before implementing affected Next.js actions, callbacks, route handlers or UI, install the pinned dependencies and read the relevant installed guides as required by `AGENTS.md`.

## Architectural addendum — implementation adjudication

These decisions resolve implementation boundaries for the existing requirements; they do not replace or relax AC-01 through AC-10 or the live certification gate. Preserve the owners listed above and the Python sidecar's HTTP-only access to the brain.

### Credential transport and connection authority (AC-01, AC-07)

Keep OAuth refresh tokens and client secrets exclusively in the approved encrypted integration-secret store. Provide a dedicated server-side access-token broker, separate from the ordinary integration-selection API. The broker refreshes with Google on the server and returns only a short-lived access token, expiry, the exact granted scopes and non-secret stable account identity. The Python adapter obtains replacement access tokens through this broker; it never receives the refresh token or client secret. Preserve documented local service-account installations.

Provision explicit credential-use authority for a connector principal bound server-side to an immutable integration ID and team ID. A human-readable connection name, caller-supplied team, or ordinary valid team API key does not confer this authority. Authenticate and authorize each broker call against that binding and the current connection state. Use protected transport, non-cacheable responses, bounded issuance and sanitized audit metadata. Access tokens must not enter selection JSON, durable work payloads, logs, manifests or browser-visible diagnostics. Revocation and pause/disconnect prevent further issuance; stale access tokens cannot bypass sink authorization or generation fencing.

Admin-authorized discovery, connection tests and scope previews use the same credential owner and provider policy. Bootstrap runnable OAuth connections without requiring a duplicate local refresh secret. Credential identity must distinguish the OAuth subject from an OAuth client ID and a Drive permission ID; reconnecting the same verified account preserves the content namespace. A Google access token may authorize provider reads beyond the selected documents, so the trusted connector must still enforce selected membership; token issuance is not membership enforcement.

### Execution authority and one coordinator (AC-03, AC-04, AC-07)

Use one coordinator and durable work protocol for manual runs/retries, scheduled polling and validated notification hints. Re-check authoritative connection state before provider work and at sink commit. Pause/disconnect stops new reads and watch renewal and prevents obsolete in-flight work from committing, while retaining progress according to the documented policy.

Maintain an authoritative monotonically increasing generation and lease fence for each immutable connection binding. A selection hash may identify configuration but cannot serve as the generation counter: changing scope A → B → A must not revive A's old workers. The brain must validate the active generation, current lease owner/fence and connection state atomically with every content write, membership change and removal through the ingest owner. Progress, page completion and work acknowledgment must also reject obsolete execution authority. Local SQLite leases alone cannot authorize writes from multiple sidecar processes or independent state files. Extend the existing connector-state boundary and expose its authority through HTTP; do not create a competing content writer or independent generation authority.

### Durable enumeration, membership and drive streams (AC-03, AC-04, AC-05)

Persist traversal queues, folder/page positions, selected membership and bounded document obligations. Separate enumeration from document extraction so one malformed document does not terminate independent work. Materialize each provider page durably with its continuation and obligations before processing it; retain completion evidence until cursor advancement is durable so a replay cannot endlessly recreate completed work. Resume both baseline and changes across run budgets and crashes, including when a run ends exactly at its budget. Only a completed authorized generation snapshot can establish absence.

Maintain distinct opaque-token streams for every selected Shared Drive and My Drive when its content is selected. Capture each required start token before that stream's enumeration, and account for every required stream before reporting the connection current. Re-evaluate selected membership on document and folder changes, including moved subtrees. Empty selections admit no upserts; unrelated changes cannot expand scope. Deduplicate overlapping selections without discarding the provenance needed for later reconciliation.

### Canonical identity, overlapping claims and approved audiences (AC-05, AC-06)

Preserve one canonical item identity for an exact provider document within its verified team/provider namespace, with separate durable per-connection membership and audience claims. A scalar last-writer connection field is not ownership authority. Each claim binds the immutable integration, verified account/drive context, active selection generation and approved existing audience grants. Removing or losing access through one connection retires that claim; it must not purge content still supported by another current authorized claim. If no authorized claim remains, suppress the content and use shared durable cleanup. Where remaining claims permit access, effective visibility must be derived from their explicitly approved provenance through existing enforcement, never from whichever connection wrote last.

Validate audience bindings before content becomes visible and preserve them through context reconciliation and backfill. Unresolved audience state fails closed; default team access or automatic General placement cannot substitute for approval. Legacy identity adoption requires exact, unambiguous retained source-ID evidence. A normalized-path collision with another provider document or non-Drive item must become an explicit migration conflict or use a collision-safe path, never adopt and overwrite the unrelated item.

### Revocation barriers and derived caches (AC-05, AC-06)

Establish durable source suppression and authorization/revocation epochs through the existing visibility and cache owners. A processed revocation must establish this barrier before success is reported. Every affected cached response, including another process's memory cache, must validate current authorization/epoch before returning source text. Cache rebuilds must validate the epoch again when publishing and serving their result, preventing a rebuild started before revocation from restoring obsolete content. Coordinate the revocation barrier with concurrent reads/publications; a local eviction or a one-time epoch check before a long build is insufficient.

Persistent deletion, graph/context cleanup and generated-summary invalidation remain durable retryable obligations. Failed cleanup cannot reopen suppressed content, and a failed rebuild may retain a payload only if its current authorization is still proven. Cache keys and epoch checks must preserve member/audience variants as well as team boundaries.

### Durable attribution repair and correction policy (AC-08, AC-09, AC-10)

Persist bounded, resumable repair obligations when an identity mapping changes, tied to its mapping revision and affected retained source provenance. Require successful complete identity reads before changing credit: a failed read cannot be interpreted as an unlink. At write time, enforce the current mapping revision and manual correction locks; stale workers must not restore an earlier mapping. Resume item, contribution and derived-cache obligations after restart, and mark repair complete only when all required effects are accounted for.

Drive contribution evidence must follow the existing correction policy on both read and repair paths. It cannot bypass an item's deliberate lock by independently resolving source identities. Paginate contribution evidence with stable ordering or expose explicit continuation/incompleteness; arbitrary item caps must not silently drop older valid evidence or produce a cache marked complete.

## Functional requirements and stable IDs

### AC-01 — Connect, select and authorize

Provide the complete Admin flow: OAuth interactive setup, connection test, authenticated account identity, explicit file/folder selection, recursive-folder option, authorized Shared Drive selection and a scope preview. Retain documented service-account installations and existing configuration compatibility.

The configuration model must distinguish an intentionally empty selection from absent configuration, denied discovery and partial discovery. An empty selection must not silently mean “all Drive.” Show recursive behavior and drive boundaries in the preview. Scope changes create a new generation and reconcile the previous selection safely.

Use the least privilege for the selected mode. Individually authorized file access and full selected-folder discovery have different requirements; explain that difference before broader consent. Google documents `drive.file` as per-file access, while broader read scopes permit wider discovery. Do not claim that choosing a folder automatically makes every descendant available under per-file authorization. Record the tested scope set and justify broader access in the setup documentation. [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

Persist OAuth refresh credentials only through the approved credential path, preserve them on unrelated selection saves, and handle refresh failure/revocation with actionable reconnect state. Callback state must be single-use, expire, and bind to the initiating authorized team/admin context. Never trust a callback-supplied team or account association without that binding.

Service-account identity is a transport identity, not evidence of human authorship. Credentials, verification tokens and provider responses containing secrets must not enter selection JSON, identity context, logs, source manifests or browser-visible diagnostics.

### AC-02 — Complete readable Google Docs content

Use a verified reader contract or direct Docs API when the wrapper cannot preserve the required information. Fetch with `includeTabsContent=true`; traverse root and child tabs in document order. Preserve tab IDs/titles/order, headings, paragraphs, lists, tables, links and supported footnotes, with document/tab/block provenance. Google’s tab response moves content into `documentTab`; reading only the legacy root body is insufficient. [Docs tabs](https://developers.google.com/workspace/docs/api/how-tos/tabs)

Store the document’s provider ID, title, source URL, modified time and source-supported author metadata. Preserve non-ASCII text and readable long-table content. Keep external links as references; do not crawl them or import targets outside the selection.

Record unsupported elements and extraction failures explicitly. A limit, missing tab, malformed block, failed subread or truncation must not become “complete.” Do not overwrite a known complete body with a silently partial extraction. Distinguish a fully extracted supported document containing disclosed unsupported elements from an extraction whose required readable content is missing.

### AC-03 — Resumable baseline and incremental changes

Capture a start token before initial enumeration, persist it with the scope generation, enumerate every selected page/folder, durably ingest the baseline, then drain changes from that token. This closes edits/additions occurring during backfill.

Paginate all enumerations and change streams, including Shared Drive and recursive-folder discovery. Track traversal progress and seen membership without relying on a single response or process memory. Deduplicate overlapping selected folders/files.

Treat provider tokens as opaque. Continue with `nextPageToken`; use `newStartPageToken` only at the completed change-stream boundary. Bind tokens to their credential, drive and selection context, and never replace them with application timestamps. [Drive changes](https://developers.google.com/workspace/drive/api/guides/manage-changes)

Commit progress only after durable brain acknowledgment of the page’s required outcomes. Either retain the page cursor until all work completes, or durably record the pending work before advancing; a transient in-memory retry list is not sufficient. Lost responses may cause replay, but replay must not create duplicate active items or manufactured contributions.

Controlled rescan is permitted when cursor recovery requires it. Establish a fresh generation/start token and complete its baseline before using absence as reconciliation evidence. A rescan cannot erase uncertainty by relabeling an incomplete snapshot successful.

### AC-04 — Notifications, polling and bounded recovery

Validate channel ID, resource identity and configured verification token against persisted watch state before scheduling work. Support the notification handshake and empty-body/header-based messages. Invalid callbacks must cause no provider read, content ingestion or cross-connection scheduling.

Persist the returned resource ID and actual expiration separately from consumption cursors. Renew with overlap, accept legitimate overlap notifications idempotently, and retire old channels safely. A renewal failure must not discard the valid old channel or advance/reset consumption progress.

Notifications enqueue idempotent reads; they are hints, never authoritative content or deletion evidence. Periodic polling reconciles missed, duplicated, delayed and out-of-order notifications.

Bound active workers, queue size, provider request duration, per-run work, retry count and exponential backoff with jitter. Honor valid `Retry-After`, including deferring work when a provider delay exceeds the current run budget. Rate limits, 5xx and timeouts must not busy-loop. Authentication errors require refresh/reconnect handling; malformed content is a per-document failure.

Continue independent documents when one fails, but keep the run partial and the failed document durably retryable. Report actual failure categories rather than converting every exhausted retry into a rate-limit diagnosis.

### AC-05 — Stable item identity and lifecycle

Retain source `gdrive`, established item IDs, history and citations. Use exact stable provider IDs with explicit team/connection namespace and documented overlap handling. Renaming or moving a document must not change item identity. Credential refresh and reconnect to the same provider account must not create a new content namespace.

Current path normalization lowercases and sanitizes source IDs; do not use that lossy transformation as a new authoritative provider-ID key. Maintain an explicit compatibility mapping to existing paths/items, detect ambiguous historical collisions, and surface them rather than guessing or overwriting an unrelated item.

Track selected membership, completeness and reconciliation generation. Detect selected-folder moves, trash/delete, access loss and restoration. Re-evaluate folder subtree membership when a folder moves; looking only for individual document-change notifications is insufficient.

A complete authorized snapshot may establish selected-scope absence. A positively identified provider removal/access-denial event may establish document inaccessibility. An incomplete listing, expired credential, timeout or account-wide authentication outage establishes neither deletion nor an empty source.

Remove or suppress inaccessible content and all derived search/context representations. Use shared ingest cleanup and the existing retention policy; replay cleanup until its required effects are durable. Restore content only after current provider access and selected membership are verified.

Reuse the shared completeness work from [AIO-1166](https://linear.app/je4light/issue/AIO-1166). No concrete AIO-1166 implementation was identified in the inspected paths; check that dependency before coding and reuse its contract rather than claiming it already exists or creating an incompatible second definition.

### AC-06 — Access, privacy and revocation

Connector permission to read Google content is not permission for every AIOS member to read it. Configure approved source audiences through existing membership/provenance enforcement, fail closed when permissions cannot be resolved, and preserve team/member boundaries.

A default `access: team` plus automatic placement into broadly visible General is not sufficient for a restricted Drive selection. The selected audience must survive ingestion, context reconciliation and later backfills without an unintended wider grant.

Verify retrieval, direct item access, citations, exports, timeline ledgers, cached and uncached APIs, UI, graph/context derivatives and generated summaries. Identity links and attribution repairs must never add visibility.

After revocation is processed, no previously authorized cache variant may return restricted source text. Existing stale-while-revalidate behavior and best-effort cache busting require explicit handling: prevent stale restricted payloads from being served while derived deletion/invalidation retries. A cache rebuild failure can preserve a prior payload only when that payload remains authorized.

Do not redesign the organization’s permission program. Implement the connector’s audience binding and necessary enforcement integration within its existing owners.

### AC-07 — Administration and operations

Show selected scope and authenticated account, last attempt and last complete success, imported/updated/unchanged/removed/skipped/failed counts, cursor age, backlog and reconnect state. Unknown backlog is unknown, not zero.

Distinguish valid empty selection, access denied, partial run, paused/disconnected state and complete success. Provide Run now, retry, pause and disconnect. These actions must use the same work queue and progress state as scheduled polling; they cannot start competing unsynchronized writers.

Document retained-data and explicit purge behavior. Pause retains progress and stops scheduled ingestion. Disconnect stops reads/renewals and handles credentials according to the documented policy; it must not silently claim retained material is current. Neither action is an implicit destructive purge. A processed source access revocation still invokes AC-05/06 regardless of retention choices.

### AC-08 — Shared person identity

Reuse `member_identities`, `member_emails`, `lib/identity/member-identities.ts`, `lib/identity/provider-sync.ts`, `lib/identity/resolve.ts`, `lib/identity/list.ts` and the existing member identity/context experience. Support multiple Google accounts per canonical person and show the Google login alongside existing Slack/Notion accounts.

Persist provider stable user IDs and available login/email/display-name metadata with a documented namespace. The current identity writer keys on `(team_id, provider, external_id)` without a workspace column; any necessary provider workspace/ID-type namespace must be backward-compatible, collision-safe and shared by writers and readers.

Use the existing `gdrive` attribution convention consistently. Explicitly distinguish an OAuth subject, Drive permission ID and author email. They are not interchangeable identifiers. Bridge account-level identity and document author references only with authorized provider evidence; retain unresolved source references when no verified bridge exists.

Prefer a deliberately linked stable account. Auto-link only an unambiguous provider-supplied email matching a confirmed member address or alias. Do not promote display-name, local-part or handle heuristics to verified Google login evidence. Any shared resolver tightening must preserve intentional mappings and have regression coverage for existing connectors.

Expose linked, unresolved, conflicting, disconnected and deactivated states as appropriate. Provide authorized, audited manual link/unlink/correction with conflict protection, including concurrent updates. Missing email scope, a guest account or an ambiguous name must remain actionable unresolved attribution, never automatic credit to the installer/service account.

### AC-09 — Roles and bounded historical attribution repair

Preserve author, creator, editor/contributor, owner, assignee, organizer, speaker and attendee roles separately wherever source evidence supports them. Google document ownership, uploader identity, access or shared-folder ownership does not prove authorship. A Shared Drive has no implied human author.

Mapping changes must enqueue bounded, durable and resumable repair of affected items and contributions, using current mapping state and retained provider provenance. Respect `member_id_locked` and existing manual correction policy at write time, including corrections occurring during repair.

Linking a previously unknown author must repair existing evidence. Remapping/unlinking must remove stale credit from the old member, subject to deliberate locks; the current “retain an unresolved human” default needs a scoped, evidence-backed repair path. Do not recreate documents, assign all historical versions to the latest editor, or manufacture historical activity.

Invalidate/rebuild affected timeline visibility variants and derived person context/summaries. A repair is not complete merely because the primary `items.member_id` changed. Retain source identities, roles and source timestamps so future corrections do not depend on recovering discarded provenance.

### AC-10 — Source-time contribution ledger and visible Timeline

Trace Google source IDs through normalized items, stored versions/contributions, shared attribution, `lib/dashboard/work-timeline.ts`, grouping, cache, APIs and visible Timeline evidence.

Date work using verified source creation/edit/contribution timestamps, never ingestion, retry, identity-link or version-persistence time. If only the latest editor/time is available, record that evidence and disclose the historical limitation. Do not infer a complete edit history or first-import activity.

Preserve separately observed legitimate contributions across people and days. A later editor must not erase an earlier observed contribution or transfer document ownership. Unchanged syncs and metadata-only reconciliation must not manufacture rows or new work days.

Use the timeline’s existing UTC day policy consistently: normalize source instants to UTC before grouping rather than relying on an arbitrary offset string’s date prefix. Test equivalent offset timestamps, midnight and DST boundaries. A timezone redesign is outside scope.

Each evidence row must show understandable provider label, title, contribution role, source link and correct person/day. Work without a task link remains visible in the existing unlinked/Other area. Summaries are optional and cannot gate evidence visibility.

Missing identity/work time must have explicit diagnostics and a repair path. Required identity, source or ledger reads must fail visibly rather than caching a partial or blank timeline as complete. Exercise pagination and saturation so older valid evidence is not silently lost to an arbitrary cap.

## State transitions and invariants

The following describes required semantics, not a requirement to add duplicate status columns.

| State or transition | Required invariant |
|---|---|
| Unconfigured → connected | Authorized credentials tested; account identity and selected scope recorded |
| Connected → baselining | Namespaced generation and pre-enumeration start token durable before listing |
| Baselining → catching up | All selected listing pages completed; required baseline outcomes acknowledged |
| Catching up → current | Changes drained; durable obligations accounted for; terminal token committed |
| Any run → partial/retry | Failures retained with provenance; no false last-success update or absence purge |
| Credential failure → reconnect required | No cursor reset or mass deletion; actionable account error |
| Scope change → new generation | Old worker results fenced; complete reconciliation required for absence decisions |
| Watch active → overlapping → retired | Channel identity/expiry persisted; consumption cursor unchanged |
| Current → paused/disconnected | Reads stop; documented retention and credential policy applies |
| Identity mutation → repairing → repaired | Current mapping and correction locks enforced; all affected derived surfaces refreshed |

Each run and callback must carry enough identity to resolve the same team, connection, credential identity and drive/scope generation. Human-readable connection names are not unique authority.

Only one consuming worker may commit a cursor for a given stream at a time. Use durable serialization or fencing, not only scheduler `max_instances=1`; webhooks, manual runs and multiple processes can overlap. Scope changes, reconnects, lease expiry and restarts must prevent stale workers from committing obsolete content/progress.

Keep content persistence, visibility safety and downstream searchability distinct. An acknowledged document must not be lost after restart; acknowledgment does not claim that every asynchronous search/graph step has completed. Record those timestamps independently.

## Acceptance criteria

- [ ] AC-01: An authorized administrator can connect with OAuth or the documented service-account mode, preview and select scope, and reconnect without exposing credentials or broadening the selection.
- [ ] AC-02: All required readable content and provenance are preserved across root/child tabs, with unsupported or incomplete extraction explicitly reported.
- [ ] AC-03: Paginated baseline and incremental ingestion close the backfill race, persist namespaced opaque tokens and replay without losing acknowledged work.
- [ ] AC-04: Validated notifications and periodic polling recover through expiry, outages and restart with bounded concurrency/retries and durable partial failures.
- [ ] AC-05: Existing item identities survive rename, move and reconnect; verified removals reconcile content and derivatives without deletion from incomplete snapshots.
- [ ] AC-06: Approved audiences remain enforced across direct, retrieved and derived surfaces; processed revocations cannot leak through stale caches.
- [ ] AC-07: Admin status and controls distinguish empty, denied, partial, complete, paused and disconnected outcomes with accurate counts and documented retention/purge behavior.
- [ ] AC-08: Google accounts resolve through the shared identity registry with verified linking, multiple accounts, explicit unresolved states and audited conflict protection.
- [ ] AC-09: Source-supported roles remain distinct; bounded resumable mapping repair respects locks and removes stale credit from affected stored and derived evidence.
- [ ] AC-10: Visible Timeline evidence preserves correct person, source time/day, role and link across contributors and edits without fabricated history, duplicate activity or silent incomplete reads.

Each criterion includes its full corresponding requirement section above. Automated evidence and the separate live sandbox certification below are both required for release acceptance.

## Acceptance matrix

Automated tests derive assertions from these requirements, including failures of the current baseline. In-memory database substitutes can check orchestration, but cannot prove persistence, uniqueness, authorization or migrations.

| IDs | Automated implementation acceptance | Live certification |
|---|---|---|
| AC-01, AC-07 | Admin/API authorization, strict selection schema, secret exclusion, OAuth state/refresh/revocation, service-account compatibility, empty/denied/partial states and actions | Actual OAuth and documented service-account setup; account/scope preview and reconnect |
| AC-02 | All root/child tabs, headings/lists/tables/links/footnotes, non-ASCII, malformed/unsupported content, limits and extraction completeness | Independent manifest text matches multi-tab and long-table fixtures |
| AC-03, AC-04 | Multi-page baseline/change stream, during-backfill edit, opaque tokens, invalid callbacks, overlap/expiry, duplicates/out-of-order notifications, missed notifications and restart | Provider edits observed through polling/watch; forced renewal and restart |
| AC-04, AC-05 | 429/5xx/timeouts, Retry-After, bounded queue/concurrency, sink failure after partial persistence, replay, scope fencing and no partial-snapshot deletion | Outage/recovery and reconciled IDs/counts |
| AC-05, AC-06 | Real-Postgres lifecycle, stable IDs, moves/trash/delete/restore, overlap, permission loss, audience enforcement and derived-cache cleanup | Revocation disappears from authorized/unauthorized read surfaces as applicable |
| AC-08, AC-09 | Multiple accounts, similar names, aliases, unknown/guest, absent email, manual conflict, cross-team/workspace identity, concurrent correction and resumable link/remap/unlink repair | Google login beside existing identities; before/after mapping and timeline proof |
| AC-10 | Separate creator/editor/owner evidence, no service-account credit, unchanged replay, multiple days, UTC/DST, pagination/saturation, ledger/identity-read failure and cache variants | A creates, B contributes, C ingests; correct person/day/role/link in visible Timeline |
| All | Existing connector regressions, schema upgrade/from-zero, guards, architecture drift, HTTP contracts and UI assertions | Complete evidence bundle and 24-hour sandbox soak |

Use the Python adapter, API-conformance, normalization, work-time, engine, scheduler and selection suites for connector mechanics. Extend TypeScript integration-config, identity, attribution, timeline and source-rule tests. Prove durable outcomes in real-Postgres data-mechanics tests, authenticated boundaries over the real HTTP tier and changed graph isolation/cleanup in its appropriate tier. Existing reader-signature tests do not certify provider behavior.

The architectural addendum requires these additional explicit assertions within the matrix above:

| IDs | Required boundary and failure scenarios |
|---|---|
| AC-01, AC-07 | Real HTTP token brokerage, remote OAuth connection bootstrap, refresh/revocation, unchanged secret on selection save; reject ordinary/external keys, wrong integration/team and revoked connector principals; verify selections and diagnostics never contain tokens or refresh secrets |
| AC-03, AC-04, AC-07 | Separate sidecar processes/state files, lease replacement and stale sink/progress commits; A → B → A generations; manual/scheduled/notification convergence; pause/disconnect after scheduler startup and during a run, including watch renewal |
| AC-03, AC-04, AC-05 | Three baseline documents with budget two, exact-budget boundary, multi-page changes with restart after acknowledgment but before cursor commit; two Shared Drives plus My Drive; empty scope, unrelated edits and folder subtree moves |
| AC-05, AC-06 | Both ingestion orders for overlapping connections with different approved audiences, retirement of either claim, last-claim removal, same-account reconnect; case/sanitization and non-Drive legacy-path collisions; context reconciliation/backfill cannot widen grants |
| AC-05, AC-06 | Real multi-process memory and persistent cache reads; a rebuild blocked across revocation cannot publish or serve obsolete text; delayed/failed derived cleanup remains suppressed across audience variants |
| AC-08, AC-09, AC-10 | Failed identity reads preserve credit; restart mid-repair, newer remapping during repair and concurrent correction locks; Drive evidence honors corrections; saturation beyond ITEM_LIMIT, timestamp ties and other sources displacing older Drive evidence |

## Live sandbox certification gate

Prepare an independent source manifest for at least **25 Google documents**, including a nested folder, multi-tab document, long table, non-ASCII content and an authorized Shared Drive. Record expected IDs, selection membership and readable fixture text separately from connector output. Excluded documents must never appear.

Exercise second-tab edits, rename/move, content added during backfill, trash/delete/restore, access revocation, scope changes and reconnect. Verify final stored text and a Team Brain query with the correct citation; verify disappearance from unauthorized retrieval after revocation is processed.

Use two AIOS tenants/team boundaries and two differently authorized members, plus two relevant provider workspaces. Demonstrate one person with multiple Google accounts, similar names belonging to different people, an alias/email change, unknown/guest author, missing-email permission and a conflicting manual mapping.

Create as A, contribute as B, ingest as service account C. Verify source-supported roles separately, no credit to C, legitimate source-time days, unchanged re-sync and a later contribution. Link an unknown author, remap/unlink, complete historical repair and confirm stale credit disappears from cached/uncached API, UI and regenerated summaries without widening visibility.

Run a **24-hour sandbox soak** with controlled edits and at least one forced renewal and restart. Record source-edit, provider-observed, persisted and searchable timestamps, API calls and failures. The proposed acceptance target remains routine ingestion within **two configured poll intervals after provider visibility**. Measure searchability separately against the existing pipeline budget; this ticket creates no new search-latency SLO.

Attach sanitized manifest, identity mappings, source→item→member→timeline trace IDs, actual run IDs, tested commit, configuration/API versions, count reconciliation, sample citations, UI screenshots/assertions, latency observations, recovery evidence and exact commands/results to AIO-1167. Missing credentials or missing live evidence leaves certification blocked. Mocks cannot close this gate.

## Delivery, migration and rollback

Preserve the ticket’s sequence:

1. Reproduce baseline gaps and record existing configurations, item IDs, attribution and completeness assumptions.
2. Implement configuration/auth migration, the bound access-token broker, execution authority and explicit scope/audience preview. Establish canonical identity, per-connection claims and revocation barriers before enabling upgraded writes.
3. Implement complete content extraction, durable multi-drive baseline/change materialization and watch/poll recovery through the single coordinator, enforcing fencing at sink and progress commits.
4. Integrate access/removal and derived-cache enforcement, durable bounded shared identity repair and correction-aware, paginated source-time Timeline evidence.
5. Complete automated regression and observable persistence/access tests.
6. Complete live certification and its evidence bundle.
7. Roll out opt-in behind a feature flag, beginning with one connection.

Use the repository’s requested implementation/review workflow, including Fable specification and code review. Anthropic coding access must be subscription-authenticated; API-key billing is prohibited.

Migrate existing `folder_id`/`file_ids`, documented service-account configuration and established `gdrive` item mappings without duplication. A legacy timestamp cursor is not a valid Drive page token: migrate it as requiring controlled baseline, preserving existing content identities. Preserve old state for diagnosis until compatibility is verified.

Canary by comparing expected/legacy IDs and counts without allowing both paths to write. Record which runner owns each connection. Test migration interruption, mixed saved-state versions, reconnect and rollback before enabling additional connections.

Rollback disables the upgraded runner and preserves identities, cursors, generations and pending work. An old reader must not consume opaque tokens as timestamps, discard restriction state or republish suppressed content. If the legacy path cannot preserve the new access/identity guarantees, pause that connection with retained state until a compatible build is available; do not force an unsafe fallback. Avoid destructive schema rollback and duplicate active writers.

The release is complete only when automated implementation acceptance and live sandbox certification are both evidenced. Report them separately throughout delivery.
