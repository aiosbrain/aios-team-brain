import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSchema } from "../../scripts/pg-load-schema.mjs";
import type { TransactionSession } from "@/lib/db/types";
import {
  acceptSlackChannelPage,
  beginSlackChannelMetadata,
  claimSlackChannelPage,
  delaySlackChannel,
  dueSlackChannels,
  ensureSlackChannel,
  recordSlackChannelPublicState,
  releaseSlackChannelForRetry,
  restartSlackChannelScan,
  type SlackChannelClaim,
  type SlackChannelScope,
} from "@/lib/ingest/slack-channel-state";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { db, seedTeam } from "./helpers";
import { requireIsolatedTestUrl } from "./slack-history-isolated-url";
import { agePublicProof, closeRawSql, elapse, expireChannelLease } from "./slack-source-helpers";

/**
 * AIO-1170 AM-F2 — RED-FIRST RUNTIME PACKET 1: STATE-WRITER HISTORY ADMISSION
 * (accepted consolidated contract `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`,
 * §3.1–§3.3, §4, §5, §6; PARTIAL coverage of F2-01/04/05/06/09/10/11). DH IDs are named only as
 * §10.1 derives them from those F2 rows: F2-01 → DH-06/08, F2-04 → DH-02/06/13, F2-05 → DH-02,
 * F2-06 → DH-02/07/12/13, F2-09 → DH-03/12/13, F2-10 → DH-08/09/12, F2-11 → DH-07/08. No DH row is
 * covered in full here.
 *
 * ONE SEAM: `acceptSlackChannelPage`, called directly, as the SQL authority over the HISTORICAL
 * lane's SQL-local cursor history H. It runs on the real data-mechanics PostgreSQL, with the
 * installed history and progress CHECKs, through the real claim and release writers. Every channel
 * row is a literal fixture with valid FKs:
 *  - both lanes are initialized;
 *  - the newest lane is a coherent, distinct tuple: B = the historical anchor, L = S < B < U = A;
 *  - the historical segment WIDTH is explicit. A WIDE segment has S = L = 0 < U = A; a SINGLETON
 *    segment has S = U = A. Each seed helper asserts its width in SQL.
 *
 * WIDTH DECIDES CAPACITY AND UNREPRESENTABLE BEHAVIOR (§5). With S < U, an over-cap or lone-surrogate
 * continuation is `subdivided`. That is a later packet, so every TRUE-REJECTION case for those
 * three categories uses a SINGLETON segment, where the contract outcome is `rejected` with the
 * original category and a release-only row change. Repetition is width-independent and never
 * subdivides, so its cases use a WIDE segment.
 *
 * WHY TODAY'S WRITER IS RED, by behavior rather than by a missing export: it moves the lane cursor
 * but never touches H, so a partial or terminal acceptance violates the installed CHECKs inside
 * PostgreSQL (23514). It also sends the raw cursor as a SQL parameter before its fence, and its
 * UPDATE fences neither the binding integration, the public proof nor the segment bounds. Every
 * outcome is captured as a SANITIZED projection:
 *  - `{ outcome, category }` for a typed result;
 *  - `{ threw: true, code, name }` for an exception.
 * An intended RED is therefore always an assertion mismatch on a projection, a row fact or a
 * recorder boolean. It is never an escaped constraint error, a missing export, ENOENT, a parse
 * failure or a fixture error. No assertion expects a raw SQL error as an application outcome.
 *
 * LEDGER. Each test's label carries its contract ID. "Today" is the implementation at this file's
 * base checkpoint.
 *
 * NO-LEAK RULE: every returned acceptance outcome (written, rejected, refused, subdivided) and every
 * release outcome is checked for an unrepresentable cursor, a history key and the older H entry. A
 * leak becomes an extra `leaked: true` field that no expectation contains.
 *
 * RED today (31). Each fails on its behavioral `expect`.
 *  - §5 row 1, ordinary continuation (1). Appends the exact cursor as H's last element and records
 *    attempt-oldest. Turn passed, lease cleared, last_read_at set, last_error_code null; the newest
 *    lane is exact. Today: 23514.
 *  - F2-01 (partial) / F2-06, repetition (2), wide segment:
 *     - `rejected/cursor_repeated` plus the same-transaction release, which is the only change;
 *     - repetition at the entry cap, which is repetition and not overflow (F2-04).
 *    Today: 23514.
 *  - F2-04/F2-05 singleton overflow (3): entries; bytes only; both caps resolving to entries. Each
 *    is SQL-sized, and the release is the only change. Today: 23514.
 *  - F2-05 byte boundary (3), singleton, SQL-asserted candidate bytes:
 *     - 1,048,575 is written;
 *     - 1,048,576 is written;
 *     - 1,048,577 is `rejected/cursor_history_bytes_exceeded`.
 *    Today: 23514.
 *  - F2-04 entry boundary (1): 999 → 1,000 entries is written, singleton. Today: 23514.
 *  - §5 final terminal (S = L) / §6 / F2-04/F2-05 terminal at either cap (2). This is real envelope
 *    completion from a seeded prior attempt-oldest OLDER than the page oldest and a non-null
 *    diagnostic:
 *     - historical A, S, U, attempt-oldest and aggregate are null; C and H are cleared;
 *     - G = 5; floor true;
 *     - completed bounds are [prior attempt-oldest, A] and provisional is null;
 *     - turn passed, lease cleared, last_read_at set, last_error_code cleared;
 *     - the newest lane is exact, and a whole-row digest proves nothing outside the terminal fields
 *       moved.
 *    Today: 23514.
 *  - F2-09 (partial: direct writer only) lone surrogates, singleton (4): the primary embedded lone
 *    HIGH, then lone LOW, trailing HIGH and isolated leading LOW. Each must be
 *    `rejected/cursor_unrepresentable`, with the release as the only change and no unrepresentable
 *    cursor reaching any SQL statement. Today the raw cursor is a SQL parameter, then 23514.
 *  - F2-09 (partial) unrepresentable PRECEDENCE, singleton (3). A lone HIGH must stay
 *    `cursor_unrepresentable` in each case, with no SQL exposure, the release as the only change and
 *    the stored size unchanged:
 *     - at the entry cap (not entries_exceeded);
 *     - at both caps (not entries_exceeded);
 *     - against a stored literal-U+FFFD spelling of the same text (not cursor_repeated).
 *    Today the raw cursor is a SQL parameter, then 23514.
 *  - F2-09 positive controls (2): a surrogate pair and a literal U+FFFD are appended exactly. Today:
 *    23514.
 *  - F2-11/DH-08 (partial) channel-fence matrix (4 of 9): binding integration changed, public proof
 *    revoked, segment upper moved, segment lower moved. Each must be `refused` with the row exact.
 *    Today the UPDATE does not fence these predicates, and the unfenced write then fails with 23514.
 *  - F2-11/DH-08 + F2-09 authority before early classification (5 of 6):
 *     - a lone surrogate under an expired lease, a revoked public proof or a moved segment must be
 *       `refused`, with the row exact and NO unrepresentable cursor in SQL. Today the cursor is a
 *       parameter, and for public/segment the unfenced write also fails with 23514;
 *     - an entry overflow under a revoked public proof or a moved segment must be `refused` with the
 *       row exact. Today: 23514.
 *  - §3.1 / F2-10 (partial), written-state boundary (1): an accepted `written` state carries no
 *    history key and no older entry. Today: 23514.
 *
 * GREEN today (9), passing controls:
 *  - F2-09 recorder calibration: SQL text, nested parameters and the query-builder surface are seen;
 *    pure surrogate variants are classified; the pg prototype is restored;
 *  - the channel-fence matrix (5 of 9), each already fenced by today's UPDATE: lease expired,
 *    binding revision changed, scan generation drift, cursor drift, successor reclaim after expiry;
 *  - entry overflow under an expired lease (1 of 6);
 *  - §3.1 claim/ensured/due/release projection boundary;
 *  - §3.1 `STATE_COLUMNS` source boundary.
 *
 * PACKET 2 — CLAIM-TIME SEGMENT INITIALIZATION, HISTORICAL LANE ONLY (7 tests, appended at the end of
 * the describe; §4, §5). Each test calls `claimSlackChannelPage` directly on a literal row. "Today"
 * for this packet is the GREEN1 production source (`06528f96`, unchanged through the test-only
 * checkpoint `596ce153`), where all 40 packet-1 tests are GREEN. The file therefore totals 47: 5 RED,
 * 42 GREEN.
 *  - RED today (5), because today's claim freezes A but initializes no segment:
 *     - the first claim anchors a canonical A and initializes S = L = 0, U = A, C = null, H = [], with
 *       attempt-oldest null. It carries those bounds, G unchanged, historical lowerTs null and a null
 *       cursor. A comes from the DB clock, so it is checked as canonical and equal to U, never against
 *       a JS clock;
 *     - a NEW anchor from a noncanonical completed_lower_ts is stored canonically, with U = A;
 *     - an already-anchored uninitialized lane keeps its anchor bytes, with U = canonical(A);
 *     - a historical claim preserves an ANCHORED-but-uninitialized newest lane: its A and B bytes
 *       stay exact, its L, S, U and cursor stay null, and its history stays empty;
 *     - a reclaim after expiry resumes a real PROGRESSED literal segment without reinitializing it.
 *       That segment has A = `1718900400.5`, U < A, S in [0, U], an aggregate in (U, A],
 *       attempt-oldest in [S, U], a stored cursor and history, and G + 1. The reclaim asserts the
 *       literal S, U and G. It is sanitized, so a wrong U reset that trips the progress CHECK is a
 *       mismatch rather than a raw error. Today it fails at the first, initialization assertion.
 *    Each also proves, by a digest of every column outside the claim-permitted set (lease bookkeeping
 *    only, for the reclaim), that the newest lane and all unrelated state are byte-identical.
 *  - GREEN today (2), controls: an existing narrower segment is preserved by its claim; an ineligible
 *    (private) row is neither claimed nor initialized.
 *  This packet refines the principal observed cause of the 32 broad related-suite failures at
 *  `06528f96`: a continuation reaching an uninitialized segment. It does NOT by itself restore them,
 *  because most of them run through discovery and the newest lane.
 *  Post-GREEN controlled-mutant evidence for this packet remains PENDING:
 *   - reinitialize on reclaim;
 *   - U from A on reclaim;
 *   - raw completed_lower_ts as A;
 *   - initialize the opposite lane;
 *   - initialize an ineligible row.
 *
 * PACKET 3 — CLAIM-TIME SEGMENT INITIALIZATION, NEWEST LANE (11 tests, appended after packet 2; §4,
 * §5). Each test calls `claimSlackChannelPage` directly with a configured `skewAllowanceMs`, the
 * claim's validated option (default 60,000 ms). Expected L always comes from the test's own BigInt
 * oracle (`boundMinusAllowance`), never from product code. The delay is read from `unknown`; the
 * claim's declared result is the union `SlackChannelClaim | SlackChannelClaimDelay | null`.
 * STATUS: RED3 (6 RED, 52 GREEN, 58 total) against GREEN2 production `a2dc9167`, at test checkpoint
 * `33ea6693`. GREEN3 is the claim writer's newest initialization plus its claim-local L > A delay:
 * all 58 are expected GREEN.
 *  - formerly RED (6), the GREEN3 behaviors:
 *     - ×2: the first newest claim freezes B by the existing rule (the certified top) and sets
 *       L = S = max(0, B − allowance) and U = A, with cursor null, history empty and G unchanged.
 *       One allowance is 90 s; the other is larger than the epoch and clamps to `0.000000`. Each
 *       checks a whole-row digest outside the newest claim set;
 *     - an anchored-but-uninitialized newest lane keeps its A and B bytes, U = canonical(A), and an
 *       in-progress historical lane (segment, cursor, G 3) is byte-identical;
 *     - a reclaim under a DIFFERENT allowance resumes a valid cursor-null post-progress literal
 *       (S > L, G + 1). It asserts literal A, B, L, S, U and G plus a lease-only digest; exceptions
 *       are sanitized. At RED3 it failed at its first, initialization assertion;
 *     - ×2: candidate L > A, for an already-anchored lane whose B lies above A + allowance and for
 *       an idle lane under a far-future certified top. Each returns `delayed / scan_bounds_invalid`
 *       with the exact fixed detail. Only next_lane (to historical), the diagnostic, due_at and
 *       updated_at change. due_at and updated_at must each lie inside a database-clock window taken
 *       immediately around the claim (SQL booleans). No lease is taken, and no attempt, generation,
 *       anchor, progress or certificate moves (an idle lane's anchor stays null).
 *  - GREEN at RED3 and still GREEN (5), controls:
 *     - an ineligible (private) row with an anchored newest lane is neither claimed nor initialized;
 *     - ×4: ELIGIBILITY precedes the L > A evaluation. The same CHECK-valid L > A anchored
 *       candidate is made ineligible after seeding, in four independent ways: a private row, a
 *       future due_at, a live competing lease (owner, expiry and claimed lane together), or a stale
 *       binding revision. Each must return null with the whole row byte-identical, and no delay
 *       bookkeeping is written.
 *  Post-GREEN controlled-mutant evidence for this packet is PENDING:
 *   - L from the request-time allowance on resume;
 *   - U = A raw;
 *   - initialize the historical lane;
 *   - take the lease on L > A.
 *
 * PACKET 4a — DIRECT CLAIM SAFETY (10 tests, appended after packet 3; review-required). Expected
 * GREEN against GREEN3 `9ee7dbd7`; they are controls that pin GREEN3's validation, not REDs:
 *  - an omitted `skewAllowanceMs` is exactly 60,000 ms (independent BigInt oracle; initialized L/S/U);
 *  - ×6: zero, negative, fractional, unsafe, NaN and infinite allowances. Each fails with the fixed
 *    static validation error. The evidence is that the claim transaction rolls back and NO mutation is
 *    committed (the row is byte-identical afterwards); it does not prove that no statement ran;
 *  - ×3: schema-permitted out-of-domain stored bounds: an idle B, an anchored B, and an anchored A.
 *    Each fails closed with the fixed bound-free `SlackChannelStateError`; the error contains no
 *    bound bytes and the row is byte-identical.
 * File total after packet 4a: 68 (expected 68/68 GREEN on GREEN3).
 *
 * GREEN3 ALSO CHANGES DISCOVERY MINIMALLY, without new tests here:
 *  - it passes its validated allowance to the claim;
 *  - on the typed delay it records one static `delayed / scan_bounds_invalid` history step for that
 *    channel, sends and reserves nothing, and continues its selected-channel loop.
 *
 * THE DISCOVERY-CALLER RED PACKET, in the discovery, fences and bootstrap suites.
 *  TEST COVERAGE NOW PRESENT:
 *   - request bounds: 5 behavioral REDs. Every page sends the claim's exact S/U as `oldest`/`latest`,
 *     never A once U differs, with PA-3 inclusive flags, including the literal newest U < A and
 *     historical 0 < S ≤ U < A cases;
 *   - the end-to-end L > A step (DH-09): GREEN controls. No HTTP and no reservation; the bounded
 *     candidate scan continues past the default-50 boundary;
 *   - `page_outside_segment` (DH-13): 3 behavioral REDs and 3 precedence/edge controls;
 *   - the §9.1/§9.2 fixture corrections: FX-01–FX-13, the bootstrap progress inventory with its
 *     own-property and oracle checks, and the §9 census seed at `95c2e041`.
 *  CALLER TRANSACTION SEMANTICS, discovery suite packet 5 (11 behavioral REDs and 3 GREEN controls),
 *  plus 1 pure-validator RED in `test/slack-source-discovery.test.ts` (repeat + out-of-range/malformed
 *  precedence; the §9.1 standalone `cursor_repeated` assertion is preserved):
 *   - repetition, durable and immediate: `delayed / cursor_repeated`, released in the same pass,
 *     with identical detail and row effects;
 *   - structural precedence over repetition: out-of-segment and malformed timestamps;
 *   - authority beats repetition: a stale lease, a stale selection, or both (selection first);
 *   - a lease that expires after the writer's real rejection but before the caller's release is
 *     refused, not released;
 *   - wide subdivision: the writer's transition, with no caller release;
 *   - singleton unsplittable rejection;
 *   - acceptance BEFORE root enqueue, proved by a test-only insert trigger;
 *   - the single rollback boundary;
 *   - a stale structural release under a successor (successor row exact);
 *   - the exact static details for each.
 *  Production GREEN for these REDs is still pending.
 *  (Packet 5 is GREEN since `f556163d`.)
 *  ACTUAL PROVIDER `invalid_cursor` (§5, DH-03/DH-05/DH-07/DH-13, F2-08/F2-11), RED against `f556163d`:
 *   - this file, packet 6a (15 tests: 6 REDs and 9 GREEN controls). The SAME `restartSlackChannelScan`
 *     export, with its result leak-checked through `project` against a LIVE older H entry, must
 *     return:
 *      - `subdivided` on a constructed progressed wide segment (S 1718900100, U 1718900300 < A,
 *        aggregate 1718900350, attempt-oldest 1718900200): S' = 1718900200.000001 by the test's own
 *        oracle, U kept, aggregate byte-identical, attempt-oldest cleared (RED);
 *      - `restarted` on a constructed progressed singleton (S = U = 1718900300 < A) (RED);
 *      - typed `refused`, with the live row exact, across the complete one-predicate fence, 13 rows:
 *         - segment S moved, segment U moved, public revoked and binding integration changed: RED,
 *           because today's restart fence omits them;
 *         - binding revision, lease expiry, successor reclaim, lease generation alone, lease owner
 *           alone, claimed lane, scan generation, cursor and anchor drift: GREEN controls;
 *   - the discovery suite, packet 6 (8 REDs and 1 GREEN control):
 *      - wide midpoint subdivision, for a constructed progressed C ≠ null and for C = null, with the
 *        subdivision detail;
 *      - singleton same-range restart, for a constructed progressed C ≠ null and for C = null, with
 *        the singleton detail, still pending and with no local retry;
 *      - for the wide, singleton and 6.5 cases, proof that selection authority and the transition (or
 *        its refusing fence) ran on ONE transaction session;
 *      - stale selection, stale lease and both, each refused before any transition (selection first);
 *      - a lease expiring after the selection lock inside the invalid_cursor transaction (6.5);
 *      - control 6.4: the writer's own `refused` from the acceptance transaction, injected after the
 *        caller's channel lock.
 *   NOT pinned by packet 6:
 *      - the restart writer's own locked stored-state validity;
 *      - an expiry between the restart writer's own locking read and its UPDATE;
 *      - the NEWEST lane's invalid_cursor transitions.
 * PACKET 7 — §3.4 / F2-10 (partial) MAXIMUM-HISTORY COMPATIBILITY WRITERS (13 tests, expected GREEN on
 * current source). Each runs on a FRESH row whose two lane histories are both at their exact maximum
 * shape: 1,000 entries and 1,048,576 bytes, distinct per lane and linked to their cursors.
 * The row also carries legal, discriminating non-null facts, so preservation is proved against
 * clearing:
 *  - a provisional newest catch-up top, which is the newest lane's B;
 *  - `last_read_at` and a prior `last_error_code`;
 *  - a historical attempt-oldest inside [S, U];
 *  - a completed-segments aggregate in (U, A], on the final segment [0, U] with U < A.
 * The fixture is proved by SQL before each action. A digest of every column outside the writer's
 * existing allowed set then proves both histories, and all unrelated progress and certification,
 * byte-identical; the allowed effects are SQL booleans and counts. Every returned value must carry no
 * history key and no non-current entry of either history.
 *  - claimSlackChannelPage;
 *  - releaseSlackChannelForRetry;
 *  - beginSlackChannelMetadata;
 *  - recordSlackChannelPublicState (private, under a live claim);
 *  - delaySlackChannel;
 *  - integration delete (ON DELETE SET NULL plus its binding-clear trigger);
 *  - opposite-lane acceptSlackChannelPage (a historical terminal);
 *  - opposite-lane restartSlackChannelScan (invalid_cursor, typed `subdivided`);
 *  - the fenced rejection/release path;
 *  - the unchanged test-only elapse, expireChannelLease and agePublicProof;
 *  - ensureSlackChannel's insert-on-conflict-do-nothing, which neither updates nor rechecks the row
 *    (its `xmin` row version is unchanged).
 * Not claimed by packet 7: the rest of F2-10 (the 200-channel bulk projection and long-cycle
 * detection) and any DH row beyond these writers.
 * Also still deferred:
 *  - two-session claim/accept races;
 *  - the controlled mutants;
 *  - MR-06.
 * PACKET 8 — PERMANENT DISCRIMINATORS FOR THE 11 CONTROLLED-MUTATION GUARDS the runtime campaign
 * recorded UNAVAILABLE (9 tests). They use constructed, CHECK-valid literals written directly, not
 * provider-traversal evidence, and are expected GREEN on current source. Each guard's KILL is PENDING
 * coordinator execution of these tests and a labeled controlled mutation rerun; nothing here claims it:
 *  - 8a, after packet 6a: a historical INNER terminal (S > L) stores the exact adjacent doubled next
 *    segment, merges the aggregate, keeps the anchor and certifies nothing; the written outcome's
 *    `completion` is kept in the projection (P2b, P4c, P4d, S1a);
 *  - 8b: exact bigint midpoints just below the maximum epoch, for the capacity subdivision (P3c, and
 *    the aggregate's preservation, S3a) and for the restart writer (P3d);
 *  - 8c: repetition of the OLDEST entry H[0] at the entry cap is cursor_repeated (A3);
 *  - 8d: the NEWEST lane's frozen L and logical B as fence values, each for acceptance and for the
 *    restart writer (FN13, FN14);
 *  - 8e, beside packet 3's eligibility matrix: a binding moved to a second valid integration at the
 *    same revision makes the old integration's claim of an L > A candidate null (FN16).
 *  Not claimed by packet 8: the newest lane's inner terminal and terminal rules, full segment
 *  application across a provider traversal, MR-06, and any final acceptance.
 * PACKET 9 — the deferred DH/F2 finite packet's two DIRECT state-writer cases (DH-PKT-02-H and
 * DH-PKT-02-N; DH-02, DH-05, F2-05, F2-06), appended after packet 8d. Expected GREEN evidence at the
 * unchanged checkpoint, not a demonstrated defect. A WIDE continuation over the SQL BYTE cap (341
 * stored entries, 1,049,256 SQL-counted candidate bytes) is the typed bytes subdivision at the exact
 * midpoint on each lane; the newest case then runs two inner terminals and its final terminal to
 * PROVISIONAL coverage between ordinary historical continuation turns. Constructed literals; no queue
 * claim (the discovery suite's deferred-DH packet carries the application and queue evidence).
 *
 * PRIVACY: cursors and histories are synthetic. They are compared only by SQL equality (booleans),
 * row md5 digests or SQL-computed counts and byte lengths. Errors are projected to SQLSTATE/name.
 * The unrepresentable-cursor recorder intercepts `pg.Client.prototype.query` for exactly one
 * transaction and restores it in `finally`. It scans SQL text and every argument recursively by
 * UTF-16 code unit and by a synthetic marker, and stores only a boolean and a statement count. It
 * never stringifies, copies or prints a value.
 *
 * ISOLATION AND SCHEMA: runs on the data-mechanics tier database, truncated per test by
 * `setup.ts`. In `beforeAll`, in this order:
 *  1. the shared `DATABASE_TEST_URL` guard (`./slack-history-isolated-url.ts`) refuses anything but
 *     the isolated local runner or CI's service;
 *  2. `slack_sync_channels` is emptied (nothing references it), so leftover rows cannot affect the
 *     upgrade;
 *  3. the REAL deploy loader (`scripts/pg-load-schema.mjs`: schema.sql, whose marked block is the
 *     owned upgrade, then every migration) brings that GUARDED database to the current F2/DH
 *     shape. This is the `slack-method-budget` pattern. The tier container may predate the new
 *     columns, so seeding without this hit 42703. It is an idempotent replay.
 *
 * DEFERRED, NOT covered here:
 *  - the NEWEST lane as the claimed lane: its segment fences (its B and L fences are packet 8d; its
 *    inner and final terminal transitions are packet 9 and the discovery suite's deferred-DH packet);
 *  - durable cycles A→A, A→B→A and A→B→C→D→B across separate connections and invocations, on both
 *    interleaved lanes, with a new-root canary (F2-01 remainder, DH-06);
 *  - F2-02 (same cursor valid in another lane, channel, workspace, team, segment or generation;
 *    binder takeover);
 *  - F2-03 (cursor grammar, length and round-trip edges, and malformed direct arrays);
 *  - F2-07 (lane-local pending across later events) and F2-08 (real recovery and turn handling);
 *  - DH-07 (crash, receipt loss and rollback);
 *  - PostgreSQL-vs-JavaScript serialization difference evidence (F2-05 remainder);
 *  - repetition at the BYTE cap (repetition is covered here only at the entry cap);
 *  - stored-state fail-closed validation of a malformed or inconsistent persisted H;
 *  - true two-session races; an expiry between the restart writer's own locking read and its UPDATE.
 *    Stale-release successor protection and the acceptance-path expiries are covered in the discovery
 *    suite's packets 5–6;
 *  - for the ACCEPTANCE writer, the fence predicates claimed_lane, lease_generation alone and anchor
 *    drift. The restart writer's complete one-predicate matrix is packet 6a; the caller's selection
 *    authority and `lockSlackChannelForAcceptance` are exercised in the discovery suite;
 *  - NO LONGER DEFERRED (pointer only): the newest lane's S > L inner terminal and its acceptance
 *    subdivisions, WIDE byte-cap and lone-surrogate subdivisions, actual-transport surrogate and
 *    invalid_cursor convergence on both lanes with URL round trips, DH-10's PA-3 margin through
 *    subdivision, and segment application across real bound-aware provider traversals
 *    (DH-01/02/03/04/05) are packet 9 here and the discovery suite's deferred-DH packet. The
 *    historical inner terminal and the exact high-epoch subdivisions are packet 8. Claim-time
 *    initialization is covered by packet 2 (historical) and packet 3 (newest, including the L > A
 *    typed delay);
 *  - OUTSIDE THIS FILE, covered by the caller packet in other suites (still RED where production is
 *    pending):
 *     - the discovery/caller side of initialization and request bounds (S/U `oldest`/`latest`);
 *     - discovery's structural validation order before `page_outside_segment`, with its static
 *       details;
 *     - DH-09 same-pass scheduling/fairness, including the default-50 boundary and no reservation;
 *    all in `slack-source-discovery.datamechanics.test.ts`. The §9.1/§9.2 fixture corrections are in
 *    the discovery, fences and bootstrap suites;
 *  - acceptance BEFORE enqueue, the rollback boundary and the rejected/subdivided/refused caller
 *    handling are tested in the discovery suite's packet 5 (GREEN since `f556163d`);
 *  - beyond packet 7's matrix (see its ledger above): the newest lane as the CLAIMED lane of a
 *    compatibility writer, public/binder verdict variants other than the one private-under-claim case,
 *    the 200-channel bulk projection, and long-cycle detection;
 *  - the full DH-11/12/13 matrices and the controlled mutants;
 *  - end-to-end composition (runner → discovery → state → timeline).
 */

const WORKSPACE = "T0HISTADM1";
const CHANNEL = "C0HISTADM1";
const REVISION = "ad".repeat(32);
const OTHER_REVISION = "be".repeat(32);
const HISTORICAL_ANCHOR = "1718900500.000000";

/**
 * The newest lane, initialized and NOT claimed, with every field distinct and contract-coherent:
 * B = the historical anchor (the claim rule's catch-up lower), L = S = B − 60 s, U = A.
 */
const NEWEST_FIXTURE = {
  newest_anchor_ts: "1718900800.000000", newest_lower_ts: HISTORICAL_ANCHOR, newest_request_lower_ts: "1718900440.000000",
  newest_segment_lower_ts: "1718900440.000000", newest_segment_upper_ts: "1718900800.000000",
  newest_cursor: "syn-n-1", newest_cursor_history: JSON.stringify(["syn-n-1"]), newest_scan_generation: 2,
};

/** The historical segment WIDTH, explicit per fixture. Historical L is the implicit 0. */
type SegmentWidth = "wide" | "singleton";
const HISTORICAL_SEGMENTS: Record<SegmentWidth, { lower: string; upper: string; pageOldest: string }> = {
  // S = L = 0 < U = A: an over-cap or unrepresentable continuation SUBDIVIDES here (later packet).
  wide: { lower: "0.000000", upper: HISTORICAL_ANCHOR, pageOldest: "1718900400.000000" },
  // S = U = A: an over-cap or unrepresentable continuation is a TRUE rejection.
  singleton: { lower: HISTORICAL_ANCHOR, upper: HISTORICAL_ANCHOR, pageOldest: HISTORICAL_ANCHOR },
};

/** The only cursors that must never reach SQL carry this synthetic marker. */
const UNREPRESENTABLE_MARKER = "syn-unrep-";
const OLDER_ENTRY = "syn-h-older";
const PG_QUERY = Client.prototype.query;

function tx<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> {
  return transactionCapability(db()).transaction(fn);
}

/** True if the string holds an UNPAIRED UTF-16 surrogate. Scans code units; never stores the value. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
      else return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * True if `value` carries an unrepresentable cursor anywhere: a string with a lone surrogate or the
 * synthetic marker (which also catches a U+FFFD-replaced or JSON-escaped copy), searched
 * recursively through arrays, objects, maps, sets and byte buffers. Scans code units and bytes
 * only; never stringifies or keeps a value. Anything it cannot inspect (too deep, or a `toPostgres`
 * value serialized later by pg) fails CLOSED as carrying.
 */
function carriesUnrepresentableCursor(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): boolean {
  if (typeof value === "string") return value.includes(UNREPRESENTABLE_MARKER) || hasLoneSurrogate(value);
  if (value === null || typeof value !== "object") return false;
  if (depth > 32) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).includes(UNREPRESENTABLE_MARKER);
  if (value instanceof Date) return false;
  if (typeof (value as { toPostgres?: unknown }).toPostgres === "function") return true;
  const items: unknown[] = value instanceof Map ? [...value.keys(), ...value.values()]
    : value instanceof Set ? [...value.values()]
      : Array.isArray(value) ? value : Object.values(value);
  return items.some((item) => carriesUnrepresentableCursor(item, seen, depth + 1));
}

type SqlRecorder = { unrepresentableCursorSent: boolean; statements: number };
const newRecorder = (): SqlRecorder => ({ unrepresentableCursorSent: false, statements: 0 });

/**
 * One transaction with the pg QUERY BOUNDARY recorded. Every surface reaches `pg.Client.prototype.query`:
 *  - `executeSql`;
 *  - the session's query builder;
 *  - control statements;
 *  - pool queries.
 * The interception is installed only for this transaction and restored in `finally`. It refuses to
 * nest. Only a boolean and a statement count are kept.
 */
async function recordingTx<T>(recorder: SqlRecorder, fn: (session: TransactionSession) => Promise<T>): Promise<T> {
  const proto = Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = proto.query;
  if (original !== (PG_QUERY as unknown)) throw new Error("fixture: the pg query recorder is already installed");
  proto.query = function recordedQuery(this: unknown, ...args: unknown[]) {
    recorder.statements += 1;
    if (carriesUnrepresentableCursor(args)) recorder.unrepresentableCursorSent = true;
    return original.apply(this, args);
  };
  try {
    return await tx(fn);
  } finally {
    proto.query = original;
  }
}

/** Any exception reduced to SQLSTATE and name; nothing value-bearing is kept. */
function sanitized(error: unknown): Record<string, unknown> {
  const e = (error ?? {}) as { code?: unknown; name?: unknown };
  return { threw: true, code: typeof e.code === "string" ? e.code : null, name: typeof e.name === "string" ? e.name : null };
}

/**
 * True if any PROPERTY NAME, at any depth, names a history. Values are not matched, because the
 * contract's own categories (`cursor_history_*`) legitimately appear as a category or last error code.
 */
function hasHistoryKey(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) => /history/i.test(key) || hasHistoryKey(item, seen));
}

/** Booleans only: does a returned value name a history, or carry the older H entry? */
function leaks(value: unknown): { historyKey: boolean; olderEntry: boolean } {
  const text = JSON.stringify(value) ?? "";
  return { historyKey: hasHistoryKey(value), olderEntry: text.includes(OLDER_ENTRY) };
}

/**
 * True if a RETURNED value leaks anything: an unrepresentable cursor (checked first, so such a
 * value is never stringified), a history key, or the older H entry.
 */
function returnedLeak(value: unknown): boolean {
  if (carriesUnrepresentableCursor(value)) return true;
  const found = leaks(value);
  return found.historyKey || found.olderEntry;
}

/**
 * A typed outcome reduced to `{ outcome, category? }`; nothing else (no state, no cursor) is kept.
 * The no-leak check applies to EVERY returned outcome (written, rejected, refused, subdivided). A
 * leaking value gains `leaked: true`, which no expectation contains, so the leak is an assertion
 * mismatch without its value ever being printed.
 */
function project(result: unknown): Record<string, unknown> {
  const value = (result ?? {}) as { outcome?: unknown; category?: unknown };
  const base: Record<string, unknown> = value.category === undefined ? { outcome: value.outcome } : { outcome: value.outcome, category: value.category };
  return returnedLeak(result) ? { ...base, leaked: true } : base;
}

/** A release outcome under the same no-leak rule: its bare outcome when clean, else a leak marker. */
function releaseView(released: unknown): unknown {
  const outcome = (released as { outcome?: unknown } | null)?.outcome;
  return returnedLeak(released) ? { outcome, leaked: true } : outcome;
}

type Page = { terminal: boolean; nextCursor: string | null; oldestTs: string | null };

/**
 * Accept one page in ONE transaction. For a typed `rejected` result, the caller's SAME-transaction
 * passed-turn release follows (§3.2). Any exception is sanitized, so an intended RED is an
 * assertion mismatch and nothing value-bearing prints.
 */
async function admit(claim: SlackChannelClaim, page: Page, recorder?: SqlRecorder): Promise<Record<string, unknown>> {
  const run = async (session: TransactionSession) => {
    const accepted = await acceptSlackChannelPage(session, claim, page);
    const view = accepted as unknown as { outcome: string; category?: string };
    if (view.outcome === "rejected" && typeof view.category === "string") {
      const released = await releaseSlackChannelForRetry(session, claim, { errorCode: view.category, turn: "passed", nextDueAt: null });
      return { accept: project(accepted), release: releaseView(released) };
    }
    return { accept: project(accepted) };
  };
  try {
    return await (recorder ? recordingTx(recorder, run) : tx(run));
  } catch (error) {
    return sanitized(error);
  }
}

type Seeded = { scope: SlackChannelScope; integrationId: string; width: SegmentWidth; pageOldest: string };

/**
 * Seed a team, a Slack integration and ONE claimable channel. Its historical lane holds `history` in a
 * segment of the given WIDTH, and the width is then asserted from the stored row. Use
 * `seedWideSegment` or `seedSingletonSegment`; never this directly.
 */
async function seedChannel(width: SegmentWidth, history: string[]): Promise<Seeded> {
  const segment = HISTORICAL_SEGMENTS[width];
  const seed = await seedTeam();
  const scope = { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL };
  const integrationId = await tx(async (session) => (await session.executeSql<{ id: string }>(
    `insert into integrations (team_id, type, name) values ($1, 'slack', 'history-admission-binder') returning id::text as id`, [seed.teamId]
  )).rows[0].id);
  const stored = await tx(async (session) => {
    await session.executeSql(
      `insert into slack_sync_channels
         (team_id, workspace_id, channel_id, public_state, public_checked_at, binding_integration_id, binding_config_revision,
          newest_anchor_ts, newest_lower_ts, newest_request_lower_ts, newest_segment_lower_ts, newest_segment_upper_ts,
          newest_cursor, newest_cursor_history, newest_scan_generation,
          historical_anchor_ts, historical_segment_lower_ts, historical_segment_upper_ts,
          historical_cursor, historical_cursor_history, historical_scan_generation,
          next_lane, due_at)
       values ($1, $2, $3, 'public', '2026-01-01 00:00:00+00', $4::uuid, $5,
               $6, $7, $8, $9, $10, $11, $12::jsonb, $13,
               $14, $15, $16, $17, $18::jsonb, 4,
               'historical', '2020-01-01 00:00:00+00')`,
      [seed.teamId, WORKSPACE, CHANNEL, integrationId, REVISION,
        NEWEST_FIXTURE.newest_anchor_ts, NEWEST_FIXTURE.newest_lower_ts, NEWEST_FIXTURE.newest_request_lower_ts,
        NEWEST_FIXTURE.newest_segment_lower_ts, NEWEST_FIXTURE.newest_segment_upper_ts,
        NEWEST_FIXTURE.newest_cursor, NEWEST_FIXTURE.newest_cursor_history, NEWEST_FIXTURE.newest_scan_generation,
        HISTORICAL_ANCHOR, segment.lower, segment.upper,
        history.length > 0 ? history[history.length - 1] : null, JSON.stringify(history)]
    );
    return (await session.executeSql<{ width: string }>(
      `select case when historical_segment_lower_ts::numeric = historical_segment_upper_ts::numeric then 'singleton'
                   when historical_segment_lower_ts::numeric < historical_segment_upper_ts::numeric then 'wide'
                   else 'invalid' end as width
         from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
      [scope.teamId, scope.workspaceId, scope.channelId]
    )).rows[0].width;
  });
  expect(stored, `fixture: the historical segment is ${width}`).toBe(width);
  return { scope, integrationId, width, pageOldest: segment.pageOldest };
}
/** S = L = 0 < U = A. For appends, repetition, terminal completion, controls and the fence matrix. */
const seedWideSegment = (history: string[]) => seedChannel("wide", history);
/** S = U = A. For EVERY capacity or unrepresentable true rejection, and its boundaries. */
const seedSingletonSegment = (history: string[]) => seedChannel("singleton", history);

async function claimHistorical({ scope, integrationId }: Seeded): Promise<SlackChannelClaim> {
  const result = await tx((session) => claimSlackChannelPage(session, scope, { bindingIntegrationId: integrationId, bindingConfigRevision: REVISION }));
  // The claim result is a union (claim | typed delay | null); only a real claim carries a lane.
  const claim = result !== null && !("outcome" in result) ? result : null;
  expect({ claimed: claim !== null, lane: claim?.lane, generation: claim?.scanGeneration }, "fixture: the historical lane is claimed at generation 4").toEqual({
    claimed: true, lane: "historical", generation: 4,
  });
  return claim as SlackChannelClaim;
}
/** The row digested without the named columns (md5 only). */
async function rowDigestExcept(scope: SlackChannelScope, excluded: string[]): Promise<string> {
  return tx(async (session) => (await session.executeSql<{ digest: string }>(
    `select pg_catalog.md5((pg_catalog.to_jsonb(s) - $4::text[])::text) as digest
       from slack_sync_channels s where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId, excluded]
  )).rows[0].digest);
}
/** Every newest-lane field equals the fixture literal (one boolean). */
async function newestLaneExact(scope: SlackChannelScope): Promise<boolean> {
  return tx(async (session) => (await session.executeSql<{ exact: boolean }>(
    `select coalesce(newest_anchor_ts = $4 and newest_lower_ts = $5 and newest_request_lower_ts = $6
                     and newest_segment_lower_ts = $7 and newest_segment_upper_ts = $8
                     and newest_cursor = $9 and newest_cursor_history = $10::jsonb
                     and newest_scan_generation = $11::bigint, false) as exact
       from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId,
      NEWEST_FIXTURE.newest_anchor_ts, NEWEST_FIXTURE.newest_lower_ts, NEWEST_FIXTURE.newest_request_lower_ts,
      NEWEST_FIXTURE.newest_segment_lower_ts, NEWEST_FIXTURE.newest_segment_upper_ts,
      NEWEST_FIXTURE.newest_cursor, NEWEST_FIXTURE.newest_cursor_history, NEWEST_FIXTURE.newest_scan_generation]
  )).rows[0].exact);
}
/** Boolean facts about the stored historical lane against literal expectations; values never print. */
async function historicalFacts(scope: SlackChannelScope, cursor: string | null, history: string[]) {
  const row = await tx(async (session) => (await session.executeSql<Record<string, unknown>>(
    `select historical_cursor is not distinct from $4 as cursor_is_expected,
            historical_cursor_history = $5::jsonb as history_is_expected,
            pg_catalog.jsonb_array_length(historical_cursor_history)::int as entries,
            historical_scan_generation::int as generation
       from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId, cursor, JSON.stringify(history)]
  )).rows[0]);
  return { ...row, newest_lane_unchanged: await newestLaneExact(scope) };
}
/** Turn, lease, read and diagnostic bookkeeping, plus the historical attempt-oldest against a literal. */
async function bookkeeping(scope: SlackChannelScope, attemptOldest: string | null) {
  return tx(async (session) => (await session.executeSql<Record<string, unknown>>(
    `select next_lane, claimed_lane, lease_owner is null and lease_expires_at is null as lease_cleared,
            last_read_at is not null as last_read_set, last_error_code,
            historical_oldest_seen_ts is not distinct from $4 as attempt_oldest_is_expected
       from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId, attemptOldest]
  )).rows[0]);
}
/** §5 final terminal / §6 envelope completion facts for the historical lane (booleans and G only). */
async function historicalCompletion(scope: SlackChannelScope, completedLower: string, completedUpper: string) {
  const row = await tx(async (session) => (await session.executeSql<Record<string, unknown>>(
    `select historical_anchor_ts is null as anchor_cleared,
            historical_segment_lower_ts is null and historical_segment_upper_ts is null as segment_cleared,
            historical_oldest_seen_ts is null as attempt_oldest_cleared,
            historical_completed_segments_oldest_ts is null as aggregate_cleared,
            historical_cursor is null as cursor_cleared,
            historical_cursor_history = '[]'::jsonb as history_cleared,
            historical_scan_generation::int as generation,
            historical_floor_reached as floor_reached,
            completed_lower_ts is not distinct from $4 as completed_lower_is_expected,
            completed_upper_ts is not distinct from $5 as completed_upper_is_expected,
            newest_catchup_upper_ts is null as provisional_cleared
       from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId, completedLower, completedUpper]
  )).rows[0]);
  return { ...row, newest_lane_unchanged: await newestLaneExact(scope) };
}
async function storedHistoricalSize(scope: SlackChannelScope) {
  return tx(async (session) => (await session.executeSql<{ entries: number; bytes: number }>(
    `select pg_catalog.jsonb_array_length(historical_cursor_history)::int as entries,
            pg_catalog.octet_length(historical_cursor_history::text)::int as bytes
       from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId]
  )).rows[0]);
}
/** The CANDIDATE history (stored H plus one synthetic ASCII cursor), sized by SQL's own definition. */
async function candidateHistoricalSize(scope: SlackChannelScope, cursor: string) {
  return tx(async (session) => (await session.executeSql<{ entries: number; bytes: number }>(
    `select pg_catalog.jsonb_array_length(c)::int as entries, pg_catalog.octet_length(c::text)::int as bytes
       from (select historical_cursor_history || pg_catalog.jsonb_build_array($4::text) as c
               from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3) candidate`,
    [scope.teamId, scope.workspaceId, scope.channelId, cursor]
  )).rows[0]);
}

type Mutation = (seeded: Seeded) => Promise<void>;
/** A stale-authority mutation applied AFTER the claim; `$1` is the seeded team. */
const sqlMutation = (sql: string): Mutation => async ({ scope }) => {
  await tx((session) => session.executeSql(sql, [scope.teamId]));
};
const EXPIRE_LEASE = sqlMutation("update slack_sync_channels set lease_expires_at = clock_timestamp() - interval '1 second' where team_id = $1");
const REVOKE_PUBLIC = sqlMutation("update slack_sync_channels set public_state = 'private' where team_id = $1");

/** Columns a PARTIAL acceptance may change; every other column must be byte-identical. */
const PARTIAL_PERMITTED = [
  "historical_cursor", "historical_cursor_history", "historical_oldest_seen_ts",
  "next_lane", "claimed_lane", "lease_owner", "lease_expires_at", "last_error_code", "last_read_at", "due_at", "updated_at",
];
/**
 * Columns a historical §5 final terminal (S = L) / §6 envelope completion may change; every other
 * column, including the whole newest lane, attempts and lease_generation, must be byte-identical.
 */
const TERMINAL_PERMITTED = [
  "historical_anchor_ts", "historical_cursor", "historical_cursor_history", "historical_scan_generation",
  "historical_segment_lower_ts", "historical_segment_upper_ts", "historical_oldest_seen_ts", "historical_completed_segments_oldest_ts",
  "historical_floor_reached", "completed_lower_ts", "completed_upper_ts", "newest_catchup_upper_ts",
  "next_lane", "claimed_lane", "lease_owner", "lease_expires_at", "last_error_code", "last_read_at", "due_at", "updated_at",
];
/** Columns the §3.2 passed-turn release may change after a true rejection; nothing else may move. */
const RELEASE_PERMITTED = ["next_lane", "claimed_lane", "lease_owner", "lease_expires_at", "due_at", "last_error_code", "updated_at"];

/** 1,000 distinct short entries: the ENTRY cap, far below the byte cap. */
const entryCapHistory = (): string[] => Array.from({ length: 1000 }, (_, i) => `cap${String(i).padStart(3, "0")}`);
/**
 * A maximum accepted history: 1,000 distinct entries at EXACTLY 1,048,576 serialized bytes (4-byte
 * id plus U+4E00 padding; 576 × 1,045 + 424 × 1,044 bytes, plus brackets, quotes and separators).
 */
function byteCapHistory(): string[] {
  const pad = String.fromCodePoint(0x4e00);
  return Array.from({ length: 1000 }, (_, i) => {
    const id = `b${String(i).padStart(3, "0")}`;
    return i < 576 ? id + pad.repeat(347) : `${id}${pad.repeat(346)}aa`;
  });
}
/**
 * 999 entries of 1,045 bytes: 1,047,951 serialized bytes (2 + 999 × 1,047 + 998 × 2). An ASCII cursor of n
 * characters adds n + 4, so n = 620 / 621 / 622 gives a 1,048,575 / 1,048,576 / 1,048,577-byte
 * candidate. A 700-byte cursor overflows ONLY the byte cap.
 */
function nearByteCapHistory(): string[] {
  const pad = String.fromCodePoint(0x4e00);
  return Array.from({ length: 999 }, (_, i) => `n${String(i).padStart(3, "0")}${pad.repeat(347)}`);
}

describe("AM-F2 runtime packets 1–3 — state-writer history admission and claim-time segment initialization (real Postgres)", () => {
  beforeAll(async () => {
    // 1. The shared guard FIRST: only the isolated local runner or CI's service. The error never
    //    prints the URL, and nothing below runs unless the URL is accepted.
    const guardedUrl = requireIsolatedTestUrl(process.env.DATABASE_TEST_URL);
    // 2. Empty the ONE table the upgrade block validates, so a previous suite's leftover rows (setup.ts
    //    truncates before each TEST, not before this hook) cannot decide the upgrade.
    const client = new Client({ connectionString: guardedUrl });
    await client.connect();
    try {
      await client.query("truncate table public.slack_sync_channels");
    } finally {
      await client.end().catch(() => {});
    }
    // 3. Bring the tier database to the CURRENT F2/DH schema with the REAL deploy loader, exactly as
    //    `slack-method-budget` does. It runs schema.sql, whose byte-identical marked block upgrades
    //    `slack_sync_channels`, then every migration. Replay is idempotent, and it runs against the
    //    GUARDED url only. Its notices print to stdout and are not asserted.
    await loadSchema({ cwd: process.cwd(), databaseUrl: guardedUrl, logger: { log: () => {} } });
  }, 300_000);

  it("§5 row 1 an ordinary continuation APPENDS the exact decoded cursor after the lane's prior entries, records attempt-oldest and passes the turn; the other lane and unrelated state stay exact", async () => {
    const seeded = await seedWideSegment(["syn-h-1", "syn-h-2"]);
    const { scope } = seeded;
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(scope, PARTIAL_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: "syn-h-3", oldestTs: seeded.pageOldest });
    expect({
      outcome,
      facts: await historicalFacts(scope, "syn-h-3", ["syn-h-1", "syn-h-2", "syn-h-3"]),
      bookkeeping: await bookkeeping(scope, seeded.pageOldest),
      unrelatedUnchanged: (await rowDigestExcept(scope, PARTIAL_PERMITTED)) === before,
    }, "the cursor is appended (not replaced) as H's final element; nothing outside the permitted partial fields moves").toEqual({
      outcome: { accept: { outcome: "written" } },
      facts: { cursor_is_expected: true, history_is_expected: true, entries: 3, generation: 4, newest_lane_unchanged: true },
      bookkeeping: {
        next_lane: "newest", claimed_lane: null, lease_cleared: true, last_read_set: true, last_error_code: null,
        attempt_oldest_is_expected: true,
      },
      unrelatedUnchanged: true,
    });
  });

  it("F2-01 (partial) / F2-06 an exact repetition on a WIDE segment is rejected as cursor_repeated (never subdivided); the same-transaction passed-turn release is the only change", async () => {
    const seeded = await seedWideSegment(["syn-h-1", "syn-h-2"]);
    const { scope } = seeded;
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: "syn-h-1", oldestTs: seeded.pageOldest });
    expect({
      outcome, bookkeeping: await bookkeeping(scope, null),
      facts: await historicalFacts(scope, "syn-h-2", ["syn-h-1", "syn-h-2"]),
      onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === before,
    }, "typed cursor_repeated; no history, cursor, generation, segment, progress or certification change; the turn passes").toEqual({
      outcome: { accept: { outcome: "rejected", category: "cursor_repeated" }, release: "written" },
      bookkeeping: {
        next_lane: "newest", claimed_lane: null, lease_cleared: true, last_read_set: false, last_error_code: "cursor_repeated",
        attempt_oldest_is_expected: true,
      },
      facts: { cursor_is_expected: true, history_is_expected: true, entries: 2, generation: 4, newest_lane_unchanged: true },
      onlyReleaseFieldsMoved: true,
    });
  });

  it("F2-01 (partial) / F2-04 repetition AT the entry cap on a WIDE segment is still cursor_repeated (repetition precedes capacity; never subdivided)", async () => {
    const history = entryCapHistory();
    const seeded = await seedWideSegment(history);
    const { scope } = seeded;
    expect(await storedHistoricalSize(scope), "fixture: the historical lane is at the 1,000-entry cap").toEqual({ entries: 1000, bytes: 10000 });
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: history[500], oldestTs: seeded.pageOldest });
    expect({ outcome, onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === before },
      "a repeated cursor at the cap is repetition, not entry overflow").toEqual({
      outcome: { accept: { outcome: "rejected", category: "cursor_repeated" }, release: "written" }, onlyReleaseFieldsMoved: true,
    });
  });

  it.each([
    {
      label: "ENTRY overflow (1,000 short entries + one new cursor)", history: entryCapHistory, cursor: "cap-new",
      stored: { entries: 1000, bytes: 10000 }, candidate: { entries: 1001, bytes: 10011 }, category: "cursor_history_entries_exceeded",
    },
    {
      label: "BYTE overflow only (999 entries near the byte cap + a 700-byte cursor)", history: nearByteCapHistory, cursor: "z".repeat(700),
      stored: { entries: 999, bytes: 1047951 }, candidate: { entries: 1000, bytes: 1048655 }, category: "cursor_history_bytes_exceeded",
    },
    {
      label: "BOTH caps (a maximum history + one new cursor) resolving to entries", history: byteCapHistory, cursor: "both-new",
      stored: { entries: 1000, bytes: 1048576 }, candidate: { entries: 1001, bytes: 1048588 }, category: "cursor_history_entries_exceeded",
    },
  ])("F2-04/F2-05 on a SINGLETON segment, $label is the typed $category, computed on the actual candidate, with only the release moving", async ({ history, cursor, stored, candidate, category }) => {
    const seeded = await seedSingletonSegment(history());
    const { scope } = seeded;
    expect({ stored: await storedHistoricalSize(scope), candidate: await candidateHistoricalSize(scope, cursor) },
      "fixture: SQL-sized stored and candidate histories").toEqual({ stored, candidate });
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: cursor, oldestTs: seeded.pageOldest });
    expect({ outcome, onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === before, after: await storedHistoricalSize(scope) },
      `typed ${category}; an unsplittable range keeps the stored history untouched`).toEqual({
      outcome: { accept: { outcome: "rejected", category }, release: "written" }, onlyReleaseFieldsMoved: true, after: stored,
    });
  });

  it.each([
    { label: "1,048,575 bytes (cap − 1) is written", length: 620, bytes: 1048575, admitted: true },
    { label: "1,048,576 bytes (exactly the cap) is written", length: 621, bytes: 1048576, admitted: true },
    { label: "1,048,577 bytes (cap + 1) is rejected", length: 622, bytes: 1048577, admitted: false },
  ])("F2-05 inclusive byte boundary on a SINGLETON segment: a candidate of $label", async ({ length, bytes, admitted }) => {
    const base = nearByteCapHistory();
    const seeded = await seedSingletonSegment(base);
    const { scope } = seeded;
    const cursor = "w".repeat(length);
    expect({ stored: await storedHistoricalSize(scope), candidate: await candidateHistoricalSize(scope, cursor) },
      "fixture: the 999-entry base is exactly 1,047,951 bytes and the candidate is SQL-sized").toEqual({
      stored: { entries: 999, bytes: 1047951 }, candidate: { entries: 1000, bytes },
    });
    const claim = await claimHistorical(seeded);
    const beforePartial = await rowDigestExcept(scope, PARTIAL_PERMITTED);
    const beforeRelease = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: cursor, oldestTs: seeded.pageOldest });
    if (admitted) {
      expect({
        outcome, after: await storedHistoricalSize(scope),
        facts: await historicalFacts(scope, cursor, [...base, cursor]),
        unrelatedUnchanged: (await rowDigestExcept(scope, PARTIAL_PERMITTED)) === beforePartial,
      }, "within the inclusive byte cap: appended, and the stored history IS the candidate").toEqual({
        outcome: { accept: { outcome: "written" } }, after: { entries: 1000, bytes },
        facts: { cursor_is_expected: true, history_is_expected: true, entries: 1000, generation: 4, newest_lane_unchanged: true },
        unrelatedUnchanged: true,
      });
    } else {
      expect({
        outcome, after: await storedHistoricalSize(scope),
        onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === beforeRelease,
      }, "one byte over the cap on an unsplittable range: rejected, the release is the only change").toEqual({
        outcome: { accept: { outcome: "rejected", category: "cursor_history_bytes_exceeded" }, release: "written" },
        after: { entries: 999, bytes: 1047951 }, onlyReleaseFieldsMoved: true,
      });
    }
  });

  it("F2-04 inclusive entry boundary on a SINGLETON segment: 999 → 1,000 entries is written", async () => {
    const base = entryCapHistory().slice(0, 999);
    const seeded = await seedSingletonSegment(base);
    const { scope } = seeded;
    const cursor = "cap999";
    expect({ stored: await storedHistoricalSize(scope), candidate: await candidateHistoricalSize(scope, cursor) },
      "fixture: 999 stored entries and a 1,000-entry candidate").toEqual({
      stored: { entries: 999, bytes: 9990 }, candidate: { entries: 1000, bytes: 10000 },
    });
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(scope, PARTIAL_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: cursor, oldestTs: seeded.pageOldest });
    expect({
      outcome, after: await storedHistoricalSize(scope),
      facts: await historicalFacts(scope, cursor, [...base, cursor]),
      unrelatedUnchanged: (await rowDigestExcept(scope, PARTIAL_PERMITTED)) === before,
    }, "the 1,000th entry is within the inclusive entry cap").toEqual({
      outcome: { accept: { outcome: "written" } }, after: { entries: 1000, bytes: 10000 },
      facts: { cursor_is_expected: true, history_is_expected: true, entries: 1000, generation: 4, newest_lane_unchanged: true },
      unrelatedUnchanged: true,
    });
  });

  it.each([
    { label: "the exact entry cap", history: entryCapHistory, stored: { entries: 1000, bytes: 10000 } },
    { label: "the exact byte cap (1,048,576 bytes)", history: byteCapHistory, stored: { entries: 1000, bytes: 1048576 } },
  ])("§5 final terminal (S = L) / §6 / F2-04/F2-05 a TERMINAL page at $label finishes the envelope: real completion, not a restart", async ({ history, stored }) => {
    const seeded = await seedWideSegment(history());
    const { scope } = seeded;
    // Discriminating prior state: a current-attempt oldest OLDER than the page's oldest (so the §6
    // merge must pick it) and a non-null diagnostic (so the success must clear it).
    const priorAttemptOldest = "1718900050.000000";
    const pageOldest = "1718900100.000000";
    await tx((session) => session.executeSql(
      "update slack_sync_channels set historical_oldest_seen_ts = $2, last_error_code = 'prior_failure' where team_id = $1",
      [scope.teamId, priorAttemptOldest]
    ));
    expect({ size: await storedHistoricalSize(scope), prior: await bookkeeping(scope, priorAttemptOldest) },
      "fixture: the lane is exactly at its cap, with a prior attempt-oldest and diagnostic").toEqual({
      size: stored,
      prior: {
        next_lane: "historical", claimed_lane: null, lease_cleared: true, last_read_set: false, last_error_code: "prior_failure",
        attempt_oldest_is_expected: true,
      },
    });
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(scope, TERMINAL_PERMITTED);
    const outcome = await admit(claim, { terminal: true, nextCursor: null, oldestTs: pageOldest });
    expect({
      outcome,
      completion: await historicalCompletion(scope, priorAttemptOldest, HISTORICAL_ANCHOR),
      bookkeeping: await bookkeeping(scope, null),
      onlyTerminalFieldsMoved: (await rowDigestExcept(scope, TERMINAL_PERMITTED)) === before,
    }, "a terminal page appends no cursor; the whole historical envelope is certified [older of prior attempt-oldest and page oldest, A], its lane state cleared, and nothing else moves").toEqual({
      outcome: { accept: { outcome: "written" } },
      completion: {
        anchor_cleared: true, segment_cleared: true, attempt_oldest_cleared: true, aggregate_cleared: true,
        cursor_cleared: true, history_cleared: true, generation: 5, floor_reached: true,
        completed_lower_is_expected: true, completed_upper_is_expected: true, provisional_cleared: true, newest_lane_unchanged: true,
      },
      bookkeeping: {
        next_lane: "newest", claimed_lane: null, lease_cleared: true, last_read_set: true, last_error_code: null,
        attempt_oldest_is_expected: true,
      },
      onlyTerminalFieldsMoved: true,
    });
  });

  it("F2-09 (partial) PRIMARY: an embedded lone HIGH surrogate on a SINGLETON segment is cursor_unrepresentable, and it NEVER reaches SQL", async () => {
    const seeded = await seedSingletonSegment(["syn-h-1", "syn-h-2"]);
    const { scope } = seeded;
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const recorder = newRecorder();
    const lone = `${UNREPRESENTABLE_MARKER}${String.fromCharCode(0xd800)}-x`;
    const outcome = await admit(claim, { terminal: false, nextCursor: lone, oldestTs: seeded.pageOldest }, recorder);
    expect({
      outcome, unrepresentableCursorReachedSql: recorder.unrepresentableCursorSent, interceptorLive: recorder.statements > 0,
      onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === before,
    }, "typed cursor_unrepresentable; no SQL text or parameter ever carries the cursor").toEqual({
      outcome: { accept: { outcome: "rejected", category: "cursor_unrepresentable" }, release: "written" },
      unrepresentableCursorReachedSql: false, interceptorLive: true, onlyReleaseFieldsMoved: true,
    });
  });

  it.each([
    { label: "an embedded lone LOW surrogate", cursor: () => `${UNREPRESENTABLE_MARKER}${String.fromCharCode(0xdc00)}-x` },
    { label: "a TRAILING lone HIGH surrogate", cursor: () => `${UNREPRESENTABLE_MARKER}x${String.fromCharCode(0xdbff)}` },
    { label: "an ISOLATED leading LOW surrogate", cursor: () => `${String.fromCharCode(0xdfff)}${UNREPRESENTABLE_MARKER}x` },
  ])("F2-09 (partial) variant: $label on a SINGLETON segment is cursor_unrepresentable, and it NEVER reaches SQL", async ({ cursor }) => {
    const seeded = await seedSingletonSegment(["syn-h-1", "syn-h-2"]);
    const { scope } = seeded;
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const recorder = newRecorder();
    const outcome = await admit(claim, { terminal: false, nextCursor: cursor(), oldestTs: seeded.pageOldest }, recorder);
    expect({
      outcome, unrepresentableCursorReachedSql: recorder.unrepresentableCursorSent, interceptorLive: recorder.statements > 0,
      onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === before,
    }, "every unpaired surrogate shape is the same typed rejection with no SQL exposure").toEqual({
      outcome: { accept: { outcome: "rejected", category: "cursor_unrepresentable" }, release: "written" },
      unrepresentableCursorReachedSql: false, interceptorLive: true, onlyReleaseFieldsMoved: true,
    });
  });

  // The stored spelling a lone HIGH would collapse to under UTF-8 replacement: same marker and
  // suffix, with a literal U+FFFD. It is NOT the final element, so the current cursor (sent by every
  // fence) carries no marker.
  const FFFD_SPELLING = `${UNREPRESENTABLE_MARKER}${String.fromCodePoint(0xfffd)}-x`;
  it.each([
    {
      label: "at the ENTRY cap, where a fitting check would say entries_exceeded", history: entryCapHistory,
      stored: { entries: 1000, bytes: 10000 },
    },
    {
      label: "at BOTH caps, where a fitting check would say entries_exceeded", history: byteCapHistory,
      stored: { entries: 1000, bytes: 1048576 },
    },
    {
      label: "against a stored literal-U+FFFD spelling, where a replacement-encoded comparison would say cursor_repeated",
      history: () => [FFFD_SPELLING, "syn-h-2"], stored: null,
    },
  ])("F2-09 (partial) precedence on a SINGLETON segment: a lone HIGH surrogate $label is still cursor_unrepresentable, and it NEVER reaches SQL", async ({ history, stored }) => {
    const seeded = await seedSingletonSegment(history());
    const { scope } = seeded;
    const sizeBefore = await storedHistoricalSize(scope);
    if (stored) expect(sizeBefore, "fixture: the stored history is exactly at the named cap").toEqual(stored);
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const recorder = newRecorder();
    const lone = `${UNREPRESENTABLE_MARKER}${String.fromCharCode(0xd800)}-x`;
    const outcome = await admit(claim, { terminal: false, nextCursor: lone, oldestTs: seeded.pageOldest }, recorder);
    expect({
      outcome, unrepresentableCursorReachedSql: recorder.unrepresentableCursorSent, interceptorLive: recorder.statements > 0,
      onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === before,
      sizeUnchanged: JSON.stringify(await storedHistoricalSize(scope)) === JSON.stringify(sizeBefore),
    }, "unrepresentable precedes repetition and capacity; the release is the only change").toEqual({
      outcome: { accept: { outcome: "rejected", category: "cursor_unrepresentable" }, release: "written" },
      unrepresentableCursorReachedSql: false, interceptorLive: true, onlyReleaseFieldsMoved: true, sizeUnchanged: true,
    });
  });

  it.each([
    { label: "a valid surrogate pair", cursor: `syn-pair-${String.fromCodePoint(0x1f600)}-x` },
    { label: "a literal U+FFFD", cursor: `syn-fffd-${String.fromCodePoint(0xfffd)}-x` },
  ])("F2-09 positive control: $label is representable and appended EXACTLY", async ({ cursor }) => {
    const seeded = await seedWideSegment(["syn-h-1"]);
    const claim = await claimHistorical(seeded);
    const outcome = await admit(claim, { terminal: false, nextCursor: cursor, oldestTs: seeded.pageOldest });
    expect({ outcome, facts: await historicalFacts(seeded.scope, cursor, ["syn-h-1", cursor]) }, "written, and the exact UTF-16 string is H's final element").toEqual({
      outcome: { accept: { outcome: "written" } },
      facts: { cursor_is_expected: true, history_is_expected: true, entries: 2, generation: 4, newest_lane_unchanged: true },
    });
  });

  it("F2-09 control: the pg-boundary recorder sees SQL text, nested parameters and the query-builder surface, classifies every surrogate shape, and is restored", async () => {
    const marker = `${UNREPRESENTABLE_MARKER}calibration`;
    const probe = async (fn: (session: TransactionSession) => Promise<unknown>) => {
      const recorder = newRecorder();
      await recordingTx(recorder, async (session) => { await fn(session); });
      return { sent: recorder.unrepresentableCursorSent, live: recorder.statements > 0 };
    };
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdc00);
    expect({
      clean: await probe((session) => session.executeSql("select 1 as n")),
      sqlText: await probe((session) => session.executeSql(`select 1 as n /* ${marker} */`)),
      nestedParameter: await probe((session) => session.executeSql("select pg_catalog.cardinality($1::text[]) as n", [[["x", marker]]])),
      queryBuilder: await probe(async (session) => {
        const { error } = await session.db.from("slack_sync_channels").select("channel_id").eq("channel_id", marker);
        if (error) throw new Error("fixture: query-builder probe failed");
      }),
      restored: Client.prototype.query === PG_QUERY,
      pure: {
        loneHigh: carriesUnrepresentableCursor(`a${high}b`), loneLow: carriesUnrepresentableCursor(`a${low}b`),
        trailingHigh: carriesUnrepresentableCursor(`ab${high}`), isolatedLeadingLow: carriesUnrepresentableCursor(`${low}ab`),
        reversedPair: carriesUnrepresentableCursor(`${low}${high}`), nested: carriesUnrepresentableCursor({ v: [[`a${high}`]] }),
        validPair: carriesUnrepresentableCursor(String.fromCodePoint(0x1f600)), literalFffd: carriesUnrepresentableCursor(String.fromCodePoint(0xfffd)),
      },
    }, "the recorder is live on every surface, fails on each unpaired shape, passes valid controls, and leaves pg as it found it").toEqual({
      clean: { sent: false, live: true }, sqlText: { sent: true, live: true }, nestedParameter: { sent: true, live: true },
      queryBuilder: { sent: true, live: true }, restored: true,
      pure: {
        loneHigh: true, loneLow: true, trailingHigh: true, isolatedLeadingLow: true, reversedPair: true, nested: true,
        validPair: false, literalFffd: false,
      },
    });
  });

  const OTHER_BINDER: Mutation = async ({ scope }) => {
    await tx(async (session) => {
      const other = (await session.executeSql<{ id: string }>(
        `insert into integrations (team_id, type, name) values ($1, 'slack', 'history-admission-other-binder') returning id::text as id`, [scope.teamId]
      )).rows[0].id;
      await session.executeSql("update slack_sync_channels set binding_integration_id = $2::uuid where team_id = $1", [scope.teamId, other]);
    });
  };
  const SUCCESSOR_RECLAIM: Mutation = async (seeded) => {
    await EXPIRE_LEASE(seeded);
    const successor = await tx((session) => claimSlackChannelPage(session, seeded.scope, {
      bindingIntegrationId: seeded.integrationId, bindingConfigRevision: REVISION,
    }));
    expect(successor !== null && !("outcome" in successor) && successor.lane === "historical",
      "fixture: a successor reclaims the expired historical lease").toBe(true);
  };

  it.each([
    { label: "lease expired", mutate: EXPIRE_LEASE },
    { label: "binding config revision changed", mutate: sqlMutation(`update slack_sync_channels set binding_config_revision = '${OTHER_REVISION}' where team_id = $1`) },
    { label: "binding integration id changed", mutate: OTHER_BINDER },
    { label: "public proof revoked", mutate: REVOKE_PUBLIC },
    { label: "historical segment UPPER bound moved under the same generation", mutate: sqlMutation("update slack_sync_channels set historical_segment_upper_ts = '1718900400.000000' where team_id = $1") },
    { label: "historical segment LOWER bound moved under the same generation", mutate: sqlMutation("update slack_sync_channels set historical_segment_lower_ts = '1718900000.000000' where team_id = $1") },
    { label: "historical scan generation drifted", mutate: sqlMutation("update slack_sync_channels set historical_scan_generation = 5 where team_id = $1") },
    {
      label: "historical cursor drifted",
      mutate: sqlMutation(`update slack_sync_channels set historical_cursor = 'syn-h-x', historical_cursor_history = '["syn-h-1", "syn-h-2", "syn-h-x"]'::jsonb where team_id = $1`),
    },
    { label: "successor reclaimed after expiry", mutate: SUCCESSOR_RECLAIM },
  ])("F2-11/DH-08 (partial: historical lane, single session) channel fence — $label — is refused before cursor classification, and the row is exact", async ({ mutate }) => {
    const seeded = await seedWideSegment(["syn-h-1", "syn-h-2"]);
    const { scope } = seeded;
    const claim = await claimHistorical(seeded);
    await mutate(seeded);
    const before = await rowDigestExcept(scope, []);
    // A REPEATED cursor: were the fence not first, this would classify as cursor_repeated.
    const outcome = await admit(claim, { terminal: false, nextCursor: "syn-h-1", oldestTs: seeded.pageOldest });
    expect({ outcome, rowUnchanged: (await rowDigestExcept(scope, [])) === before }, "stale authority is refused before any cursor category").toEqual({
      outcome: { accept: { outcome: "refused" } }, rowUnchanged: true,
    });
  });

  const MOVE_SINGLETON = sqlMutation(
    "update slack_sync_channels set historical_segment_lower_ts = '1718900400.000000', historical_segment_upper_ts = '1718900400.000000' where team_id = $1"
  );
  const LONE_SURROGATE = { cursor: () => `${UNREPRESENTABLE_MARKER}${String.fromCharCode(0xd800)}-x`, history: () => ["syn-h-1", "syn-h-2"], recorded: true };
  const ENTRY_OVERFLOW = { cursor: () => "cap-new", history: entryCapHistory, recorded: false };

  it.each([
    { label: "a lone surrogate under an expired lease", mutate: EXPIRE_LEASE, risk: LONE_SURROGATE },
    { label: "a lone surrogate under a revoked public proof", mutate: REVOKE_PUBLIC, risk: LONE_SURROGATE },
    { label: "a lone surrogate under a moved segment", mutate: MOVE_SINGLETON, risk: LONE_SURROGATE },
    { label: "an entry overflow under an expired lease", mutate: EXPIRE_LEASE, risk: ENTRY_OVERFLOW },
    { label: "an entry overflow under a revoked public proof", mutate: REVOKE_PUBLIC, risk: ENTRY_OVERFLOW },
    { label: "an entry overflow under a moved segment", mutate: MOVE_SINGLETON, risk: ENTRY_OVERFLOW },
  ])("F2-11/DH-08 + F2-09 authority before early classification on a SINGLETON segment: $label is refused, the row is exact", async ({ mutate, risk }) => {
    const seeded = await seedSingletonSegment(risk.history());
    const { scope } = seeded;
    const claim = await claimHistorical(seeded);
    await mutate(seeded);
    const before = await rowDigestExcept(scope, []);
    const recorder = newRecorder();
    const outcome = await admit(claim, { terminal: false, nextCursor: risk.cursor(), oldestTs: seeded.pageOldest }, risk.recorded ? recorder : undefined);
    expect({
      outcome, rowUnchanged: (await rowDigestExcept(scope, [])) === before,
      ...(risk.recorded ? { unrepresentableCursorReachedSql: recorder.unrepresentableCursorSent, interceptorLive: recorder.statements > 0 } : {}),
    }, "stale authority wins over an unrepresentable or over-cap cursor, and the stale branch never parameterizes the cursor").toEqual({
      outcome: { accept: { outcome: "refused" } }, rowUnchanged: true,
      ...(risk.recorded ? { unrepresentableCursorReachedSql: false, interceptorLive: true } : {}),
    });
  });

  it("§3.1 / F2-10 (partial) histories never leave SQL: no older history entry appears in a claim, an ensured or due state, or a release's written state", async () => {
    const seeded = await seedWideSegment([OLDER_ENTRY, "syn-h-2"]);
    const { scope } = seeded;
    const claim = await claimHistorical(seeded);
    const ensured = await tx((session) => ensureSlackChannel(session, scope));
    const due = await tx((session) => dueSlackChannels(session, { teamId: scope.teamId, workspaceId: WORKSPACE, channelIds: [CHANNEL] }));
    const released = await tx((session) => releaseSlackChannelForRetry(session, claim, { errorCode: "boundary_probe", turn: "kept", nextDueAt: null }));
    expect({
      stored: (await storedHistoricalSize(scope)).entries,
      claim: leaks(claim), ensured: leaks(ensured), due: leaks(due), released: { outcome: released.outcome, ...leaks(released) },
    }, "H exists in SQL (2 entries) and appears in NO returned projection").toEqual({
      stored: 2,
      claim: { historyKey: false, olderEntry: false }, ensured: { historyKey: false, olderEntry: false },
      due: { historyKey: false, olderEntry: false }, released: { outcome: "written", historyKey: false, olderEntry: false },
    });
  });

  it("§3.1 / F2-10 (partial) an ACCEPTED written state carries no history key and no older history entry", async () => {
    const seeded = await seedWideSegment([OLDER_ENTRY, "syn-h-2"]);
    const claim = await claimHistorical(seeded);
    let view: Record<string, unknown>;
    try {
      view = await tx(async (session) => {
        const accepted = await acceptSlackChannelPage(session, claim, { terminal: false, nextCursor: "syn-h-3", oldestTs: seeded.pageOldest });
        return { outcome: accepted.outcome, ...leaks(accepted) };
      });
    } catch (error) {
      view = sanitized(error);
    }
    expect({ view, stored: (await storedHistoricalSize(seeded.scope)).entries },
      "the acceptance writer's own returned state is history-free while SQL holds 3 entries").toEqual({
      view: { outcome: "written", historyKey: false, olderEntry: false }, stored: 3,
    });
  });

  it("§3.1 the shared STATE_COLUMNS projection selects no cursor-history column (source boundary)", () => {
    const source = readFileSync(join(process.cwd(), "lib", "ingest", "slack-channel-state.ts"), "utf8");
    const start = source.indexOf("const STATE_COLUMNS = `");
    const end = source.indexOf("`;", start);
    const projection = start >= 0 && end > start ? source.slice(start, end) : "";
    expect({ found: projection.includes("newest_cursor") && projection.includes("historical_cursor"), selectsHistory: projection.includes("cursor_history") },
      "STATE_COLUMNS is located and selects the cursors but neither history").toEqual({ found: true, selectsHistory: false });
  });

  // ── PACKET 2: claim-time segment initialization, historical lane, direct claim (§4, §5) ────────
  // Inside this describe ON PURPOSE, so the guard-first real-loader upgrade above has already run.

  it("§5 init: the FIRST historical claim anchors a canonical A and initializes S = L = 0, U = A, C = null, H = []; nothing else moves", async () => {
    const { scope, integrationId } = await seedUnsegmentedChannel({});
    const before = await rowDigestExcept(scope, CLAIM_PERMITTED);
    const claim = await tx((session) => claimSlackChannelPage(session, scope, { bindingIntegrationId: integrationId, bindingConfigRevision: REVISION }));
    const bounds = claimBounds(claim);
    expect({
      bounds: { ...bounds, anchorTs: undefined },
      anchorCanonical: typeof bounds.anchorTs === "string" && CANONICAL_BOUND.test(bounds.anchorTs),
      upperIsAnchor: bounds.segmentUpperTs === bounds.anchorTs,
      stored: await historicalInitFacts(scope, typeof bounds.anchorTs === "string" ? bounds.anchorTs : "", typeof bounds.anchorTs === "string" ? bounds.anchorTs : ""),
      unrelatedUnchanged: (await rowDigestExcept(scope, CLAIM_PERMITTED)) === before,
    }, "the historical envelope [0, A] is the first segment; the claim carries its exact bounds").toEqual({
      bounds: {
        lane: "historical", requestLowerTs: null, segmentLowerTs: "0.000000", segmentUpperTs: bounds.anchorTs, anchorTs: undefined,
        scanGeneration: 0, lowerTs: null, cursorNull: true,
      },
      anchorCanonical: true, upperIsAnchor: true,
      stored: {
        anchor_is_expected: true, lower_is_floor: true, upper_is_expected: true, cursor_history_empty: true,
        attempt_oldest_null: true, newest_inactive: true,
      },
      unrelatedUnchanged: true,
    });
  });

  it("§4/§5 init: a NEW historical anchor taken from a noncanonical completed_lower_ts is stored canonically, and U = canonical(A)", async () => {
    const { scope, integrationId } = await seedUnsegmentedChannel({
      completed_lower_ts: "1718900000.1", completed_upper_ts: "1718900500.000000", next_lane: "historical",
    });
    const before = await rowDigestExcept(scope, CLAIM_PERMITTED);
    const claim = await tx((session) => claimSlackChannelPage(session, scope, { bindingIntegrationId: integrationId, bindingConfigRevision: REVISION }));
    expect({
      bounds: claimBounds(claim),
      stored: await historicalInitFacts(scope, "1718900000.100000", "1718900000.100000"),
      unrelatedUnchanged: (await rowDigestExcept(scope, CLAIM_PERMITTED)) === before,
    }, "A = canonical(completed_lower_ts) = U; the certified interval itself is untouched").toEqual({
      bounds: {
        lane: "historical", anchorTs: "1718900000.100000", requestLowerTs: null, segmentLowerTs: "0.000000", segmentUpperTs: "1718900000.100000",
        scanGeneration: 0, lowerTs: null, cursorNull: true,
      },
      stored: {
        anchor_is_expected: true, lower_is_floor: true, upper_is_expected: true, cursor_history_empty: true,
        attempt_oldest_null: true, newest_inactive: true,
      },
      unrelatedUnchanged: true,
    });
  });

  it("§4/§5 init: an ALREADY-ANCHORED uninitialized historical lane keeps its anchor bytes, and U = canonical(A)", async () => {
    const { scope, integrationId } = await seedUnsegmentedChannel({ historical_anchor_ts: "1718900400.5", next_lane: "historical" });
    const before = await rowDigestExcept(scope, CLAIM_PERMITTED);
    const claim = await tx((session) => claimSlackChannelPage(session, scope, { bindingIntegrationId: integrationId, bindingConfigRevision: REVISION }));
    expect({
      bounds: claimBounds(claim),
      stored: await historicalInitFacts(scope, "1718900400.5", "1718900400.500000"),
      unrelatedUnchanged: (await rowDigestExcept(scope, CLAIM_PERMITTED)) === before,
    }, "the preserved anchor is never re-rendered; only U is canonical").toEqual({
      bounds: {
        lane: "historical", anchorTs: "1718900400.5", requestLowerTs: null, segmentLowerTs: "0.000000", segmentUpperTs: "1718900400.500000",
        scanGeneration: 0, lowerTs: null, cursorNull: true,
      },
      stored: {
        anchor_is_expected: true, lower_is_floor: true, upper_is_expected: true, cursor_history_empty: true,
        attempt_oldest_null: true, newest_inactive: true,
      },
      unrelatedUnchanged: true,
    });
  });

  it("§4/§5 init: a historical claim preserves an ANCHORED-but-uninitialized newest lane byte for byte (A and B kept; L, S, U, C null; H empty)", async () => {
    const newest = { anchor: "1718900800.25", lower: "1718900400.5" };
    const { scope, integrationId } = await seedUnsegmentedChannel({ historical_anchor_ts: "1718900400.5", next_lane: "historical", newest });
    const before = await rowDigestExcept(scope, CLAIM_PERMITTED);
    const claim = await tx((session) => claimSlackChannelPage(session, scope, { bindingIntegrationId: integrationId, bindingConfigRevision: REVISION }));
    expect({
      bounds: claimBounds(claim),
      newest: await newestUninitializedFacts(scope, newest.anchor, newest.lower),
      unrelatedUnchanged: (await rowDigestExcept(scope, CLAIM_PERMITTED)) === before,
    }, "only the claimed historical lane is initialized; the opposite lane is untouched").toEqual({
      bounds: {
        lane: "historical", anchorTs: "1718900400.5", requestLowerTs: null, segmentLowerTs: "0.000000", segmentUpperTs: "1718900400.500000",
        scanGeneration: 0, lowerTs: null, cursorNull: true,
      },
      newest: { anchor_bytes_exact: true, lower_bytes_exact: true, bounds_null: true, cursor_history_empty: true },
      unrelatedUnchanged: true,
    });
  });

  it("§5 init: a reclaim after expiry RESUMES the initialized segment; it never reinitializes A, S, U, C, H or G", async () => {
    const { scope, integrationId } = await seedUnsegmentedChannel({ historical_anchor_ts: "1718900400.5", next_lane: "historical" });
    const first = await tx((session) => claimSlackChannelPage(session, scope, { bindingIntegrationId: integrationId, bindingConfigRevision: REVISION }));
    const firstBounds = claimBounds(first);
    const initialized = firstBounds.segmentLowerTs === "0.000000" && firstBounds.segmentUpperTs === "1718900400.500000";
    // A REAL progressed literal state, written over the initialized lane. Earlier work would have left
    // it: a terminal upper segment lowered U below A and recorded its oldest in the aggregate, a split
    // (S = M + 1) and an inner terminal each incremented G, and an accepted continuation stored a cursor.
    //  - A stays `1718900400.5`;
    //  - U = `1718900300.000000` < A, and S = `1718900100.000000` in [0, U];
    //  - the completed-segments aggregate is `1718900350.000000`, in (U, A];
    //  - attempt-oldest is `1718900200.000000`, in [S, U];
    //  - C/H are non-empty, and G = 0 + 1.
    // A reclaim that re-derived U from A, reset S, or cleared C/H/G would change one of them; a U reset
    // to A under that aggregate also fails the progress CHECK, which is why the reclaim is sanitized.
    // The write is applied ONLY to an initialized lane: on an unsegmented lane it would violate the
    // progress CHECK, which is a fixture error rather than a behavioral RED.
    if (initialized) {
      await tx((session) => session.executeSql(
        `update slack_sync_channels
            set historical_segment_lower_ts = '1718900100.000000', historical_segment_upper_ts = '1718900300.000000',
                historical_completed_segments_oldest_ts = '1718900350.000000', historical_oldest_seen_ts = '1718900200.000000',
                historical_cursor = 'syn-h-r', historical_cursor_history = '["syn-h-q", "syn-h-r"]'::jsonb,
                historical_scan_generation = historical_scan_generation + 1
          where team_id = $1`, [scope.teamId]
      ));
    }
    const afterProgress = await rowDigestExcept(scope, LEASE_BOOKKEEPING);
    await tx((session) => session.executeSql(
      "update slack_sync_channels set lease_expires_at = clock_timestamp() - interval '1 second' where team_id = $1", [scope.teamId]
    ));
    const second: unknown = await tx((session) => claimSlackChannelPage(session, scope, {
      bindingIntegrationId: integrationId, bindingConfigRevision: REVISION,
    })).catch(sanitized);
    expect({
      initialized,
      resumed: { ...claimBounds(second), cursorResumed: (second as { cursor?: unknown } | null)?.cursor === "syn-h-r" },
      laneUnchanged: (await rowDigestExcept(scope, LEASE_BOOKKEEPING)) === afterProgress,
    }, "the reclaim carries the progressed A, S, U, G and cursor; only the lease bookkeeping moves").toEqual({
      initialized: true,
      resumed: {
        lane: "historical", anchorTs: "1718900400.5", requestLowerTs: null,
        segmentLowerTs: "1718900100.000000", segmentUpperTs: "1718900300.000000",
        scanGeneration: 1, lowerTs: null, cursorNull: false, cursorResumed: true,
      },
      laneUnchanged: true,
    });
  });

  it("§5 init control: a claim of an EXISTING narrower segment with a stored cursor preserves it and carries its exact bounds", async () => {
    const seeded = await seedSingletonSegment(["syn-h-1"]);
    const before = await rowDigestExcept(seeded.scope, LEASE_BOOKKEEPING);
    const claim = await claimHistorical(seeded);
    expect({ bounds: claimBounds(claim), laneUnchanged: (await rowDigestExcept(seeded.scope, LEASE_BOOKKEEPING)) === before },
      "an initialized segment is resumed exactly").toEqual({
      bounds: {
        lane: "historical", anchorTs: HISTORICAL_ANCHOR, requestLowerTs: null, segmentLowerTs: HISTORICAL_ANCHOR, segmentUpperTs: HISTORICAL_ANCHOR,
        scanGeneration: 4, lowerTs: null, cursorNull: false,
      },
      laneUnchanged: true,
    });
  });

  it("§5 init control: an INELIGIBLE row (not public) is not claimed and not initialized; it is byte-identical", async () => {
    const { scope, integrationId } = await seedUnsegmentedChannel({ public_state: "private", historical_anchor_ts: "1718900400.5", next_lane: "historical" });
    const before = await rowDigestExcept(scope, []);
    const claim = await tx((session) => claimSlackChannelPage(session, scope, { bindingIntegrationId: integrationId, bindingConfigRevision: REVISION }));
    expect({ claim, rowUnchanged: (await rowDigestExcept(scope, [])) === before }, "eligibility precedes initialization").toEqual({
      claim: null, rowUnchanged: true,
    });
  });

  // ── PACKET 3: claim-time segment initialization, NEWEST lane, direct claim (§4, §5) ─────────────

  it.each([
    { label: "a 90-second allowance", allowanceMs: 90_000, literalL: "1718899910.123456" },
    { label: "an allowance larger than the epoch, clamped at zero", allowanceMs: 100 * 365 * 24 * 60 * 60 * 1000, literalL: "0.000000" },
  ])("§5 newest init: the FIRST newest claim freezes B by the existing rule and initializes L = S = max(0, B − allowance), U = A, C = null, H = [] ($label)", async ({ allowanceMs, literalL }) => {
    const B = "1718900000.123456";
    const { scope, integrationId } = await seedNewestCandidate({
      completed_lower_ts: "1718800000.000001", completed_upper_ts: B, historical_floor_reached: true,
    });
    const L = boundMinusAllowance(B, BigInt(allowanceMs));
    expect(L, "fixture: the independent BigInt oracle agrees with the stated literal").toBe(literalL);
    const before = await rowDigestExcept(scope, NEWEST_CLAIM_PERMITTED);
    const claim = await claimNewest(scope, integrationId, allowanceMs);
    const bounds = claimBounds(claim);
    const anchor = typeof bounds.anchorTs === "string" ? bounds.anchorTs : "";
    expect({
      bounds: { ...bounds, anchorTs: undefined, segmentUpperTs: undefined },
      anchorCanonical: CANONICAL_BOUND.test(anchor),
      upperIsAnchor: bounds.segmentUpperTs === bounds.anchorTs,
      stored: await newestInitFacts(scope, { anchor, lower: B, requestLower: L, upper: anchor }),
      unrelatedUnchanged: (await rowDigestExcept(scope, NEWEST_CLAIM_PERMITTED)) === before,
    }, "B is the certified top; [L, A] is the first newest segment; the historical lane and all else are exact").toEqual({
      bounds: {
        lane: "newest", anchorTs: undefined, segmentUpperTs: undefined,
        lowerTs: B, requestLowerTs: L, segmentLowerTs: L, scanGeneration: 0, cursorNull: true,
      },
      anchorCanonical: true, upperIsAnchor: true,
      stored: { anchor_is_expected: true, lower_is_expected: true, request_lower_is_expected: true, segment_is_expected: true, cursor_history_empty: true },
      unrelatedUnchanged: true,
    });
  });

  it("§4/§5 newest init: an ANCHORED-but-uninitialized newest lane keeps its A and B bytes, and only U is canonical; an in-progress historical lane is untouched", async () => {
    const { scope, integrationId } = await seedNewestCandidate({
      newest_anchor_ts: "1718900800.25", newest_lower_ts: "1718900400.5", newest_scan_generation: 2,
      historical_anchor_ts: "1718900400.5", historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "1718900400.500000",
      historical_cursor: "syn-h-1", historical_cursor_history: ["syn-h-1"], historical_scan_generation: 3,
    });
    const L = boundMinusAllowance("1718900400.5", BigInt(60_000));
    expect(L, "fixture: oracle").toBe("1718900340.500000");
    const before = await rowDigestExcept(scope, NEWEST_CLAIM_PERMITTED);
    const claim = await claimNewest(scope, integrationId, 60_000);
    expect({
      bounds: claimBounds(claim),
      stored: await newestInitFacts(scope, { anchor: "1718900800.25", lower: "1718900400.5", requestLower: L, upper: "1718900800.250000" }),
      unrelatedUnchanged: (await rowDigestExcept(scope, NEWEST_CLAIM_PERMITTED)) === before,
    }, "existing A/B are never re-rendered; U = canonical(A); the opposite lane is byte-identical").toEqual({
      bounds: {
        lane: "newest", anchorTs: "1718900800.25", lowerTs: "1718900400.5", requestLowerTs: L,
        segmentLowerTs: L, segmentUpperTs: "1718900800.250000", scanGeneration: 2, cursorNull: true,
      },
      stored: { anchor_is_expected: true, lower_is_expected: true, request_lower_is_expected: true, segment_is_expected: true, cursor_history_empty: true },
      unrelatedUnchanged: true,
    });
  });

  it("§5 newest init: a reclaim RESUMES a progressed cursor-null post-split newest segment (S > L, G + 1) and never reinitializes it, even under a different allowance", async () => {
    const B = "1718900000.123456";
    const { scope, integrationId } = await seedNewestCandidate({
      completed_lower_ts: "1718800000.000001", completed_upper_ts: B, historical_floor_reached: true,
    });
    const L = boundMinusAllowance(B, BigInt(60_000));
    const first = claimBounds(await claimNewest(scope, integrationId, 60_000));
    const initialized = first.requestLowerTs === L && first.segmentLowerTs === L && first.segmentUpperTs === first.anchorTs;
    // A valid post-progress literal state, of the kind later progress could leave:
    //  - S = `1718899970.000000`, chosen inside (L, U] (it is not computed by the midpoint formula);
    //  - U and A unchanged;
    //  - C null, H empty, G + 1.
    // Written ONLY over an initialized lane, because S without L and U violates the progress CHECK and
    // would be a fixture error, not a behavioral RED.
    if (initialized) {
      await tx((session) => session.executeSql(
        `update slack_sync_channels
            set newest_segment_lower_ts = '1718899970.000000', newest_scan_generation = newest_scan_generation + 1
          where team_id = $1`, [scope.teamId]
      ));
    }
    const afterProgress = await rowDigestExcept(scope, LEASE_BOOKKEEPING);
    await tx((session) => session.executeSql(
      "update slack_sync_channels set lease_expires_at = clock_timestamp() - interval '1 second' where team_id = $1", [scope.teamId]
    ));
    // A DIFFERENT allowance on the reclaim: the frozen L must not follow it.
    const second = claimBounds(await claimNewest(scope, integrationId, 30_000));
    expect({
      initialized, second,
      laneUnchanged: (await rowDigestExcept(scope, LEASE_BOOKKEEPING)) === afterProgress,
    }, "the reclaim carries the progressed A, B, L, S, U and G; only the lease bookkeeping moves").toEqual({
      initialized: true,
      second: {
        lane: "newest", anchorTs: first.anchorTs, lowerTs: B, requestLowerTs: L,
        segmentLowerTs: "1718899970.000000", segmentUpperTs: first.anchorTs, scanGeneration: 1, cursorNull: true,
      },
      laneUnchanged: true,
    });
  });

  it("§5 newest init control: an INELIGIBLE row (not public) with an anchored newest lane is not claimed and not initialized; it is byte-identical", async () => {
    const { scope, integrationId } = await seedNewestCandidate({
      public_state: "private", newest_anchor_ts: "1718900800.25", newest_lower_ts: "1718900400.5",
      completed_lower_ts: "1718800000.000001", completed_upper_ts: "1718900400.5", historical_floor_reached: true,
    });
    const before = await rowDigestExcept(scope, []);
    const claim = await claimNewest(scope, integrationId, 60_000);
    expect({ claim, rowUnchanged: (await rowDigestExcept(scope, [])) === before }, "eligibility precedes initialization").toEqual({
      claim: null, rowUnchanged: true,
    });
  });

  it.each([
    {
      label: "an already-ANCHORED newest lane whose frozen B lies above A + allowance",
      over: {
        newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900900.000000",
        completed_lower_ts: "1718800000.000001", completed_upper_ts: "1718900000.000000", historical_floor_reached: true,
      },
    },
    {
      label: "an IDLE newest lane whose certified top lies in the far future",
      over: { completed_lower_ts: "1718800000.000001", completed_upper_ts: "4102444800.000000", historical_floor_reached: true },
    },
  ])("§5 newest init: candidate L > A ($label) is typed delayed / scan_bounds_invalid; no lease, attempt, anchor, generation, progress or certificate moves", async ({ over }) => {
    const { scope, integrationId } = await seedNewestCandidate(over);
    const before = await rowDigestExcept(scope, L_ABOVE_A_PERMITTED);
    // Database-clock bounds taken immediately around the claim's own transaction.
    const clockBefore = await dbClockText();
    const result = await claimNewest(scope, integrationId, 60_000);
    const clockAfter = await dbClockText();
    expect({
      outcome: typedOutcome(result),
      unchanged: (await rowDigestExcept(scope, L_ABOVE_A_PERMITTED)) === before,
      bookkeeping: await delayBookkeeping(scope, clockBefore, clockAfter),
    }, "only next_lane (to the opposite lane), the diagnostic, due_at and updated_at may change, the last two to the DB clock").toEqual({
      outcome: { outcome: "delayed", category: "scan_bounds_invalid", detail: "The scan bounds are inconsistent; no provider request was sent." },
      unchanged: true,
      bookkeeping: {
        next_lane: "historical", last_error_code: "scan_bounds_invalid", lease_absent: true,
        due_in_window: true, updated_in_window: true,
      },
    });
  });

  it.each([
    { label: "a private row", sql: "update slack_sync_channels set public_state = 'private' where team_id = $1" },
    { label: "a future due_at", sql: "update slack_sync_channels set due_at = clock_timestamp() + interval '1 hour' where team_id = $1" },
    {
      label: "a live competing lease",
      sql: `update slack_sync_channels
               set lease_owner = 'competing-owner', lease_expires_at = clock_timestamp() + interval '5 minutes', claimed_lane = 'newest'
             where team_id = $1`,
    },
    { label: "a stale binding revision", sql: `update slack_sync_channels set binding_config_revision = '${OTHER_REVISION}' where team_id = $1` },
  ])("§5 newest init control: ELIGIBILITY precedes the L > A evaluation — $label is not claimed, not delayed, and byte-identical", async ({ sql }) => {
    // The same CHECK-valid L > A candidate as the anchored RED above, made ineligible after seeding.
    const { scope, integrationId } = await seedNewestCandidate({
      newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900900.000000",
      completed_lower_ts: "1718800000.000001", completed_upper_ts: "1718900000.000000", historical_floor_reached: true,
    });
    await tx((session) => session.executeSql(sql, [scope.teamId]));
    const before = await rowDigestExcept(scope, []);
    const claim = await claimNewest(scope, integrationId, 60_000);
    expect({ claim, rowUnchanged: (await rowDigestExcept(scope, [])) === before },
      "an ineligible row returns null with no delay bookkeeping").toEqual({ claim: null, rowUnchanged: true });
  });

  // PACKET 8e: the binding INTEGRATION alone. The same CHECK-valid L > A anchored candidate is rebound
  // to a SECOND valid Slack integration of the same team, at the SAME revision, and then claimed with the
  // OLD integration id. Only the locking read's integration predicate makes it ineligible: an ordinary
  // valid-bounds candidate would not discriminate it, because the claim UPDATE repeats the predicate,
  // but the L > A delay is decided by the locking read alone.
  it("§5 newest init control: ELIGIBILITY precedes the L > A evaluation — a row rebound to a second valid Slack integration at the same revision is not claimed by the old integration, not delayed, and byte-identical", async () => {
    const { scope, integrationId } = await seedNewestCandidate({
      newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900900.000000",
      completed_lower_ts: "1718800000.000001", completed_upper_ts: "1718900000.000000", historical_floor_reached: true,
    });
    const otherIntegrationId = await tx(async (session) => (await session.executeSql<{ id: string }>(
      `insert into integrations (team_id, type, name) values ($1, 'slack', 'newest-init-second-binder') returning id::text as id`, [scope.teamId]
    )).rows[0].id);
    await tx((session) => session.executeSql(
      "update slack_sync_channels set binding_integration_id = $2::uuid where team_id = $1", [scope.teamId, otherIntegrationId]
    ));
    expect(await tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select s.binding_integration_id = $2::uuid as rebound, s.binding_config_revision = $3 as revision_kept,
              s.binding_integration_id <> $4::uuid as old_binding_gone,
              i.type = 'slack' and i.team_id = s.team_id as second_integration_valid,
              s.public_state = 'public' and s.due_at <= clock_timestamp() and s.lease_owner is null as otherwise_eligible
         from slack_sync_channels s join integrations i on i.id = s.binding_integration_id
        where s.team_id = $1`,
      [scope.teamId, otherIntegrationId, REVISION, integrationId]
    )).rows[0]), "fixture: only the binding integration moved, to a second valid Slack integration, at the same revision").toEqual({
      rebound: true, revision_kept: true, old_binding_gone: true, second_integration_valid: true, otherwise_eligible: true,
    });
    const before = await rowDigestExcept(scope, []);
    const claim = await claimNewest(scope, integrationId, 60_000);
    expect({ claim, rowUnchanged: (await rowDigestExcept(scope, [])) === before },
      "a claim under the old integration finds no eligible row: null, with no delay bookkeeping").toEqual({ claim: null, rowUnchanged: true });
  });

  // ── PACKET 4a: direct claim safety (default, invalid and out-of-domain allowance/bounds) ───────────

  it("§5 claim safety: an OMITTED skewAllowanceMs is exactly 60,000 ms (independent BigInt oracle)", async () => {
    const B = "1718900000.123456";
    const { scope, integrationId } = await seedNewestCandidate({
      completed_lower_ts: "1718800000.000001", completed_upper_ts: B, historical_floor_reached: true,
    });
    const L = boundMinusAllowance(B, BigInt(60_000));
    expect(L, "fixture: oracle").toBe("1718899940.123456");
    const claim = await tx((session) => claimSlackChannelPage(session, scope, { bindingIntegrationId: integrationId, bindingConfigRevision: REVISION }))
      .catch(sanitized);
    const bounds = claimBounds(claim);
    expect({ ...bounds, anchorTs: undefined, segmentUpperTs: undefined, upperIsAnchor: bounds.segmentUpperTs === bounds.anchorTs },
      "the default allowance initializes L = S = B − 60 s and U = A").toEqual({
      lane: "newest", anchorTs: undefined, segmentUpperTs: undefined, upperIsAnchor: true,
      lowerTs: B, requestLowerTs: L, segmentLowerTs: L, scanGeneration: 0, cursorNull: true,
    });
  });

  it.each([
    { label: "zero", value: 0 },
    { label: "negative", value: -60_000 },
    { label: "fractional", value: 1.5 },
    { label: "unsafe", value: Number.MAX_SAFE_INTEGER + 1 },
    { label: "NaN", value: Number.NaN },
    { label: "infinite", value: Number.POSITIVE_INFINITY },
  ])("§5 claim safety: a $label skewAllowanceMs fails with the fixed static error and commits no mutation", async ({ value }) => {
    const { scope, integrationId } = await seedNewestCandidate({
      completed_lower_ts: "1718800000.000001", completed_upper_ts: "1718900000.123456", historical_floor_reached: true,
    });
    const before = await rowDigestExcept(scope, []);
    const failure = await claimFailure(scope, integrationId, value);
    expect({ failure, rowUnchanged: (await rowDigestExcept(scope, [])) === before }, "the transaction rolls back; nothing is committed").toEqual({
      failure: { name: "SlackChannelStateError", message: "slack channel state: skewAllowanceMs must be a positive whole number of milliseconds" },
      rowUnchanged: true,
    });
  });

  it.each([
    {
      label: "an IDLE newest lane whose schema-permitted certified top has 15 second digits",
      over: { completed_lower_ts: "1718800000.000001", completed_upper_ts: "999999999999999.000000", historical_floor_reached: true },
      canary: "999999999999999",
    },
    {
      label: "an ANCHORED newest lane whose schema-permitted B has 15 second digits",
      over: {
        newest_anchor_ts: "1718900800.000000", newest_lower_ts: "888888888888888.5",
        completed_lower_ts: "1718800000.000001", completed_upper_ts: "1718900000.000000", historical_floor_reached: true,
      },
      canary: "888888888888888",
    },
    {
      label: "an ANCHORED newest lane whose schema-permitted A has 13 second digits",
      over: {
        newest_anchor_ts: "7777777777777.25", newest_lower_ts: "1718900400.5",
        completed_lower_ts: "1718800000.000001", completed_upper_ts: "1718900000.000000", historical_floor_reached: true,
      },
      canary: "7777777777777",
    },
  ])("§4/§5 claim safety: $label fails closed with the fixed bound-free error, and the row is byte-identical", async ({ over, canary }) => {
    const { scope, integrationId } = await seedNewestCandidate(over);
    const before = await rowDigestExcept(scope, []);
    const failure = await claimFailure(scope, integrationId, 60_000);
    expect({
      failure,
      leaksBound: JSON.stringify(failure).includes(canary),
      rowUnchanged: (await rowDigestExcept(scope, [])) === before,
    }, "a corrupt or out-of-domain stored bound is corruption, never a delay or a claim").toEqual({
      failure: { name: "SlackChannelStateError", message: "slack channel state: the newest lane's stored bounds are not exact supported timestamps — refusing to claim it" },
      leaksBound: false,
      rowUnchanged: true,
    });
  });

  // ── PACKET 6a: the restart writer on an actual provider invalid_cursor (§5, DH-03, F2-08) ───────
  // The SAME exported `restartSlackChannelScan`, extended (not replaced) to distinguish:
  //  - `subdivided`: S < U, the midpoint transition;
  //  - `restarted`: S = U, the same-range restart;
  //  - `refused`: a stale or moved fence.
  // The result goes through the file's no-leak projection (`project`/`returnedLeak`), so a leaking
  // result fails as `leaked: true`. Every row fact is a boolean.

  /** Restart under the claim; the result is projected and leak-checked (exceptions are sanitized). */
  async function restartOutcome(claim: SlackChannelClaim): Promise<Record<string, unknown>> {
    const result = await tx((session) => restartSlackChannelScan(session, claim, { errorCode: "invalid_cursor" })).catch(sanitized);
    const projected = project(result);
    return { outcome: projected.outcome, leaked: projected.leaked === true };
  }
  /** Columns a historical invalid_cursor transition may change: lane C/H/attempt-oldest/G, S, and release. */
  const INVALID_CURSOR_PERMITTED = [
    "historical_cursor", "historical_cursor_history", "historical_oldest_seen_ts", "historical_scan_generation",
    "historical_segment_lower_ts", ...RELEASE_PERMITTED,
  ];
  /**
   * CONSTRUCTED, CHECK-valid progressed literals under the seeded A = `1718900500.000000`. They are
   * written directly; they are not reached here by the normal split/terminal transitions.
   *  - Wide: S < U < A, with attempt-oldest in [S, U] and the completed-segments aggregate in (U, A].
   *  - Singleton: S = U < A, with attempt-oldest equal to U and the aggregate above U.
   */
  const PROGRESSED = {
    wide: { lower: "1718900100.000000", upper: "1718900300.000000", aggregate: "1718900350.000000", attemptOldest: "1718900200.000000" },
    singleton: { lower: "1718900300.000000", upper: "1718900300.000000", aggregate: "1718900350.000000", attemptOldest: "1718900300.000000" },
  } as const;
  /** Seed the wide fixture, then write the progressed literal and assert it as a separate PRECONDITION. */
  async function seedProgressed(width: "wide" | "singleton"): Promise<Seeded> {
    // The older H entry makes the result's no-leak check LIVE.
    const seeded = await seedWideSegment([OLDER_ENTRY, "syn-h-2"]);
    const p = PROGRESSED[width];
    await tx((session) => session.executeSql(
      `update slack_sync_channels
          set historical_segment_lower_ts = $2, historical_segment_upper_ts = $3,
              historical_completed_segments_oldest_ts = $4, historical_oldest_seen_ts = $5
        where team_id = $1`,
      [seeded.scope.teamId, p.lower, p.upper, p.aggregate, p.attemptOldest]
    ));
    const facts = await tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select historical_segment_lower_ts = $2 and historical_segment_upper_ts = $3 as bounds_seeded,
              historical_completed_segments_oldest_ts = $4 as aggregate_seeded,
              historical_oldest_seen_ts = $5 as attempt_oldest_seeded,
              historical_cursor is not null and historical_anchor_ts = $6 as cursor_and_anchor
         from slack_sync_channels where team_id = $1`,
      [seeded.scope.teamId, p.lower, p.upper, p.aggregate, p.attemptOldest, HISTORICAL_ANCHOR]
    )).rows[0]);
    expect(facts, `fixture: the progressed ${width} literal is stored`).toEqual({
      bounds_seeded: true, aggregate_seeded: true, attempt_oldest_seeded: true, cursor_and_anchor: true,
    });
    return seeded;
  }
  /** Booleans about the historical lane after a restart, against literal expectations (no values printed). */
  async function restartFacts(scope: SlackChannelScope, expected: { lower: string; upper: string; aggregate: string; generation: number }) {
    return tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select historical_segment_lower_ts is not distinct from $4 as lower_is_expected,
              historical_segment_upper_ts is not distinct from $5 as upper_kept_not_reset_to_anchor,
              historical_anchor_ts is not distinct from $7 as anchor_kept,
              historical_completed_segments_oldest_ts is not distinct from $8 as aggregate_byte_identical,
              historical_cursor is null and historical_cursor_history = '[]'::jsonb as cursor_history_cleared,
              historical_oldest_seen_ts is null as attempt_oldest_cleared,
              historical_scan_generation = $6::bigint as generation_is_expected,
              lease_owner is null and claimed_lane is null as released, next_lane, last_error_code
         from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
      [scope.teamId, scope.workspaceId, scope.channelId, expected.lower, expected.upper, expected.generation, HISTORICAL_ANCHOR, expected.aggregate]
    )).rows[0]);
  }
  const RESTART_FACTS_EXPECTED = {
    lower_is_expected: true, upper_kept_not_reset_to_anchor: true, anchor_kept: true, aggregate_byte_identical: true,
    cursor_history_cleared: true, attempt_oldest_cleared: true, generation_is_expected: true, released: true,
    next_lane: "newest", last_error_code: "invalid_cursor",
  };

  it("§5 invalid_cursor RED: on a PROGRESSED WIDE segment the restart writer SUBDIVIDES at the exact midpoint (independent BigInt oracle)", async () => {
    const seeded = await seedProgressed("wide");
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(seeded.scope, INVALID_CURSOR_PERMITTED);
    // M = floor((S + U) / 2) in ticks, then S = M + 1, from the literal S and U.
    const midpointPlusOne = renderTicks((exactOracleTicks(PROGRESSED.wide.lower) + exactOracleTicks(PROGRESSED.wide.upper)) / BigInt(2) + BigInt(1));
    expect(midpointPlusOne, "fixture: oracle").toBe("1718900200.000001");
    const outcome = await restartOutcome(claim);
    expect({
      outcome,
      facts: await restartFacts(seeded.scope, { lower: midpointPlusOne, upper: PROGRESSED.wide.upper, aggregate: PROGRESSED.wide.aggregate, generation: 5 }),
      unrelatedUnchanged: (await rowDigestExcept(seeded.scope, INVALID_CURSOR_PERMITTED)) === before,
    }, "S = M + 1; U (not A), L, A, the aggregate, the certificate and the newest lane preserved; C/H/attempt-oldest cleared; G + 1; released").toEqual({
      outcome: { outcome: "subdivided", leaked: false },
      facts: RESTART_FACTS_EXPECTED,
      unrelatedUnchanged: true,
    });
  });

  it("§5 invalid_cursor RED: on a PROGRESSED SINGLETON segment the restart writer is a same-range RESTART", async () => {
    const seeded = await seedProgressed("singleton");
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(seeded.scope, INVALID_CURSOR_PERMITTED);
    const outcome = await restartOutcome(claim);
    expect({
      outcome,
      facts: await restartFacts(seeded.scope, {
        lower: PROGRESSED.singleton.lower, upper: PROGRESSED.singleton.upper, aggregate: PROGRESSED.singleton.aggregate, generation: 5,
      }),
      unrelatedUnchanged: (await rowDigestExcept(seeded.scope, INVALID_CURSOR_PERMITTED)) === before,
    }, "every bound kept (U is not reset to A); the aggregate byte-identical; C/H/attempt-oldest cleared; G + 1; released").toEqual({
      outcome: { outcome: "restarted", leaked: false },
      facts: RESTART_FACTS_EXPECTED,
      unrelatedUnchanged: true,
    });
  });

  // The COMPLETE historical fence (`channelFence`), one row per component, each applied AFTER the claim.
  // Each mutation changes the live row, so the oracle is the POST-mutation row: the attempted restart
  // must leave it byte-identical.
  it.each([
    { label: "segment LOWER bound moved", mutate: sqlMutation("update slack_sync_channels set historical_segment_lower_ts = '1718900000.000000' where team_id = $1") },
    { label: "segment UPPER bound moved", mutate: sqlMutation("update slack_sync_channels set historical_segment_upper_ts = '1718900400.000000' where team_id = $1") },
    { label: "public proof revoked", mutate: REVOKE_PUBLIC },
    { label: "binding integration changed", mutate: OTHER_BINDER },
    { label: "binding config revision changed", mutate: sqlMutation(`update slack_sync_channels set binding_config_revision = '${OTHER_REVISION}' where team_id = $1`) },
    { label: "lease expired", mutate: EXPIRE_LEASE },
    { label: "successor reclaimed after expiry", mutate: SUCCESSOR_RECLAIM },
    { label: "lease generation bumped alone", mutate: sqlMutation("update slack_sync_channels set lease_generation = lease_generation + 1 where team_id = $1") },
    { label: "lease owner changed alone", mutate: sqlMutation("update slack_sync_channels set lease_owner = gen_random_uuid()::text where team_id = $1") },
    { label: "claimed lane changed", mutate: sqlMutation("update slack_sync_channels set claimed_lane = 'newest' where team_id = $1") },
    { label: "scan generation drifted", mutate: sqlMutation("update slack_sync_channels set historical_scan_generation = 5 where team_id = $1") },
    {
      label: "cursor drifted",
      // Linkage stays valid: the older entry is kept and the drifted cursor is H's last element.
      mutate: sqlMutation(`update slack_sync_channels set historical_cursor = 'syn-h-x', historical_cursor_history = '["${OLDER_ENTRY}", "syn-h-2", "syn-h-x"]'::jsonb where team_id = $1`),
    },
    { label: "anchor drifted", mutate: sqlMutation("update slack_sync_channels set historical_anchor_ts = '1718900600.000000' where team_id = $1") },
  ])("§5/§8 invalid_cursor fence: with $label, the restart writer returns typed refused and the live row is exact", async ({ mutate }) => {
    // The older H entry makes the result's no-leak check LIVE: a result carrying H would fail it.
    const seeded = await seedWideSegment([OLDER_ENTRY, "syn-h-2"]);
    const claim = await claimHistorical(seeded);
    await mutate(seeded);
    const before = await rowDigestExcept(seeded.scope, []);
    const outcome = await restartOutcome(claim);
    expect({ outcome, rowUnchanged: (await rowDigestExcept(seeded.scope, [])) === before },
      "the invalid_cursor transition is fenced exactly like acceptance").toEqual({
      outcome: { outcome: "refused", leaked: false }, rowUnchanged: true,
    });
  });

  // ── PACKET 8a: the historical INNER terminal (S > L), DH-04/DH-05 ─────────────────────────────────
  // A CONSTRUCTED, CHECK-valid literal, written directly; it is not reached here by a provider
  // traversal. L = 0 (historical), S = 61.000100, U = 61.000109 (W = 10), A = 61.000199, a prior
  // completed-segments aggregate 61.000150 in (U, A], and an attempt-oldest 61.000105 in [S, U]. A
  // genuinely terminal page with oldest 61.000107 then finishes ONLY this inner segment:
  //  - next segment [max(L, S − 2W), S − 1] = [61.000080, 61.000099] (adjacent, doubled);
  //  - aggregate = oldest of (61.000150, 61.000105, 61.000107) = 61.000105, still above the next U;
  //  - anchor kept, attempt-oldest/C/H cleared, G + 1, the turn passed, and NO coverage field moved.

  const INNER = {
    anchor: "61.000199", lower: "61.000100", upper: "61.000109",
    aggregate: "61.000150", attemptOldest: "61.000105", pageOldest: "61.000107",
  } as const;
  /** Columns an inner terminal may change: the lane's segment, C/H, attempt-oldest, aggregate, G, and the release. */
  const INNER_TERMINAL_PERMITTED = [
    "historical_segment_lower_ts", "historical_segment_upper_ts", "historical_cursor", "historical_cursor_history",
    "historical_oldest_seen_ts", "historical_completed_segments_oldest_ts", "historical_scan_generation",
    "next_lane", "claimed_lane", "lease_owner", "lease_expires_at", "last_error_code", "last_read_at", "due_at", "updated_at",
  ];

  /**
   * Accept one page in ONE transaction, projected like `admit` but KEEPING the written outcome's
   * `completion` (segment or envelope). Any exception is sanitized, so it is never a typed outcome.
   */
  async function admitKeepingCompletion(claim: SlackChannelClaim, page: Page): Promise<Record<string, unknown>> {
    try {
      return await tx(async (session) => {
        const accepted = await acceptSlackChannelPage(session, claim, page);
        const completion = (accepted as unknown as { completion?: unknown }).completion;
        return { ...project(accepted), completion: typeof completion === "string" ? completion : null };
      });
    } catch (error) {
      return sanitized(error);
    }
  }

  it("§5 inner terminal (S > L) / DH-04/DH-05: a historical TERMINAL page on an INNER segment stores the exact adjacent doubled next segment, merges the aggregate, keeps the anchor and certifies nothing", async () => {
    // The older H entry makes the outcome's no-leak check LIVE.
    const seeded = await seedWideSegment([OLDER_ENTRY, "syn-h-2"]);
    await tx((session) => session.executeSql(
      `update slack_sync_channels
          set historical_anchor_ts = $2, historical_segment_lower_ts = $3, historical_segment_upper_ts = $4,
              historical_completed_segments_oldest_ts = $5, historical_oldest_seen_ts = $6, last_error_code = 'prior_failure'
        where team_id = $1`,
      [seeded.scope.teamId, INNER.anchor, INNER.lower, INNER.upper, INNER.aggregate, INNER.attemptOldest]
    ));
    expect(await tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select historical_anchor_ts = $2 and historical_segment_lower_ts = $3 and historical_segment_upper_ts = $4 as bounds_seeded,
              historical_completed_segments_oldest_ts = $5 and historical_oldest_seen_ts = $6 as progress_seeded,
              completed_lower_ts is null and completed_upper_ts is null and newest_catchup_upper_ts is null
                and not historical_floor_reached as uncertified,
              historical_cursor is not null and last_error_code = 'prior_failure' as cursor_and_diagnostic
         from slack_sync_channels where team_id = $1`,
      [seeded.scope.teamId, INNER.anchor, INNER.lower, INNER.upper, INNER.aggregate, INNER.attemptOldest]
    )).rows[0]), "fixture: the constructed inner-segment literal is stored").toEqual({
      bounds_seeded: true, progress_seeded: true, uncertified: true, cursor_and_diagnostic: true,
    });

    // The test's OWN oracle: W = U − S + 1; next = [max(0, S − 2W), S − 1]; aggregate = the oldest of three.
    const S = exactOracleTicks(INNER.lower);
    const width = exactOracleTicks(INNER.upper) - S + BigInt(1);
    const doubled = S - BigInt(2) * width;
    const oracle = {
      nextLower: renderTicks(doubled > BigInt(0) ? doubled : BigInt(0)),
      nextUpper: renderTicks(S - BigInt(1)),
      aggregate: [INNER.aggregate, INNER.attemptOldest, INNER.pageOldest].reduce((a, b) => (exactOracleTicks(a) <= exactOracleTicks(b) ? a : b)),
    };
    expect(oracle, "fixture: oracle").toEqual({ nextLower: "61.000080", nextUpper: "61.000099", aggregate: "61.000105" });

    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(seeded.scope, INNER_TERMINAL_PERMITTED);
    const outcome = await admitKeepingCompletion(claim, { terminal: true, nextCursor: null, oldestTs: INNER.pageOldest });
    const facts = await tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select historical_segment_lower_ts is not distinct from $4 as next_lower_is_canonical,
              historical_segment_upper_ts is not distinct from $5 as next_upper_is_adjacent,
              historical_anchor_ts is not distinct from $6 as anchor_retained,
              historical_completed_segments_oldest_ts is not distinct from $7 as aggregate_merged,
              historical_oldest_seen_ts is null as attempt_oldest_cleared,
              historical_cursor is null and historical_cursor_history = '[]'::jsonb as cursor_history_cleared,
              historical_scan_generation::int as generation,
              completed_lower_ts is null and completed_upper_ts is null and newest_catchup_upper_ts is null
                and not historical_floor_reached as nothing_certified,
              next_lane, lease_owner is null and lease_expires_at is null and claimed_lane is null as released,
              last_error_code, last_read_at is not null as last_read_set
         from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
      [seeded.scope.teamId, seeded.scope.workspaceId, seeded.scope.channelId, oracle.nextLower, oracle.nextUpper, INNER.anchor, oracle.aggregate]
    )).rows[0]);
    expect({
      outcome, facts,
      newestLaneUnchanged: await newestLaneExact(seeded.scope),
      unrelatedUnchanged: (await rowDigestExcept(seeded.scope, INNER_TERMINAL_PERMITTED)) === before,
    }, "an inner terminal finishes only its segment: exact adjacent doubled next bounds, merged aggregate, anchor kept, nothing certified, turn passed").toEqual({
      outcome: { outcome: "written", completion: "segment" },
      facts: {
        next_lower_is_canonical: true, next_upper_is_adjacent: true, anchor_retained: true, aggregate_merged: true,
        attempt_oldest_cleared: true, cursor_history_cleared: true, generation: 5, nothing_certified: true,
        next_lane: "newest", released: true, last_error_code: null, last_read_set: true,
      },
      newestLaneUnchanged: true,
      unrelatedUnchanged: true,
    });
  });

  // ── PACKET 8b: exact bigint midpoints just below the maximum epoch, DH-04 ─────────────────────────
  // A CONSTRUCTED, CHECK-valid literal, written directly; it is not reached here by a provider
  // traversal. A = 253402300799.999999 (the largest supported instant), S = …999800, U = …999900,
  // a completed-segments aggregate …999950 in (U, A] and an attempt-oldest …999850 in [S, U]. Here
  // S + U exceeds 2^53 microsecond ticks, so only exact bigint arithmetic gives M + 1 = …999851.
  // H is 1,000 distinct entries (the entry cap) whose FIRST is the older entry, so every returned
  // value's no-leak check is live, and whose last is the cursor.

  const HIGH_EPOCH = {
    anchor: "253402300799.999999", lower: "253402300799.999800", upper: "253402300799.999900",
    aggregate: "253402300799.999950", attemptOldest: "253402300799.999850", pageOldest: "253402300799.999870",
  } as const;
  /** 1,000 distinct entries: the older entry first, then `cap001`…`cap999`; the cursor is the last. */
  const highEpochHistory = (): string[] => [OLDER_ENTRY, ...entryCapHistory().slice(1)];
  /** The capacity subdivision may change exactly what the invalid_cursor subdivision may: S, C/H, attempt-oldest, G and the release. */
  const CAPACITY_SUBDIVISION_PERMITTED = INVALID_CURSOR_PERMITTED;

  /** Seed the wide fixture at the entry cap, then write the high-epoch literal and assert it as a PRECONDITION. */
  async function seedHighEpoch(): Promise<Seeded> {
    const seeded = await seedWideSegment(highEpochHistory());
    await tx((session) => session.executeSql(
      `update slack_sync_channels
          set historical_anchor_ts = $2, historical_segment_lower_ts = $3, historical_segment_upper_ts = $4,
              historical_completed_segments_oldest_ts = $5, historical_oldest_seen_ts = $6
        where team_id = $1`,
      [seeded.scope.teamId, HIGH_EPOCH.anchor, HIGH_EPOCH.lower, HIGH_EPOCH.upper, HIGH_EPOCH.aggregate, HIGH_EPOCH.attemptOldest]
    ));
    expect(await tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select historical_anchor_ts = $2 and historical_segment_lower_ts = $3 and historical_segment_upper_ts = $4 as bounds_seeded,
              historical_completed_segments_oldest_ts = $5 and historical_oldest_seen_ts = $6 as progress_seeded,
              pg_catalog.jsonb_array_length(historical_cursor_history)::int as entries,
              (historical_cursor_history -> -1) = pg_catalog.to_jsonb(historical_cursor) as linked,
              completed_lower_ts is null and completed_upper_ts is null and newest_catchup_upper_ts is null
                and not historical_floor_reached as uncertified
         from slack_sync_channels where team_id = $1`,
      [seeded.scope.teamId, HIGH_EPOCH.anchor, HIGH_EPOCH.lower, HIGH_EPOCH.upper, HIGH_EPOCH.aggregate, HIGH_EPOCH.attemptOldest]
    )).rows[0]), "fixture: the high-epoch literal is stored at the entry cap, linked and uncertified").toEqual({
      bounds_seeded: true, progress_seeded: true, entries: 1000, linked: true, uncertified: true,
    });
    return seeded;
  }
  /** The test's OWN M + 1 from the literal S and U, in exact BigInt ticks. */
  const highEpochMidpointPlusOne = () =>
    renderTicks((exactOracleTicks(HIGH_EPOCH.lower) + exactOracleTicks(HIGH_EPOCH.upper)) / BigInt(2) + BigInt(1));
  /** The historical lane after a high-epoch subdivision, against literal expectations (booleans only). */
  async function highEpochFacts(scope: SlackChannelScope, lower: string) {
    return tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select historical_segment_lower_ts is not distinct from $4 as lower_is_exact_midpoint_plus_one,
              historical_segment_upper_ts is not distinct from $5 as upper_kept,
              historical_anchor_ts is not distinct from $6 as anchor_kept,
              historical_completed_segments_oldest_ts is not distinct from $7 as aggregate_byte_identical,
              historical_oldest_seen_ts is null as attempt_oldest_cleared,
              historical_cursor is null and historical_cursor_history = '[]'::jsonb as cursor_history_cleared,
              historical_scan_generation::int as generation,
              completed_lower_ts is null and completed_upper_ts is null and newest_catchup_upper_ts is null
                and not historical_floor_reached as coverage_unchanged,
              lease_owner is null and lease_expires_at is null and claimed_lane is null as released, next_lane, last_error_code
         from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
      [scope.teamId, scope.workspaceId, scope.channelId, lower, HIGH_EPOCH.upper, HIGH_EPOCH.anchor, HIGH_EPOCH.aggregate]
    )).rows[0]);
  }
  const HIGH_EPOCH_FACTS = {
    lower_is_exact_midpoint_plus_one: true, upper_kept: true, anchor_kept: true, aggregate_byte_identical: true,
    attempt_oldest_cleared: true, cursor_history_cleared: true, generation: 5, coverage_unchanged: true, released: true,
    next_lane: "newest",
  };

  it("§5 high-epoch capacity subdivision / DH-04: an over-cap continuation on a WIDE segment just below the maximum epoch stores the exact bigint midpoint S = M + 1 and preserves the completed-segments aggregate byte for byte", async () => {
    const seeded = await seedHighEpoch();
    const midpointPlusOne = highEpochMidpointPlusOne();
    expect(midpointPlusOne, "fixture: oracle").toBe("253402300799.999851");
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(seeded.scope, CAPACITY_SUBDIVISION_PERMITTED);
    // A NEW cursor on a 1,000-entry H: the candidate has 1,001 entries, so the wide segment subdivides.
    const outcome = await admit(claim, { terminal: false, nextCursor: "cap-new", oldestTs: HIGH_EPOCH.pageOldest });
    expect({
      outcome,
      facts: await highEpochFacts(seeded.scope, midpointPlusOne),
      newestLaneUnchanged: await newestLaneExact(seeded.scope),
      unrelatedUnchanged: (await rowDigestExcept(seeded.scope, CAPACITY_SUBDIVISION_PERMITTED)) === before,
    }, "typed capacity subdivision at the exact bigint midpoint; U, A and the aggregate kept; C/H/attempt-oldest cleared; G + 1; released").toEqual({
      outcome: { accept: { outcome: "subdivided", category: "cursor_history_entries_exceeded" } },
      facts: { ...HIGH_EPOCH_FACTS, last_error_code: "cursor_history_entries_exceeded" },
      newestLaneUnchanged: true,
      unrelatedUnchanged: true,
    });
  });

  it("§5 high-epoch invalid_cursor / DH-04: the restart writer subdivides a WIDE segment just below the maximum epoch at the exact bigint midpoint and preserves U, A, the aggregate and coverage", async () => {
    const seeded = await seedHighEpoch();
    const midpointPlusOne = highEpochMidpointPlusOne();
    expect(midpointPlusOne, "fixture: oracle").toBe("253402300799.999851");
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(seeded.scope, INVALID_CURSOR_PERMITTED);
    const outcome = await restartOutcome(claim);
    expect({
      outcome,
      facts: await highEpochFacts(seeded.scope, midpointPlusOne),
      newestLaneUnchanged: await newestLaneExact(seeded.scope),
      unrelatedUnchanged: (await rowDigestExcept(seeded.scope, INVALID_CURSOR_PERMITTED)) === before,
    }, "typed subdivided at the exact bigint midpoint; U, A, the aggregate and coverage kept; C/H/attempt-oldest cleared; G + 1; released").toEqual({
      outcome: { outcome: "subdivided", leaked: false },
      facts: { ...HIGH_EPOCH_FACTS, last_error_code: "invalid_cursor" },
      newestLaneUnchanged: true,
      unrelatedUnchanged: true,
    });
  });

  // ── PACKET 8c: membership spans the WHOLE history, including its oldest entry, DH-06 ─────────────
  // The existing at-cap case repeats a MIDDLE entry; this one repeats H[0]. Without H[0] in the
  // membership test the candidate would have 1,001 entries and the WIDE segment would subdivide before
  // any append, so the discriminating outcome is typed and no duplicate-history CHECK is involved.

  it("F2-01 (partial) / F2-04 / DH-06 repetition of the OLDEST entry H[0] at the entry cap on a WIDE segment is still cursor_repeated (membership spans the whole history; never subdivided)", async () => {
    const history = entryCapHistory();
    const seeded = await seedWideSegment(history);
    const { scope } = seeded;
    expect(await tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select pg_catalog.jsonb_array_length(historical_cursor_history)::int as entries,
              (historical_cursor_history -> 0) = pg_catalog.to_jsonb($2::text) as oldest_is_first,
              historical_cursor = $3 and (historical_cursor_history -> -1) = pg_catalog.to_jsonb(historical_cursor) as current_is_last
         from slack_sync_channels where team_id = $1`,
      [scope.teamId, history[0], history[999]]
    )).rows[0]), "fixture: 1,000 distinct entries, H[0] oldest, the cursor H[999]").toEqual({
      entries: 1000, oldest_is_first: true, current_is_last: true,
    });
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: history[0], oldestTs: seeded.pageOldest });
    expect({
      outcome,
      bookkeeping: await bookkeeping(scope, null),
      facts: await historicalFacts(scope, history[999], history),
      onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === before,
    }, "a repeated OLDEST entry at the cap is repetition: typed cursor_repeated, release only, H and the segment untouched").toEqual({
      outcome: { accept: { outcome: "rejected", category: "cursor_repeated" }, release: "written" },
      bookkeeping: {
        next_lane: "newest", claimed_lane: null, lease_cleared: true, last_read_set: false, last_error_code: "cursor_repeated",
        attempt_oldest_is_expected: true,
      },
      facts: { cursor_is_expected: true, history_is_expected: true, entries: 1000, generation: 4, newest_lane_unchanged: true },
      onlyReleaseFieldsMoved: true,
    });
  });

  // ── PACKET 8d: the NEWEST lane's frozen L and logical B are fence values, DH-08 ──────────────────
  // A fresh row per test: both lanes initialized (the shared seed), `next_lane` moved to newest, and the
  // newest lane CLAIMED (it resumes the fixture's segment [L = S = 1718900440, U = A = 1718900800] with
  // B = 1718900500, C = syn-n-1, H = [syn-n-1], G 2). Then ONLY one bound drifts by one canonical
  // microsecond, keeping L ≤ S and L ≤ B, so the row stays CHECK-valid and every other fence matches:
  //  - L down to 1718900439.999999;
  //  - B up to 1718900500.000001.
  // Acceptance offers a REPEATED continuation (syn-n-1), so a missing L/B fence would surface as
  // cursor_repeated; the restart writer would subdivide the wide segment. Both must refuse instead, and
  // the live (post-drift) row must stay byte-identical, the historical lane included.

  const NEWEST_DRIFT = {
    requestLower: { column: "newest_request_lower_ts", drifted: "1718900439.999999" },
    logicalLower: { column: "newest_lower_ts", drifted: "1718900500.000001" },
  } as const;

  /** Seed both lanes, hand the turn to newest, claim it, drift one bound, and assert each step as a PRECONDITION. */
  async function claimedNewestWithDrift(bound: keyof typeof NEWEST_DRIFT): Promise<{ seeded: Seeded; claim: SlackChannelClaim }> {
    const seeded = await seedWideSegment([OLDER_ENTRY, "syn-h-2"]);
    await tx((session) => session.executeSql("update slack_sync_channels set next_lane = 'newest' where team_id = $1", [seeded.scope.teamId]));
    const result = await tx((session) => claimSlackChannelPage(session, seeded.scope, {
      bindingIntegrationId: seeded.integrationId, bindingConfigRevision: REVISION,
    }));
    const claim = result !== null && !("outcome" in result) ? result : null;
    expect(claimBounds(claim), "fixture: the initialized newest lane is claimed and resumes its exact segment").toEqual({
      lane: "newest", anchorTs: NEWEST_FIXTURE.newest_anchor_ts, requestLowerTs: NEWEST_FIXTURE.newest_request_lower_ts,
      segmentLowerTs: NEWEST_FIXTURE.newest_segment_lower_ts, segmentUpperTs: NEWEST_FIXTURE.newest_segment_upper_ts,
      scanGeneration: NEWEST_FIXTURE.newest_scan_generation, lowerTs: NEWEST_FIXTURE.newest_lower_ts, cursorNull: false,
    });
    const drift = NEWEST_DRIFT[bound];
    // The column name is one of the two literals above, never an input.
    await tx((session) => session.executeSql(`update slack_sync_channels set ${drift.column} = $2 where team_id = $1`, [seeded.scope.teamId, drift.drifted]));
    expect(await tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select ${drift.column} = $2 as drifted,
              newest_request_lower_ts::numeric <= newest_segment_lower_ts::numeric
                and newest_request_lower_ts::numeric <= newest_lower_ts::numeric as bounds_ordered,
              newest_segment_lower_ts = $3 and newest_segment_upper_ts = $4 and newest_anchor_ts = $4
                and newest_cursor = 'syn-n-1' and newest_scan_generation = 2 as other_newest_fences_kept,
              claimed_lane = 'newest' and lease_owner is not null and lease_expires_at > clock_timestamp() as lease_live
         from slack_sync_channels where team_id = $1`,
      [seeded.scope.teamId, drift.drifted, NEWEST_FIXTURE.newest_segment_lower_ts, NEWEST_FIXTURE.newest_anchor_ts]
    )).rows[0]), "fixture: only the one bound drifted, CHECK-valid, under a live newest lease").toEqual({
      drifted: true, bounds_ordered: true, other_newest_fences_kept: true, lease_live: true,
    });
    return { seeded, claim: claim as SlackChannelClaim };
  }

  /** Acceptance of a REPEATED newest continuation after the drift: refused, and the live row exact. */
  async function newestDriftAcceptance(bound: keyof typeof NEWEST_DRIFT) {
    const { seeded, claim } = await claimedNewestWithDrift(bound);
    const before = await rowDigestExcept(seeded.scope, []);
    const outcome = await admit(claim, { terminal: false, nextCursor: "syn-n-1", oldestTs: HISTORICAL_ANCHOR });
    return { outcome, rowUnchanged: (await rowDigestExcept(seeded.scope, [])) === before };
  }
  /** The restart writer after the drift: refused, and the live row exact. */
  async function newestDriftRestart(bound: keyof typeof NEWEST_DRIFT) {
    const { seeded, claim } = await claimedNewestWithDrift(bound);
    const before = await rowDigestExcept(seeded.scope, []);
    const outcome = await restartOutcome(claim);
    return { outcome, rowUnchanged: (await rowDigestExcept(seeded.scope, [])) === before };
  }

  it("F2-11/DH-08 newest channel fence: the frozen request lower L drifted by one microsecond refuses a repeated continuation before cursor classification, and the live row is exact", async () => {
    expect(await newestDriftAcceptance("requestLower"), "the newest fence includes L: stale authority is refused before any cursor category").toEqual({
      outcome: { accept: { outcome: "refused" } }, rowUnchanged: true,
    });
  });

  it("F2-11/DH-08 newest channel fence: the logical lower B drifted by one microsecond refuses a repeated continuation before cursor classification, and the live row is exact", async () => {
    expect(await newestDriftAcceptance("logicalLower"), "the newest fence includes B: stale authority is refused before any cursor category").toEqual({
      outcome: { accept: { outcome: "refused" } }, rowUnchanged: true,
    });
  });

  it("§5/§8 newest invalid_cursor fence: the frozen request lower L drifted by one microsecond makes the restart writer return typed refused, and the live row is exact", async () => {
    expect(await newestDriftRestart("requestLower"), "the newest invalid_cursor transition is fenced on L exactly like acceptance").toEqual({
      outcome: { outcome: "refused", leaked: false }, rowUnchanged: true,
    });
  });

  it("§5/§8 newest invalid_cursor fence: the logical lower B drifted by one microsecond makes the restart writer return typed refused, and the live row is exact", async () => {
    expect(await newestDriftRestart("logicalLower"), "the newest invalid_cursor transition is fenced on B exactly like acceptance").toEqual({
      outcome: { outcome: "refused", leaked: false }, rowUnchanged: true,
    });
  });

  // ── PACKET 9 (deferred DH/F2 finite packet, DH-PKT-02): the SQL BYTE cap on a WIDE segment ─────────
  // 341 distinct cursors, each four ASCII bytes plus 1,020 three-byte U+4E00 characters (1,024 UTF-16
  // code units, the cursor maximum). PostgreSQL itself sizes the stored history at 341 entries and
  // 1,046,188 bytes, and the candidate with one more such cursor at 342 entries and 1,049,256 bytes,
  // so BYTES fail far below the entry cap. Constructed, CHECK-valid literals written directly; they are
  // not provider traversals, and these direct writer cases make no queue claim.

  /** One synthetic byte-heavy cursor: `k` + three digits, then 1,020 three-byte characters. */
  const byteCursor = (i: number): string => `k${String(i).padStart(3, "0")}${String.fromCodePoint(0x4e00).repeat(1020)}`;
  const byteHistory = (): string[] => Array.from({ length: 341 }, (_, i) => byteCursor(i));
  const BYTE_CANDIDATE = byteCursor(341);
  /** The newest-lane counterpart of the invalid_cursor allowance: S, C/H, G and the release. */
  const NEWEST_SUBDIVISION_PERMITTED = [
    "newest_cursor", "newest_cursor_history", "newest_scan_generation", "newest_segment_lower_ts", ...RELEASE_PERMITTED,
  ];

  /** SQL's own entry counts and serialized byte lengths of a lane's stored H and of H plus the candidate. */
  async function laneHistorySize(scope: SlackChannelScope, lane: "newest" | "historical", candidate: string) {
    // The lane is one of two literals, never an input.
    return tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select pg_catalog.jsonb_array_length(${lane}_cursor_history)::int as stored_entries,
              pg_catalog.octet_length(${lane}_cursor_history::text)::int as stored_bytes,
              pg_catalog.jsonb_array_length(${lane}_cursor_history || pg_catalog.jsonb_build_array($4::text))::int as candidate_entries,
              pg_catalog.octet_length((${lane}_cursor_history || pg_catalog.jsonb_build_array($4::text))::text)::int as candidate_bytes,
              (${lane}_cursor_history -> -1) = pg_catalog.to_jsonb(${lane}_cursor) as linked,
              not (${lane}_cursor_history @> pg_catalog.jsonb_build_array($4::text)) as candidate_distinct
         from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
      [scope.teamId, scope.workspaceId, scope.channelId, candidate]
    )).rows[0]);
  }
  const BYTE_SIZES = {
    stored_entries: 341, stored_bytes: 1_046_188, candidate_entries: 342, candidate_bytes: 1_049_256, linked: true, candidate_distinct: true,
  };

  /** Claim this row's next lane, and require it to be the named one. */
  async function claimLaneOf(scope: SlackChannelScope, integrationId: string, lane: "newest" | "historical"): Promise<SlackChannelClaim> {
    const result = await tx((session) => claimSlackChannelPage(session, scope, { bindingIntegrationId: integrationId, bindingConfigRevision: REVISION }));
    const claim = result !== null && !("outcome" in result) ? result : null;
    expect({ lane: claim?.lane ?? null }, `fixture: the ${lane} lane is claimed`).toEqual({ lane });
    return claim as SlackChannelClaim;
  }

  it("DH-PKT-02-H (DH-02, DH-05, F2-05/F2-06; DH-04): a WIDE historical continuation over the SQL BYTE cap (341 stored entries, 1,049,256 candidate bytes) is the typed bytes subdivision at the exact midpoint, and keeps the aggregate", async () => {
    const seeded = await seedWideSegment(byteHistory());
    await tx((session) => session.executeSql(
      `update slack_sync_channels
          set historical_anchor_ts = '15.000000', historical_segment_lower_ts = '10.000000', historical_segment_upper_ts = '13.000000',
              historical_oldest_seen_ts = '12.000000', historical_completed_segments_oldest_ts = '14.000000'
        where team_id = $1`,
      [seeded.scope.teamId]
    ));
    expect({
      sizes: await laneHistorySize(seeded.scope, "historical", BYTE_CANDIDATE),
      seeded: await rowSelect(seeded.scope, `historical_anchor_ts = '15.000000' and historical_segment_lower_ts = '10.000000'
          and historical_segment_upper_ts = '13.000000' and historical_scan_generation = 4 as bounds_and_generation,
        historical_oldest_seen_ts = '12.000000' and historical_completed_segments_oldest_ts = '14.000000' as progress,
        completed_lower_ts is null and completed_upper_ts is null and newest_catchup_upper_ts is null and last_read_at is null as uncertified_unread`),
    }, "fixture: SQL-sized byte-cap history on the constructed wide historical segment").toEqual({
      sizes: BYTE_SIZES, seeded: { bounds_and_generation: true, progress: true, uncertified_unread: true },
    });
    const claim = await claimHistorical(seeded);
    const before = await rowDigestExcept(seeded.scope, INVALID_CURSOR_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: BYTE_CANDIDATE, oldestTs: "12.500000" });
    expect({
      outcome,
      facts: await rowSelect(seeded.scope, `historical_segment_lower_ts, historical_segment_upper_ts, historical_anchor_ts,
        historical_cursor is null and historical_cursor_history = '[]'::jsonb as cursor_history_cleared,
        historical_scan_generation::int as generation, historical_oldest_seen_ts is null as attempt_oldest_cleared,
        historical_completed_segments_oldest_ts as aggregate, last_read_at is null as no_successful_read,
        completed_lower_ts is null and completed_upper_ts is null and newest_catchup_upper_ts is null
          and not historical_floor_reached as coverage_unchanged,
        lease_owner is null and lease_expires_at is null and claimed_lane is null as released, next_lane, last_error_code`),
      newestLaneUnchanged: await newestLaneExact(seeded.scope),
      unrelatedUnchanged: (await rowDigestExcept(seeded.scope, INVALID_CURSOR_PERMITTED)) === before,
    }, "typed bytes subdivision: S = 11.500001; U and A kept; C/H and attempt-oldest cleared; aggregate kept; G + 1; released, turn passed").toEqual({
      outcome: { accept: { outcome: "subdivided", category: "cursor_history_bytes_exceeded" } },
      facts: {
        historical_segment_lower_ts: "11.500001", historical_segment_upper_ts: "13.000000", historical_anchor_ts: "15.000000",
        cursor_history_cleared: true, generation: 5, attempt_oldest_cleared: true, aggregate: "14.000000", no_successful_read: true,
        coverage_unchanged: true, released: true, next_lane: "newest", last_error_code: "cursor_history_bytes_exceeded",
      },
      newestLaneUnchanged: true,
      unrelatedUnchanged: true,
    });
  });

  it("DH-PKT-02-N (DH-02, DH-05, F2-05/F2-06; DH-04): a WIDE newest continuation over the SQL BYTE cap subdivides at the exact midpoint, then two inner terminals and a final terminal finish it as PROVISIONAL coverage while the initial historical envelope stays pending", async () => {
    // Newest: A = 15, B = 9, L = 8, [S, U] = [10, 13], G 4, C = H's last. Historical: the initial
    // envelope pending at anchor 9 (= B) on [0, 9], with an ordinary cursor. Nothing is certified.
    const { scope, integrationId } = await seedNewestCandidate({
      newest_anchor_ts: "15.000000", newest_lower_ts: "9.000000", newest_scan_generation: 4,
      historical_anchor_ts: "9.000000", historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "9.000000",
      historical_cursor: "syn-h-1", historical_cursor_history: ["syn-h-1"], historical_scan_generation: 4,
    });
    const history = byteHistory();
    await tx((session) => session.executeSql(
      `update slack_sync_channels
          set newest_request_lower_ts = '8.000000', newest_segment_lower_ts = '10.000000', newest_segment_upper_ts = '13.000000',
              newest_cursor = $2, newest_cursor_history = $3::jsonb
        where team_id = $1`,
      [scope.teamId, history[history.length - 1], JSON.stringify(history)]
    ));
    /** The newest lane and the coverage, as literal bounds, booleans and G (no cursor or history value). */
    const newestFacts = () => rowSelect(scope, `newest_anchor_ts, newest_lower_ts, newest_request_lower_ts,
        newest_segment_lower_ts, newest_segment_upper_ts,
        newest_cursor is null and newest_cursor_history = '[]'::jsonb as cursor_history_cleared,
        newest_scan_generation::int as generation, newest_catchup_upper_ts as provisional,
        completed_lower_ts is null and completed_upper_ts is null as uncertified`);
    /** The pending historical envelope: its anchor, segment, attempt-oldest, G and floor, plus H against a literal. */
    const historicalFacts9 = (cursor: string, entries: string[]) => rowSelect(scope, `historical_anchor_ts,
        historical_segment_lower_ts, historical_segment_upper_ts, historical_scan_generation::int as generation,
        historical_oldest_seen_ts, historical_floor_reached,
        historical_cursor = $4 and historical_cursor_history = $5::jsonb as cursor_and_history_expected`, [cursor, JSON.stringify(entries)]);
    expect({
      sizes: await laneHistorySize(scope, "newest", BYTE_CANDIDATE),
      newest: await newestFacts(),
      historical: await historicalFacts9("syn-h-1", ["syn-h-1"]),
    }, "fixture: SQL-sized byte-cap history on the constructed wide newest segment, beside a pending historical envelope").toEqual({
      sizes: BYTE_SIZES,
      newest: {
        newest_anchor_ts: "15.000000", newest_lower_ts: "9.000000", newest_request_lower_ts: "8.000000",
        newest_segment_lower_ts: "10.000000", newest_segment_upper_ts: "13.000000", cursor_history_cleared: false,
        generation: 4, provisional: null, uncertified: true,
      },
      historical: {
        historical_anchor_ts: "9.000000", historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "9.000000",
        generation: 4, historical_oldest_seen_ts: null, historical_floor_reached: false, cursor_and_history_expected: true,
      },
    });

    // 1. The over-byte continuation: typed subdivision, newest lane only.
    const claim = await claimLaneOf(scope, integrationId, "newest");
    const before = await rowDigestExcept(scope, NEWEST_SUBDIVISION_PERMITTED);
    const subdivided = await admit(claim, { terminal: false, nextCursor: BYTE_CANDIDATE, oldestTs: "12.500000" });
    expect({
      outcome: subdivided,
      newest: await newestFacts(),
      bookkeeping: await rowSelect(scope, `last_read_at is null as no_successful_read,
        lease_owner is null and lease_expires_at is null and claimed_lane is null as released, next_lane, last_error_code`),
      unrelatedUnchanged: (await rowDigestExcept(scope, NEWEST_SUBDIVISION_PERMITTED)) === before,
    }, "typed bytes subdivision: S = 11.500001; U, A, B and L kept; C/H cleared; G + 1; no read or coverage write; released, turn passed").toEqual({
      outcome: { accept: { outcome: "subdivided", category: "cursor_history_bytes_exceeded" } },
      newest: {
        newest_anchor_ts: "15.000000", newest_lower_ts: "9.000000", newest_request_lower_ts: "8.000000",
        newest_segment_lower_ts: "11.500001", newest_segment_upper_ts: "13.000000", cursor_history_cleared: true,
        generation: 5, provisional: null, uncertified: true,
      },
      bookkeeping: { no_successful_read: true, released: true, next_lane: "historical", last_error_code: "cursor_history_bytes_exceeded" },
      unrelatedUnchanged: true,
    });

    /** An ORDINARY historical continuation: the legitimate use of the historical turn between newest claims. */
    const historicalTurn = async (cursor: string, oldest: string) => {
      const turn = await claimLaneOf(scope, integrationId, "historical");
      expect(await admit(turn, { terminal: false, nextCursor: cursor, oldestTs: oldest }), "fixture: the historical turn appends an ordinary cursor").toEqual({
        accept: { outcome: "written" },
      });
    };
    /** A genuinely terminal newest page on the claimed segment, with its typed completion kept. */
    const newestTerminal = async (oldest: string) =>
      admitKeepingCompletion(await claimLaneOf(scope, integrationId, "newest"), { terminal: true, nextCursor: null, oldestTs: oldest });

    // 2. [11.500001, 13]: an inner terminal; next [max(L, S − 2W), S − 1] = [8.500001, 11.500000].
    await historicalTurn("syn-h-2", "5.000000");
    expect({ outcome: await newestTerminal("12.000000"), newest: await newestFacts() }, "inner terminal 1: the adjacent doubled segment; nothing promoted").toEqual({
      outcome: { outcome: "written", completion: "segment" },
      newest: {
        newest_anchor_ts: "15.000000", newest_lower_ts: "9.000000", newest_request_lower_ts: "8.000000",
        newest_segment_lower_ts: "8.500001", newest_segment_upper_ts: "11.500000", cursor_history_cleared: true,
        generation: 6, provisional: null, uncertified: true,
      },
    });

    // 3. [8.500001, 11.500000]: an inner terminal; next clamps at L: [8.000000, 8.500000].
    await historicalTurn("syn-h-3", "4.000000");
    expect({ outcome: await newestTerminal("10.000000"), newest: await newestFacts() }, "inner terminal 2: clamped at L; nothing promoted").toEqual({
      outcome: { outcome: "written", completion: "segment" },
      newest: {
        newest_anchor_ts: "15.000000", newest_lower_ts: "9.000000", newest_request_lower_ts: "8.000000",
        newest_segment_lower_ts: "8.000000", newest_segment_upper_ts: "8.500000", cursor_history_cleared: true,
        generation: 7, provisional: null, uncertified: true,
      },
    });

    // 4. [8.000000, 8.500000] = [L, …]: the FINAL terminal. Nothing is certified, so A becomes provisional.
    await historicalTurn("syn-h-4", "3.000000");
    expect({
      outcome: await newestTerminal("8.200000"),
      newest: await newestFacts(),
      historical: await historicalFacts9("syn-h-4", ["syn-h-1", "syn-h-2", "syn-h-3", "syn-h-4"]),
    }, "final terminal: provisional upper = original A; only the newest lane cleared; the historical envelope and its progress kept").toEqual({
      outcome: { outcome: "written", completion: "envelope" },
      newest: {
        newest_anchor_ts: null, newest_lower_ts: null, newest_request_lower_ts: null,
        newest_segment_lower_ts: null, newest_segment_upper_ts: null, cursor_history_cleared: true,
        generation: 8, provisional: "15.000000", uncertified: true,
      },
      historical: {
        historical_anchor_ts: "9.000000", historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "9.000000",
        generation: 4, historical_oldest_seen_ts: "3.000000", historical_floor_reached: false, cursor_and_history_expected: true,
      },
    });
  });

  // ── PACKET 7: §3.4 / F2-10 maximum-history compatibility writers ────────────────────────────────
  // PostgreSQL rechecks BOTH history CHECKs on every update of the row. Each writer below therefore
  // runs against a FRESH row whose two histories sit at their exact maximum accepted shape (1,000
  // entries, 1,048,576 bytes each, distinct per lane). The fixture is proved by SQL before each action.
  // A digest of every column outside the writer's existing allowed set then proves that both
  // histories, and all unrelated progress and certification, are byte-identical. The allowed effects
  // are asserted as SQL booleans and counts. No history or cursor is ever projected or printed.

  /** A maximum accepted history; `prefix` makes the two lanes' histories distinct sentinels. */
  function maxHistory(prefix: "h" | "n"): string[] {
    const pad = String.fromCodePoint(0x4e00);
    return Array.from({ length: 1000 }, (_, i) => {
      const id = `${prefix}${String(i).padStart(3, "0")}`;
      return i < 576 ? id + pad.repeat(347) : `${id}${pad.repeat(346)}aa`;
    });
  }
  /**
   * The shared fixture's legal, DISCRIMINATING non-null facts, so preservation is proved against
   * clearing.
   *  - Historical: A = `1718900500.000000`, on the FINAL segment [S = L = 0, U = `1718900300.000000`]
   *    with U < A, after earlier terminal upper segments. The aggregate `1718900350.000000` is in
   *    (U, A], the attempt-oldest `1718900200.000000` is in [S, U], and G is 4.
   *  - Newest: a provisional catch-up top `1718900650.000000` is the newest lane's B. Then
   *    L = S = B − 60 s, U = A = `1718900800.000000`, and G is 2.
   *  - Row-wide: `last_read_at` and a prior `last_error_code` are set.
   */
  const MAX_ROW = {
    historicalUpper: "1718900300.000000",
    aggregate: "1718900350.000000",
    attemptOldest: "1718900200.000000",
    catchupTop: "1718900650.000000",
    newestAnchor: "1718900800.000000",
    newestRequestLower: "1718900590.000000",
    lastRead: "2026-01-02 00:00:00+00",
    lastError: "prior_compat",
    // Inside [S, U] and NEWER than the attempt-oldest, so the §6 terminal's completed lower must come
    // from the locked attempt-oldest, not from the page.
    pageOldest: "1718900250.000000",
  } as const;
  type MaxSeeded = Seeded & { historicalHistory: string[]; sentinels: readonly string[] };
  /** A public, bound, due channel with BOTH lanes initialized at maximum history; `next_lane` is historical. */
  async function seedMaxBoth(): Promise<MaxSeeded> {
    const seed = await seedTeam();
    const scope = { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL };
    const historicalHistory = maxHistory("h");
    const newestHistory = maxHistory("n");
    const integrationId = await tx(async (session) => (await session.executeSql<{ id: string }>(
      `insert into integrations (team_id, type, name) values ($1, 'slack', 'compat-binder') returning id::text as id`, [seed.teamId]
    )).rows[0].id);
    await tx((session) => session.executeSql(
      `insert into slack_sync_channels
         (team_id, workspace_id, channel_id, public_state, public_checked_at, binding_integration_id, binding_config_revision,
          newest_anchor_ts, newest_lower_ts, newest_request_lower_ts, newest_segment_lower_ts, newest_segment_upper_ts,
          newest_cursor, newest_cursor_history, newest_scan_generation, newest_catchup_upper_ts,
          historical_anchor_ts, historical_segment_lower_ts, historical_segment_upper_ts,
          historical_cursor, historical_cursor_history, historical_scan_generation,
          historical_oldest_seen_ts, historical_completed_segments_oldest_ts,
          last_read_at, last_error_code, next_lane, due_at)
       values ($1, $2, $3, 'public', '2026-01-01 00:00:00+00', $4::uuid, $5,
               $6, $7, $8, $8, $6, $9, $10::jsonb, 2, $7,
               $11, '0.000000', $12, $13, $14::jsonb, 4,
               $15, $16,
               $17::timestamptz, $18, 'historical', '2020-01-01 00:00:00+00')`,
      [seed.teamId, WORKSPACE, CHANNEL, integrationId, REVISION,
        MAX_ROW.newestAnchor, MAX_ROW.catchupTop, MAX_ROW.newestRequestLower,
        newestHistory[999], JSON.stringify(newestHistory),
        HISTORICAL_ANCHOR, MAX_ROW.historicalUpper, historicalHistory[999], JSON.stringify(historicalHistory),
        MAX_ROW.attemptOldest, MAX_ROW.aggregate, MAX_ROW.lastRead, MAX_ROW.lastError]
    ));
    return {
      scope, integrationId, width: "wide", pageOldest: MAX_ROW.pageOldest, historicalHistory,
      // NON-CURRENT entries of each history: a returned value carrying one has leaked a history.
      sentinels: [historicalHistory[0], historicalHistory[500], newestHistory[0], newestHistory[500]],
    };
  }
  /** True if any string anywhere in `value` contains a sentinel. Only a boolean is kept. */
  function carriesSentinel(value: unknown, sentinels: readonly string[], seen: WeakSet<object> = new WeakSet()): boolean {
    if (typeof value === "string") return sentinels.some((sentinel) => value.includes(sentinel));
    if (value === null || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some((item) => carriesSentinel(item, sentinels, seen));
  }
  /** A returned value is leak-free when it names no history and carries no non-current history entry. */
  const leakFree = (value: unknown, seeded: MaxSeeded) => !hasHistoryKey(value) && !carriesSentinel(value, seeded.sentinels);
  /** SQL-computed facts about both histories (counts, bytes and booleans only). */
  async function maxFacts(scope: SlackChannelScope) {
    return tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select pg_catalog.jsonb_array_length(historical_cursor_history)::int as historical_entries,
              pg_catalog.octet_length(historical_cursor_history::text)::int as historical_bytes,
              pg_catalog.jsonb_array_length(newest_cursor_history)::int as newest_entries,
              pg_catalog.octet_length(newest_cursor_history::text)::int as newest_bytes,
              coalesce((historical_cursor_history -> -1) = pg_catalog.to_jsonb(historical_cursor), false)
                and coalesce((newest_cursor_history -> -1) = pg_catalog.to_jsonb(newest_cursor), false) as linked,
              historical_cursor_history <> newest_cursor_history as distinct_sentinels
         from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
      [scope.teamId, scope.workspaceId, scope.channelId]
    )).rows[0]);
  }
  const MAX_FACTS = {
    historical_entries: 1000, historical_bytes: 1048576, newest_entries: 1000, newest_bytes: 1048576,
    linked: true, distinct_sentinels: true,
  };
  /** One SQL projection of the claimed row: booleans/counts/static strings only. */
  async function rowSelect(scope: SlackChannelScope, sql: string, extra: unknown[] = []) {
    return tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select ${sql} from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
      [scope.teamId, scope.workspaceId, scope.channelId, ...extra]
    )).rows[0]);
  }
  /**
   * The newest lane alone, EXACTLY as seeded: its maximum history, cursor, bounds and G (one
   * boolean). Use it for writers that legitimately clear the historical lane.
   */
  async function newestStillMax(scope: SlackChannelScope): Promise<boolean> {
    const newest = maxHistory("n");
    const facts = await rowSelect(scope, `coalesce(newest_cursor = $4 and newest_cursor_history = $5::jsonb
        and newest_scan_generation = 2 and newest_anchor_ts = $6 and newest_segment_upper_ts = $6 and newest_lower_ts = $7
        and newest_request_lower_ts = $8 and newest_segment_lower_ts = $8, false) as exact`,
      [newest[999], JSON.stringify(newest), MAX_ROW.newestAnchor, MAX_ROW.catchupTop, MAX_ROW.newestRequestLower]);
    return facts.exact === true;
  }
  /** Seed, then prove the maximum fixture and its discriminating non-null facts as separate PRECONDITIONS. */
  async function maxFixture(): Promise<MaxSeeded> {
    const seeded = await seedMaxBoth();
    expect(await maxFacts(seeded.scope), "fixture: both histories are at their exact maximum, linked and distinct").toEqual(MAX_FACTS);
    expect(await rowSelect(seeded.scope, `newest_catchup_upper_ts = $4 and newest_catchup_upper_ts = newest_lower_ts as provisional_is_b,
        historical_segment_lower_ts = '0.000000' and historical_segment_upper_ts = $5
          and historical_segment_upper_ts::numeric < historical_anchor_ts::numeric as final_segment_below_a,
        historical_oldest_seen_ts = $6 as attempt_oldest_seeded, historical_completed_segments_oldest_ts = $7 as aggregate_seeded,
        last_read_at = $8::timestamptz as read_seeded, last_error_code = $9 as error_seeded,
        completed_lower_ts is null and completed_upper_ts is null and not coalesce(historical_floor_reached, false) as uncertified`,
      [MAX_ROW.catchupTop, MAX_ROW.historicalUpper, MAX_ROW.attemptOldest, MAX_ROW.aggregate, MAX_ROW.lastRead, MAX_ROW.lastError]),
    "fixture: the discriminating non-null facts are seeded").toEqual({
      provisional_is_b: true, final_segment_below_a: true, attempt_oldest_seeded: true, aggregate_seeded: true,
      read_seeded: true, error_seeded: true, uncertified: true,
    });
    return seeded;
  }
  /**
   * `admit` on the maximum row, plus the sentinel no-leak check over the RAW accept (and release)
   * results. Only static strings and booleans are kept.
   */
  async function admitMax(seeded: MaxSeeded, claim: SlackChannelClaim, page: Page): Promise<Record<string, unknown>> {
    try {
      return await tx(async (session) => {
        const accepted = await acceptSlackChannelPage(session, claim, page);
        const view = accepted as unknown as { outcome: string; category?: string; completion?: unknown };
        if (view.outcome === "rejected" && typeof view.category === "string") {
          const released = await releaseSlackChannelForRetry(session, claim, { errorCode: view.category, turn: "passed", nextDueAt: null });
          return { accept: project(accepted), release: releaseView(released), leakFree: leakFree([accepted, released], seeded) };
        }
        const completion = typeof view.completion === "string" ? view.completion : null;
        return { accept: project(accepted), completion, leakFree: leakFree(accepted, seeded) };
      });
    } catch (error) {
      return sanitized(error);
    }
  }
  /** `restartOutcome` on the maximum row, plus the sentinel no-leak check over the RAW result. */
  async function restartMax(seeded: MaxSeeded, claim: SlackChannelClaim): Promise<Record<string, unknown>> {
    const result = await tx((session) => restartSlackChannelScan(session, claim, { errorCode: "invalid_cursor" })).catch(sanitized);
    const projected = project(result);
    return { outcome: projected.outcome, leaked: projected.leaked === true, leakFree: leakFree(result, seeded) };
  }
  const claimOf = (seeded: MaxSeeded) =>
    tx((session) => claimSlackChannelPage(session, seeded.scope, { bindingIntegrationId: seeded.integrationId, bindingConfigRevision: REVISION }));
  /** A claimed historical lane, asserted as a fixture step. */
  async function claimedMax(seeded: MaxSeeded): Promise<SlackChannelClaim> {
    const result = await claimOf(seeded);
    const claim = result !== null && !("outcome" in result) ? result : null;
    expect({ lane: claim?.lane ?? null }, "fixture: the historical lane is claimed").toEqual({ lane: "historical" });
    return claim as SlackChannelClaim;
  }
  const METADATA_BEGIN = ["metadata_attempt_owner", "metadata_attempt_generation", "updated_at"];
  const RECORD_PRIVATE = [
    "public_state", "public_checked_at", "binding_integration_id", "binding_config_revision", "last_error_code",
    "metadata_attempt_owner", "lease_owner", "lease_expires_at", "claimed_lane", "lease_generation", "due_at", "updated_at",
  ];
  const DELAY = ["due_at", "last_error_code", "metadata_attempt_owner", "updated_at"];

  describe("§3.4 / F2-10 every compatibility writer keeps BOTH maximum histories valid and exact", () => {
    afterAll(closeRawSql);

    it("claimSlackChannelPage: only the lease bookkeeping moves", async () => {
      const seeded = await maxFixture();
      const before = await rowDigestExcept(seeded.scope, LEASE_BOOKKEEPING);
      const claim = await claimOf(seeded);
      expect({
        lane: claim !== null && !("outcome" in claim) ? claim.lane : null,
        leakFree: leakFree(claim, seeded),
        facts: await rowSelect(seeded.scope, "claimed_lane, lease_owner is not null and lease_expires_at > clock_timestamp() as leased, attempts::int as attempts, lease_generation::int as lease_generation"),
        unchanged: (await rowDigestExcept(seeded.scope, LEASE_BOOKKEEPING)) === before,
      }).toEqual({
        lane: "historical", leakFree: true,
        facts: { claimed_lane: "historical", leased: true, attempts: 1, lease_generation: 1 },
        unchanged: true,
      });
    });

    it("releaseSlackChannelForRetry: only the §3.2 release bookkeeping moves, turn passed", async () => {
      const seeded = await maxFixture();
      const claim = await claimedMax(seeded);
      const before = await rowDigestExcept(seeded.scope, RELEASE_PERMITTED);
      const released = await tx((session) => releaseSlackChannelForRetry(session, claim, { errorCode: "compat_probe", turn: "passed", nextDueAt: null }));
      expect({
        outcome: released.outcome, leakFree: leakFree(released, seeded),
        facts: await rowSelect(seeded.scope, `next_lane, claimed_lane is null and lease_owner is null and lease_expires_at is null as released,
          last_error_code, due_at > clock_timestamp() - interval '1 minute' as due_now`),
        unchanged: (await rowDigestExcept(seeded.scope, RELEASE_PERMITTED)) === before,
      }).toEqual({
        outcome: "written", leakFree: true,
        facts: { next_lane: "newest", released: true, last_error_code: "compat_probe", due_now: true },
        unchanged: true,
      });
    });

    it("beginSlackChannelMetadata: only the metadata attempt moves", async () => {
      const seeded = await maxFixture();
      const before = await rowDigestExcept(seeded.scope, METADATA_BEGIN);
      const attempt = await tx((session) => beginSlackChannelMetadata(session, seeded.scope));
      expect({
        generation: attempt?.generation ?? null, leakFree: leakFree(attempt, seeded),
        facts: await rowSelect(seeded.scope, "metadata_attempt_owner is not null as owned, metadata_attempt_generation::int as generation"),
        unchanged: (await rowDigestExcept(seeded.scope, METADATA_BEGIN)) === before,
      }).toEqual({ generation: 1, leakFree: true, facts: { owned: true, generation: 1 }, unchanged: true });
    });

    it("recordSlackChannelPublicState (private, under a live claim): public proof, binding, attempt, revocation and schedule move; nothing else", async () => {
      const seeded = await maxFixture();
      await claimedMax(seeded);
      const attempt = await tx((session) => beginSlackChannelMetadata(session, seeded.scope));
      if (!attempt) throw new Error("fixture: the metadata attempt did not open");
      const before = await rowDigestExcept(seeded.scope, RECORD_PRIVATE);
      const recorded = await tx((session) => recordSlackChannelPublicState(session, seeded.scope,
        { integrationId: seeded.integrationId, configRevision: REVISION }, attempt, { publicState: "private" }));
      expect({
        outcome: recorded.outcome, leakFree: leakFree(recorded, seeded),
        facts: await rowSelect(seeded.scope, `public_state, public_checked_at > timestamptz '2026-01-01 00:00:00+00' as checked_now,
          binding_integration_id = $4::uuid and binding_config_revision = $5 as binding_kept, last_error_code,
          metadata_attempt_owner is null as attempt_closed,
          lease_owner is null and lease_expires_at is null and claimed_lane is null as lease_revoked,
          lease_generation::int as lease_generation, due_at > clock_timestamp() - interval '1 minute' as due_now`,
          [seeded.integrationId, REVISION]),
        unchanged: (await rowDigestExcept(seeded.scope, RECORD_PRIVATE)) === before,
      }).toEqual({
        outcome: "written", leakFree: true,
        facts: {
          public_state: "private", checked_now: true, binding_kept: true, last_error_code: null, attempt_closed: true,
          lease_revoked: true, lease_generation: 2, due_now: true,
        },
        unchanged: true,
      });
    });

    it("delaySlackChannel (no new due time): only the diagnostic and the attempt move; due_at is kept", async () => {
      const seeded = await maxFixture();
      const attempt = await tx((session) => beginSlackChannelMetadata(session, seeded.scope));
      if (!attempt) throw new Error("fixture: the metadata attempt did not open");
      const before = await rowDigestExcept(seeded.scope, DELAY);
      const delayed = await tx((session) => delaySlackChannel(session, seeded.scope, attempt, { dueAt: null, errorCode: "metadata_delay" }));
      expect({
        outcome: delayed.outcome, leakFree: leakFree(delayed, seeded),
        facts: await rowSelect(seeded.scope, `due_at = timestamptz '2020-01-01 00:00:00+00' as due_kept, last_error_code,
          metadata_attempt_owner is null as attempt_closed`),
        unchanged: (await rowDigestExcept(seeded.scope, DELAY)) === before,
      }).toEqual({
        outcome: "written", leakFree: true,
        facts: { due_kept: true, last_error_code: "metadata_delay", attempt_closed: true },
        unchanged: true,
      });
    });

    it("integration delete (ON DELETE SET NULL + binding-clear trigger): only the binding pair is cleared", async () => {
      const seeded = await maxFixture();
      const BINDING = ["binding_integration_id", "binding_config_revision"];
      const before = await rowDigestExcept(seeded.scope, BINDING);
      await tx((session) => session.executeSql("delete from integrations where id = $1::uuid", [seeded.integrationId]));
      expect({
        facts: await rowSelect(seeded.scope, "binding_integration_id is null and binding_config_revision is null as binding_cleared"),
        unchanged: (await rowDigestExcept(seeded.scope, BINDING)) === before,
      }).toEqual({ facts: { binding_cleared: true }, unchanged: true });
    });

    it("opposite-lane acceptSlackChannelPage (historical terminal at its cap): §6 certifies the envelope from the locked row; the newest maximum history and all unrelated state are exact", async () => {
      const seeded = await maxFixture();
      const claim = await claimedMax(seeded);
      const before = await rowDigestExcept(seeded.scope, TERMINAL_PERMITTED);
      const outcome = await admitMax(seeded, claim, { terminal: true, nextCursor: null, oldestTs: seeded.pageOldest });
      // §6 oracles from the seeded literals. Lower: the oldest of the aggregate, attempt-oldest and
      // page oldest (the attempt-oldest here), with nothing certified before. Upper: the provisional
      // newest catch-up top, because nothing is certified yet.
      const attemptOldest = exactOracleTicks(MAX_ROW.attemptOldest);
      expect({ lower: attemptOldest < exactOracleTicks(MAX_ROW.pageOldest) && attemptOldest < exactOracleTicks(MAX_ROW.aggregate) },
        "fixture: oracle").toEqual({ lower: true });
      expect({
        outcome,
        facts: await rowSelect(seeded.scope, `historical_anchor_ts is null and historical_segment_lower_ts is null
            and historical_segment_upper_ts is null and historical_cursor is null
            and historical_cursor_history = '[]'::jsonb as historical_cleared,
          historical_oldest_seen_ts is null as attempt_oldest_cleared,
          historical_completed_segments_oldest_ts is null as aggregate_cleared,
          historical_floor_reached as floor_reached, historical_scan_generation::int as generation,
          coalesce(completed_lower_ts = $4, false) as completed_lower_exact,
          coalesce(completed_upper_ts = $5, false) as completed_upper_is_provisional_top,
          newest_catchup_upper_ts is null as provisional_absorbed,
          coalesce(last_read_at > $6::timestamptz and last_read_at > clock_timestamp() - interval '1 minute', false) as read_now,
          last_error_code,
          lease_owner is null and lease_expires_at is null and claimed_lane is null as released,
          coalesce(due_at > clock_timestamp() - interval '1 minute', false) as due_now, next_lane`,
          [MAX_ROW.attemptOldest, MAX_ROW.catchupTop, MAX_ROW.lastRead]),
        newestStillMax: await newestStillMax(seeded.scope),
        unrelatedUnchanged: (await rowDigestExcept(seeded.scope, TERMINAL_PERMITTED)) === before,
      }).toEqual({
        outcome: { accept: { outcome: "written" }, completion: "envelope", leakFree: true },
        facts: {
          historical_cleared: true, attempt_oldest_cleared: true, aggregate_cleared: true,
          floor_reached: true, generation: 5,
          completed_lower_exact: true, completed_upper_is_provisional_top: true, provisional_absorbed: true,
          read_now: true, last_error_code: null, released: true, due_now: true, next_lane: "newest",
        },
        newestStillMax: true,
        unrelatedUnchanged: true,
      });
    });

    it("opposite-lane restartSlackChannelScan (invalid_cursor on the wide historical segment): typed subdivided with the full release; the newest maximum history is exact", async () => {
      const seeded = await maxFixture();
      const claim = await claimedMax(seeded);
      const before = await rowDigestExcept(seeded.scope, INVALID_CURSOR_PERMITTED);
      const midpointPlusOne = renderTicks((exactOracleTicks("0.000000") + exactOracleTicks(MAX_ROW.historicalUpper)) / BigInt(2) + BigInt(1));
      expect(midpointPlusOne, "fixture: oracle").toBe("859450150.000001");
      const outcome = await restartMax(seeded, claim);
      expect({
        outcome,
        facts: await rowSelect(seeded.scope, `coalesce(historical_segment_lower_ts = $4 and historical_segment_upper_ts = $5, false) as split_at_midpoint,
          historical_cursor is null and historical_cursor_history = '[]'::jsonb as historical_cleared,
          historical_oldest_seen_ts is null as attempt_oldest_cleared,
          coalesce(historical_completed_segments_oldest_ts = $6, false) as aggregate_kept,
          historical_scan_generation::int as generation,
          lease_owner is null and lease_expires_at is null and claimed_lane is null as released,
          coalesce(due_at > clock_timestamp() - interval '1 minute', false) as due_now, next_lane, last_error_code`,
          [midpointPlusOne, MAX_ROW.historicalUpper, MAX_ROW.aggregate]),
        newestStillMax: await newestStillMax(seeded.scope),
        unrelatedUnchanged: (await rowDigestExcept(seeded.scope, INVALID_CURSOR_PERMITTED)) === before,
      }).toEqual({
        outcome: { outcome: "subdivided", leaked: false, leakFree: true },
        facts: {
          split_at_midpoint: true, historical_cleared: true, attempt_oldest_cleared: true, aggregate_kept: true, generation: 5,
          released: true, due_now: true, next_lane: "newest", last_error_code: "invalid_cursor",
        },
        newestStillMax: true,
        unrelatedUnchanged: true,
      });
    });

    it("the fenced rejection/release path (a repeated cursor at the cap): rejected / cursor_repeated, one release, both histories exact", async () => {
      const seeded = await maxFixture();
      const claim = await claimedMax(seeded);
      const before = await rowDigestExcept(seeded.scope, RELEASE_PERMITTED);
      // The repeated cursor is itself a sentinel, so an echo of the candidate is a detected leak.
      const outcome = await admitMax(seeded, claim, { terminal: false, nextCursor: seeded.historicalHistory[500], oldestTs: seeded.pageOldest });
      expect({
        outcome,
        facts: await rowSelect(seeded.scope, "next_lane, lease_owner is null and claimed_lane is null as released, last_error_code"),
        stillMax: await maxFacts(seeded.scope),
        unchanged: (await rowDigestExcept(seeded.scope, RELEASE_PERMITTED)) === before,
      }).toEqual({
        outcome: { accept: { outcome: "rejected", category: "cursor_repeated" }, release: "written", leakFree: true },
        facts: { next_lane: "newest", released: true, last_error_code: "cursor_repeated" },
        stillMax: MAX_FACTS,
        unchanged: true,
      });
    });

    it("test-only elapse: only due_at moves, by exactly the elapsed interval", async () => {
      const seeded = await maxFixture();
      const before = await rowDigestExcept(seeded.scope, ["due_at"]);
      await elapse(seeded.scope.teamId);
      expect({
        facts: await rowSelect(seeded.scope, "due_at = timestamptz '2020-01-01 00:00:00+00' - interval '120000 milliseconds' as moved_exactly"),
        stillMax: await maxFacts(seeded.scope),
        unchanged: (await rowDigestExcept(seeded.scope, ["due_at"])) === before,
      }).toEqual({ facts: { moved_exactly: true }, stillMax: MAX_FACTS, unchanged: true });
    });

    it("test-only expireChannelLease: only lease_expires_at moves; the lease owner is kept", async () => {
      const seeded = await maxFixture();
      await claimedMax(seeded);
      const before = await rowDigestExcept(seeded.scope, ["lease_expires_at"]);
      await expireChannelLease(seeded.scope.teamId, CHANNEL);
      expect({
        facts: await rowSelect(seeded.scope, "lease_expires_at <= clock_timestamp() as expired, lease_owner is not null as owned"),
        stillMax: await maxFacts(seeded.scope),
        unchanged: (await rowDigestExcept(seeded.scope, ["lease_expires_at"])) === before,
      }).toEqual({ facts: { expired: true, owned: true }, stillMax: MAX_FACTS, unchanged: true });
    });

    it("test-only agePublicProof: only public_checked_at moves, by exactly the aged days", async () => {
      const seeded = await maxFixture();
      const before = await rowDigestExcept(seeded.scope, ["public_checked_at"]);
      await agePublicProof(seeded.scope.teamId, CHANNEL, 7);
      expect({
        facts: await rowSelect(seeded.scope, "public_checked_at = timestamptz '2026-01-01 00:00:00+00' - interval '7 days' as aged_exactly"),
        stillMax: await maxFacts(seeded.scope),
        unchanged: (await rowDigestExcept(seeded.scope, ["public_checked_at"])) === before,
      }).toEqual({ facts: { aged_exactly: true }, stillMax: MAX_FACTS, unchanged: true });
    });

    it("ensureSlackChannel on an existing row: insert-on-conflict-do-nothing neither updates nor rechecks it", async () => {
      const seeded = await maxFixture();
      const before = await rowDigestExcept(seeded.scope, []);
      // The row version: any UPDATE, even one writing identical values, gives the row a new `xmin`.
      const versionBefore = (await rowSelect(seeded.scope, "xmin::text as version")).version;
      const ensured = await tx((session) => ensureSlackChannel(session, seeded.scope));
      const versionAfter = (await rowSelect(seeded.scope, "xmin::text as version")).version;
      expect({
        inserted: ensured.inserted, leakFree: leakFree(ensured, seeded),
        versionRead: typeof versionBefore === "string", versionKept: versionAfter === versionBefore,
        unchanged: (await rowDigestExcept(seeded.scope, [])) === before,
      }).toEqual({ inserted: false, leakFree: true, versionRead: true, versionKept: true, unchanged: true });
    });
  });
});

const ORACLE_TICKS = BigInt(1_000_000);
/** The test's OWN exact ticks of a timestamp or bound (never a product helper). */
function exactOracleTicks(value: string): bigint {
  const match = /^([0-9]+)[.]([0-9]{1,6})$/.exec(value);
  if (!match) throw new Error("fixture: not an exact timestamp");
  return BigInt(match[1]) * ORACLE_TICKS + BigInt(match[2].padEnd(6, "0"));
}
/** The test's OWN canonical rendering of exact ticks. */
function renderTicks(ticks: bigint): string {
  return `${(ticks / ORACLE_TICKS).toString()}.${(ticks % ORACLE_TICKS).toString().padStart(6, "0")}`;
}

/**
 * A claim that is expected to THROW, projected to its error name and its static message. The message
 * of every state-writer validation error is a fixed sentence, which is exactly what this asserts.
 */
async function claimFailure(scope: SlackChannelScope, integrationId: string, skewAllowanceMs: number): Promise<Record<string, unknown>> {
  try {
    const result = await tx((session) => claimSlackChannelPage(session, scope, {
      bindingIntegrationId: integrationId, bindingConfigRevision: REVISION, skewAllowanceMs,
    }));
    return { returned: result === null ? "null" : typeof result };
  } catch (error) {
    const e = (error ?? {}) as { name?: unknown; message?: unknown };
    return { name: typeof e.name === "string" ? e.name : null, message: typeof e.message === "string" ? e.message : null };
  }
}

/** Columns a historical claim may change: lease bookkeeping, the frozen anchor, attempt-oldest reset, and S/U. */
const CLAIM_PERMITTED = [
  "claimed_lane", "lease_owner", "lease_generation", "lease_expires_at", "attempts", "updated_at",
  "historical_anchor_ts", "historical_oldest_seen_ts", "historical_segment_lower_ts", "historical_segment_upper_ts",
];
/** Columns a claim of an already-initialized lane may change: lease bookkeeping only. */
const LEASE_BOOKKEEPING = ["claimed_lane", "lease_owner", "lease_generation", "lease_expires_at", "attempts", "updated_at"];
/** The canonical bound spelling (§4): seconds without leading zeroes, a dot, six digits. */
const CANONICAL_BOUND = /^(0|[1-9][0-9]{0,11})[.][0-9]{6}$/;

/**
 * The claim's fence values, read from an `unknown` so the expectation does not depend on how a later
 * typed claim result is spelled:
 *  - the lane;
 *  - the bound strings;
 *  - the scan generation;
 *  - the newest-only logical lower (`lowerTs`, always null on the historical lane);
 *  - whether the cursor is null. The cursor value itself is never kept.
 */
function claimBounds(claim: unknown): Record<string, unknown> {
  const value = (claim ?? {}) as Record<string, unknown>;
  return {
    lane: value.lane, anchorTs: value.anchorTs, requestLowerTs: value.requestLowerTs,
    segmentLowerTs: value.segmentLowerTs, segmentUpperTs: value.segmentUpperTs,
    scanGeneration: value.scanGeneration, lowerTs: value.lowerTs, cursorNull: value.cursor === null,
  };
}

/**
 * A public, bound, due channel whose lanes have NO segment. Both lanes are inactive unless anchored:
 *  - `historical_anchor_ts` anchors the historical lane;
 *  - `newest_anchor_ts` with `newest_lower_ts` (B) anchors the newest lane.
 * Either is the all-null initialization tuple §4 permits: L/S/U null, cursor null, history `[]`. Only
 * the named columns may be overridden.
 */
async function seedUnsegmentedChannel(over: {
  public_state?: "public" | "private";
  historical_anchor_ts?: string;
  completed_lower_ts?: string;
  completed_upper_ts?: string;
  next_lane?: "newest" | "historical";
  newest?: { anchor: string; lower: string };
}): Promise<{ scope: SlackChannelScope; integrationId: string }> {
  const seed = await seedTeam();
  const scope = { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL };
  const integrationId = await tx(async (session) => (await session.executeSql<{ id: string }>(
    `insert into integrations (team_id, type, name) values ($1, 'slack', 'history-init-binder') returning id::text as id`, [seed.teamId]
  )).rows[0].id);
  await tx((session) => session.executeSql(
    `insert into slack_sync_channels
       (team_id, workspace_id, channel_id, public_state, public_checked_at, binding_integration_id, binding_config_revision,
        historical_anchor_ts, completed_lower_ts, completed_upper_ts, next_lane, newest_anchor_ts, newest_lower_ts, due_at)
     values ($1, $2, $3, $4, '2026-01-01 00:00:00+00', $5::uuid, $6, $7, $8, $9, $10, $11, $12, '2020-01-01 00:00:00+00')`,
    [seed.teamId, WORKSPACE, CHANNEL, over.public_state ?? "public", integrationId, REVISION,
      over.historical_anchor_ts ?? null, over.completed_lower_ts ?? null, over.completed_upper_ts ?? null, over.next_lane ?? "historical",
      over.newest?.anchor ?? null, over.newest?.lower ?? null]
  ));
  return { scope, integrationId };
}

/** The stored historical initialization, as booleans against literal expectations. */
async function historicalInitFacts(scope: SlackChannelScope, anchor: string, upper: string) {
  return tx(async (session) => (await session.executeSql<Record<string, unknown>>(
    `select historical_anchor_ts is not distinct from $4 as anchor_is_expected,
            historical_segment_lower_ts is not distinct from '0.000000' as lower_is_floor,
            historical_segment_upper_ts is not distinct from $5 as upper_is_expected,
            historical_cursor is null and historical_cursor_history = '[]'::jsonb as cursor_history_empty,
            historical_oldest_seen_ts is null as attempt_oldest_null,
            newest_anchor_ts is null and newest_request_lower_ts is null and newest_segment_lower_ts is null
              and newest_segment_upper_ts is null and newest_cursor is null and newest_cursor_history = '[]'::jsonb as newest_inactive
       from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId, anchor, upper]
  )).rows[0]);
}

/** The anchored-but-uninitialized newest lane, against its exact seeded bytes (booleans only). */
async function newestUninitializedFacts(scope: SlackChannelScope, anchor: string, lower: string) {
  return tx(async (session) => (await session.executeSql<Record<string, unknown>>(
    `select newest_anchor_ts is not distinct from $4 as anchor_bytes_exact,
            newest_lower_ts is not distinct from $5 as lower_bytes_exact,
            newest_request_lower_ts is null and newest_segment_lower_ts is null and newest_segment_upper_ts is null as bounds_null,
            newest_cursor is null and newest_cursor_history = '[]'::jsonb as cursor_history_empty
       from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId, anchor, lower]
  )).rows[0]);
}

// ── packet 3 helpers: newest-lane claim initialization ────────────────────────────────────────────

/** Columns a NEWEST claim may change: lease bookkeeping, the frozen A and B, and the newest L/S/U. */
const NEWEST_CLAIM_PERMITTED = [
  ...LEASE_BOOKKEEPING,
  "newest_anchor_ts", "newest_lower_ts", "newest_request_lower_ts", "newest_segment_lower_ts", "newest_segment_upper_ts",
];
/** Columns the L > A bookkeeping may change (§5): the turn, the diagnostic, due_at and updated_at. */
const L_ABOVE_A_PERMITTED = ["next_lane", "last_error_code", "due_at", "updated_at"];
const ORACLE_MICROS = BigInt(1_000_000);

/**
 * The test's OWN oracle for L = max(0, B − allowance), with BigInt microseconds only. It is never the
 * product's helper and never `Number` arithmetic on a timestamp. B may be a noncanonical spelling;
 * the result is canonical (seconds without leading zeroes, six fraction digits).
 */
function boundMinusAllowance(bound: string, allowanceMs: bigint): string {
  const match = /^([0-9]+)[.]([0-9]{1,6})$/.exec(bound);
  if (!match) throw new Error("fixture: the bound is not an exact timestamp");
  const lowered = BigInt(match[1]) * ORACLE_MICROS + BigInt(match[2].padEnd(6, "0")) - allowanceMs * BigInt(1_000);
  const clamped = lowered < BigInt(0) ? BigInt(0) : lowered;
  return `${(clamped / ORACLE_MICROS).toString()}.${(clamped % ORACLE_MICROS).toString().padStart(6, "0")}`;
}

/**
 * Claim with a configured skew allowance. The option travels in a NON-literal object, so this
 * compiles against today's claim signature (which has no such option and ignores it at runtime). The
 * result is `unknown`: either a claim, null, a typed delay, or a sanitized exception.
 */
async function claimNewest(scope: SlackChannelScope, integrationId: string, skewAllowanceMs: number): Promise<unknown> {
  const opts = { bindingIntegrationId: integrationId, bindingConfigRevision: REVISION, skewAllowanceMs };
  return tx((session) => claimSlackChannelPage(session, scope, opts)).catch(sanitized);
}

/** A typed claim outcome, projected from `unknown`: only its outcome, category and static detail. */
function typedOutcome(result: unknown): Record<string, unknown> {
  const value = (result ?? {}) as Record<string, unknown>;
  return { outcome: value.outcome, category: value.category, detail: value.detail };
}

type NewestSeed = Partial<{
  public_state: "public" | "private";
  newest_anchor_ts: string;
  newest_lower_ts: string;
  newest_scan_generation: number;
  historical_anchor_ts: string;
  historical_segment_lower_ts: string;
  historical_segment_upper_ts: string;
  historical_cursor: string;
  historical_cursor_history: string[];
  historical_scan_generation: number;
  completed_lower_ts: string;
  completed_upper_ts: string;
  historical_floor_reached: boolean;
}>;

/**
 * A public, bound, due channel whose NEXT lane is newest. Its newest lane has no segment: it is idle,
 * or anchored with B as the all-null initialization tuple §4 permits. Every column is a literal from
 * `over`, or empty by default; histories default to `[]`.
 */
async function seedNewestCandidate(over: NewestSeed): Promise<{ scope: SlackChannelScope; integrationId: string }> {
  const seed = await seedTeam();
  const scope = { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL };
  const integrationId = await tx(async (session) => (await session.executeSql<{ id: string }>(
    `insert into integrations (team_id, type, name) values ($1, 'slack', 'newest-init-binder') returning id::text as id`, [seed.teamId]
  )).rows[0].id);
  await tx((session) => session.executeSql(
    `insert into slack_sync_channels
       (team_id, workspace_id, channel_id, public_state, public_checked_at, binding_integration_id, binding_config_revision,
        newest_anchor_ts, newest_lower_ts, newest_scan_generation,
        historical_anchor_ts, historical_segment_lower_ts, historical_segment_upper_ts,
        historical_cursor, historical_cursor_history, historical_scan_generation,
        completed_lower_ts, completed_upper_ts, historical_floor_reached, next_lane, due_at)
     values ($1, $2, $3, $4, '2026-01-01 00:00:00+00', $5::uuid, $6,
             $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, 'newest', '2020-01-01 00:00:00+00')`,
    [seed.teamId, WORKSPACE, CHANNEL, over.public_state ?? "public", integrationId, REVISION,
      over.newest_anchor_ts ?? null, over.newest_lower_ts ?? null, over.newest_scan_generation ?? 0,
      over.historical_anchor_ts ?? null, over.historical_segment_lower_ts ?? null, over.historical_segment_upper_ts ?? null,
      over.historical_cursor ?? null, JSON.stringify(over.historical_cursor_history ?? []), over.historical_scan_generation ?? 0,
      over.completed_lower_ts ?? null, over.completed_upper_ts ?? null, over.historical_floor_reached ?? false]
  ));
  return { scope, integrationId };
}

/** The stored newest initialization against literal expectations (booleans only). */
async function newestInitFacts(scope: SlackChannelScope, expected: { anchor: string; lower: string; requestLower: string; upper: string }) {
  return tx(async (session) => (await session.executeSql<Record<string, unknown>>(
    `select newest_anchor_ts is not distinct from $4 as anchor_is_expected,
            newest_lower_ts is not distinct from $5 as lower_is_expected,
            newest_request_lower_ts is not distinct from $6 as request_lower_is_expected,
            newest_segment_lower_ts is not distinct from $6 and newest_segment_upper_ts is not distinct from $7 as segment_is_expected,
            newest_cursor is null and newest_cursor_history = '[]'::jsonb as cursor_history_empty
       from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId, expected.anchor, expected.lower, expected.requestLower, expected.upper]
  )).rows[0]);
}

/** The database clock, as full-precision timestamptz text (never parsed in JavaScript). */
async function dbClockText(): Promise<string> {
  return tx(async (session) => (await session.executeSql<{ now: string }>(`select clock_timestamp()::text as now`)).rows[0].now);
}

/**
 * The L > A bookkeeping (§5): the opposite turn, the diagnostic and no lease. due_at and updated_at
 * must each lie inside the database-clock window taken around the claim, as booleans.
 */
async function delayBookkeeping(scope: SlackChannelScope, clockBefore: string, clockAfter: string) {
  return tx(async (session) => (await session.executeSql<Record<string, unknown>>(
    `select next_lane, last_error_code,
            lease_owner is null and lease_expires_at is null and claimed_lane is null as lease_absent,
            due_at between $4::timestamptz and $5::timestamptz as due_in_window,
            updated_at between $4::timestamptz and $5::timestamptz as updated_in_window
       from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId, clockBefore, clockAfter]
  )).rows[0]);
}
