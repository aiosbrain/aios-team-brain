import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { audit } from "@/lib/api/audit";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { decideReattribution } from "@/lib/ingest/reattribution-decision";
import { recordReassignment, ownerWindowStart } from "@/lib/ingest/reassignment-log";
import type { ItemPayload } from "@/lib/api/item-payload-schema";
import {
  itemPayloadSchema,
  IngestValidationError,
  TierViolationError,
} from "@/lib/api/schemas";
import type { DbClient, TransactionSession } from "@/lib/db/types";
import { materializeDecisions } from "@/lib/ingest/decisions";
import { sourceRules } from "@/lib/ingest/source-rules";
import { forgetSupersededBodies } from "@/lib/ingest/forget-bodies";
import { workTimeKeysIn } from "@/lib/ingest/work-time";
import {
  materializeFacts,
  materializeStakeholderMentions,
} from "@/lib/ingest/evidence";
import { materializeTasks, validateTaskRows } from "@/lib/ingest/tasks";
import { resolvePersistedWorkTime } from "@/lib/ingest/work-time";
import {
  cascadeInheritedAudience,
  settleReclassification,
} from "@/lib/ingest/reclassify";
import {
  lockIngestIdentity,
  lockItemContext,
  refreshLockedItemContext,
  runContextTransaction,
  transactionCapability,
  type LockedItemAuthority,
} from "@/lib/projects/context/transaction";
import {
  reconcileLockedItemContext,
  validatedSystemProjectIds,
  type SystemProjectIds,
} from "@/lib/projects/context/reconcile-item";
import { systemIntegrityGate } from "@/lib/projects/context/memberships";
import { mergeGdriveContributions } from "@/lib/ingest/gdrive-ledger";
import { syncGdriveContributionEvidence } from "@/lib/ingest/gdrive-contribution-store";
import { validateIdentityAuthorityRevision } from "@/lib/identity/authority";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import type { ApiAuth } from "@/lib/api/auth";
import { withBoundedLockWaits } from "@/lib/db/pg/bounded-lock";
import { afterTransactionCommit, ambientTransactionClient, runSql, withTransaction } from "@/lib/db/pg/pool";
import { isPgClient } from "@/lib/db/pg/client";
import { lockItemAttribution } from "@/lib/ingest/item-attribution-lock";
import {
  driveCollisionSafePath,
  drivePathIdentityKey,
  driveRequestPathIdentities,
  GdriveIngestStateChangedError,
  lockGdriveIngestIdentities,
  planGdriveIngest,
  runGdriveIngestAttempts,
  type GdriveIngestLocks,
  type GdriveIngestPlan,
} from "@/lib/ingest/gdrive-commit-locks";
import {
  GdriveAuthorityError,
  type GdriveExecutionRef,
  withGdriveExecutionCommit,
} from "@/lib/integrations/gdrive-authority";
import {
  lockProjectRows,
  ProjectPlanChangedError,
  resolveSourceProject,
  systemDestinationProjectIds,
  type ProjectSqlExecutor,
} from "@/lib/projects/project-row-locks";

export { mergeGdriveContributions } from "@/lib/ingest/gdrive-ledger";

export interface IngestResult {
  status: "created" | "updated" | "unchanged";
  id: string;
  projectId?: string;
  changedTaskRowKeys?: string[];
  /**
   * True when this ingest changed the item's `access` tier — including the HEAL-ACCESS path on an
   * unchanged-body re-push (`status:"unchanged"` but `access` moved external↔team). The context
   * hook must re-partition on THIS, not on status: a tier reclassification is exactly the move
   * slice-4 H2 guards, and it arrives as `status:"unchanged"` (slice-5 Fable HIGH).
   */
  accessChanged?: boolean;
}

interface CommittedIngest {
  result: IngestResult;
  postCommit?: {
    from: "team" | "external";
    to: "team" | "external";
    source: unknown;
  };
  contextRefusal?: string;
}

export interface AttributionOverride {
  authorMemberId: string | null;
  /** Mapping-derived credit is valid only at this complete team identity revision. Omitted means the
   * caller supplied an explicit/manual actor (meeting submitter, correction, trusted internal fact)
   * and no mutable resolver snapshot was consulted. */
  mappingRevision?: number;
}

/** Deterministic concurrency seams for real-Postgres serialization regressions. */
export interface IngestConcurrencyHooks {
  beforeAttributionLock?: (itemId: string) => Promise<void>;
  afterAttributionLock?: (itemId: string) => Promise<void>;
  afterAttributionRead?: (itemId: string) => Promise<void>;
  /** Start of each whole attempt of a Drive-sourced public ingest (1, then 2 after a state change). */
  beforeDriveAttempt?: (attempt: number) => Promise<void>;
}

/** A Drive commit: the connection claim to publish, and the locks `ingestGdriveApiItem` already holds. */
interface GdriveIngestCommit {
  claim: {
    integrationId: string;
    providerId: string;
    generation: number;
    audienceProjectIds: readonly string[];
  };
  storageProjectId: string;
  locks: GdriveIngestLocks;
}

interface IngestInternalOptions {
  transactionBound?: boolean;
  concurrencyHooks?: IngestConcurrencyHooks;
  /** Set only by `ingestGdriveApiItem`. Named, so it never competes for a positional slot. */
  gdrive?: GdriveIngestCommit;
  /** Set only by `ingestApiItem` for a payload that is not Drive-sourced: the refusal to raise when
   * the row this ingest locks turns out to be Drive-owned. */
  refuseDriveOwnedTarget?: () => Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The pg adapter returns timestamptz as a Date; normalize to the ISO strings we compare and store. */
function isoOf(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * THE change key: sha256 over the body exactly as we are about to store it. Every producer already
 * computes `sha256(utf8(body))` (TS normalizers + the Python sidecar's `sha256_hex`), so for a
 * correct client this equals the wire `content_sha256` and nothing changes.
 *
 * It is computed HERE, server-side, because the wire field is untrusted input and dedup integrity is
 * the contract's own invariant — not something to delegate to every present and future connector. A
 * client that hashes a slightly different normalization (CRLF, NFC/NFD) would otherwise mark every
 * push "changed" (endless version/embed/projection churn); worse, a client that repeats a STALE sha
 * while the body changed would hit the unchanged fast-path and the stored body would silently never
 * update — permanently stale content served to retrieval with no error anywhere. Hashing the body we
 * hold makes both impossible by construction.
 */
export function contentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** A payload that is not Drive-sourced may never write an item Drive owns. */
function driveOwnedTargetRefusal(execution: GdriveExecutionRef | undefined): GdriveAuthorityError {
  return execution
    ? new GdriveAuthorityError("wrong_connection", "Google Drive payload is not bound to this authorized connection", 403)
    : new GdriveAuthorityError("connector_principal_required", "current Google Drive execution authority is required for this stored item", 403);
}

/**
 * Public-ingest owner. A Drive-sourced payload commits only under its connection's execution fence
 * (`ingestGdriveApiItem`); any other payload is refused if the item at its path is Drive-owned, so
 * omitting or relabeling incoming provenance cannot skip the immutable connection fence.
 */
export async function ingestApiItem(
  db: DbClient,
  auth: ApiAuth,
  rawPayload: ItemPayload,
  access: "team" | "external",
  opts: AttributionOverride | undefined,
  pusherTier: "team" | "external",
  execution?: GdriveExecutionRef,
  concurrencyHooks: IngestConcurrencyHooks = {},
): Promise<IngestResult> {
  if (rawPayload.frontmatter?.source === "gdrive") {
    return ingestGdriveApiItem(db, auth, rawPayload, opts, pusherTier, execution, concurrencyHooks);
  }
  // Shared ingest order: project → path identity → item-attribution advisory → item row. This
  // wrapper takes NO lock and opens NO transaction of its own. A path, attribution or item lock
  // here would be held before the project `ingestItem` sets up — and a Drive commit holds that
  // project row while it waits for exactly those locks.
  //
  // So this read is unlocked, and it may only REFUSE: a Drive-owned row at the path is turned away
  // before any project is touched. It authorizes nothing. The decision that counts is made by
  // `ingestItem` on the row it has locked (`refuseDriveOwnedTarget`), inside the project → path →
  // attribution → item boundary. Ownership is the provider mapping (whatever its legacy
  // `connection_id`, which is null for every claimed document) or the stored provenance.
  const { rows } = await runSql<{ item_source: string | null; drive_mapped: boolean }>(
    `select i.frontmatter->>'source' as item_source,
            exists(select 1 from source_item_mappings m
                    where m.team_id=i.team_id and m.source='gdrive' and m.item_id=i.id) as drive_mapped
       from items i join projects p on p.id=i.project_id and p.team_id=i.team_id
      where i.team_id=$1 and p.slug=$2 and i.path=$3`,
    [auth.teamId, rawPayload.project, rawPayload.path],
  );
  if (rows[0]?.item_source === "gdrive" || rows[0]?.drive_mapped === true) {
    throw driveOwnedTargetRefusal(execution);
  }
  return ingestItem(db,auth,rawPayload,access,opts,pusherTier,undefined,{
    concurrencyHooks,
    refuseDriveOwnedTarget:()=>driveOwnedTargetRefusal(execution),
  });
}

/**
 * The source project's own write, made only under its row lock and inside the publishing
 * transaction: the sync timestamp and (PCCC-4) the graph partition pointer — the null-guarded
 * pointer write makes the re-sync case a no-op. A refused or failed ingest rolls both back.
 */
async function touchSourceProject(db: DbClient, teamId: string, projectId: string, now: string): Promise<void> {
  const { error } = await db
    .from("projects")
    .update({ last_synced_at: now })
    .eq("team_id", teamId)
    .eq("id", projectId);
  if (error) throw new Error(`project sync timestamp failed: ${error.message}`);
  const ptr = await ensureProjectGraphPointer(db, { teamId, projectId });
  if (!ptr.ok) throw new Error(ptr.error);
}

/**
 * PROJECT BEFORE ITEM for an ingest that is not a Drive commit, inside its own context session so
 * a savepoint rollback releases every lock taken here.
 *
 * Plans with unlocked reads — the source project by slug (created here, in this transaction, when
 * absent), the system projects a context move can place into, and for a Drive-sourced payload the
 * projects its provider mapping and candidate items live in — then takes the whole set in one
 * ascending pass: the source `for no key update`, everything else `for key share`. The plan
 * authorizes nothing; the slug is re-read under the lock, and a planned row that is gone abandons
 * the attempt instead of being replaced by a later lock.
 */
async function acquireIngestProjects(
  session: TransactionSession,
  input: { teamId: string; slug: string; path: string; driveSourceId: string; now: string },
): Promise<{ sourceProjectId: string; lockedProjectIds: ReadonlySet<string> }> {
  const exec: ProjectSqlExecutor = <T,>(text: string, params?: unknown[]) => session.executeSql<T>(text, params);
  // The same 10-second bound as the session's identity and item acquisitions.
  return withBoundedLockWaits(async () => {
    const source = await resolveSourceProject(exec, input.teamId, input.slug, input.now);
    const reference = input.driveSourceId
      // Drive context is claim-derived, never system-routed; what it can reference is where the
      // document already lives.
      ? (await planGdriveIngest({
          teamId: input.teamId,
          storageProjectId: source.id,
          requestedPath: input.path,
          providerId: input.driveSourceId,
        })).referenceProjectIds
      : await systemDestinationProjectIds(exec, input.teamId);
    const locked = await lockProjectRows(exec, input.teamId, { write: [source.id], share: [], reference });
    if (locked.get(source.id.toLowerCase()) !== input.slug) {
      throw new ProjectPlanChangedError("the source project was removed or renamed before its row lock");
    }
    if (reference.some((id) => !locked.has(id.toLowerCase()))) {
      throw new ProjectPlanChangedError("a planned project was removed before its row lock");
    }
    return { sourceProjectId: source.id, lockedProjectIds: new Set(locked.keys()) };
  });
}

/**
 * Drive-sourced public ingest, in the shared ingest lock order (`lib/ingest/gdrive-commit-locks`):
 * identity authority/revision → connection authority → the complete project set → provider
 * identity → path identities → item-attribution advisories → item rows → dependent rows. Source
 * reconciliation takes the same connection → project → provider prefix, and every other ingest is
 * project-before-item too, so none can hold another's next lock.
 *
 * The project set is PLANNED (unlocked reads) once the connection authority is held, and taken
 * whole: the storage project for write, the audience for share, and the project a canonical item
 * already lives in by key. Nothing is acquired or strengthened afterwards. Every outer wait is
 * bounded (10s; 55P03 is not retried). A plan that does not survive its locks abandons the whole
 * attempt, which is planned again once.
 */
async function ingestGdriveApiItem(
  db: DbClient,
  auth: ApiAuth,
  rawPayload: ItemPayload,
  opts: AttributionOverride | undefined,
  pusherTier: "team" | "external",
  execution: GdriveExecutionRef | undefined,
  concurrencyHooks: IngestConcurrencyHooks,
): Promise<IngestResult> {
  const frontmatter: Record<string, unknown> = rawPayload.frontmatter ?? {};
  const providerId = typeof frontmatter.source_id === "string" ? frontmatter.source_id.trim() : "";
  const connectionId = typeof frontmatter.connection_id === "string" ? frontmatter.connection_id.trim() : "";
  if (!execution) {
    throw new GdriveAuthorityError("connector_principal_required", "current Google Drive execution authority is required for this stored item", 403);
  }
  if (!providerId || connectionId !== execution.integrationId) {
    throw new GdriveAuthorityError("wrong_connection", "Google Drive payload is not bound to this authorized connection", 403);
  }
  const ref: GdriveExecutionRef = execution;
  const mappingRevision = opts?.mappingRevision;
  const commit = () => withTransaction(async () => {
    if (mappingRevision !== undefined) {
      await withBoundedLockWaits(() => validateIdentityAuthorityRevision(auth.teamId, mappingRevision));
    }
    // Per attempt: a retry plans again from nothing.
    let plan: GdriveIngestPlan | null = null;
    return withGdriveExecutionCommit(auth, ref, async (audience) => {
      if (!plan) throw new Error("Google Drive ingest reached its commit without a project plan");
      const storageProjectId = plan.storageProjectId;
      // The plan read the storage project by slug without a lock. Under its row lock it must still
      // be that project, or the whole plan is about the wrong rows.
      if (audience.lockedProjects.get(storageProjectId.toLowerCase()) !== rawPayload.project) {
        throw new GdriveIngestStateChangedError("the storage project was removed or renamed before its row lock");
      }
      const locks = await lockGdriveIngestIdentities({
        plan,
        lockedProjectIds: new Set(audience.lockedProjects.keys()),
        hooks: concurrencyHooks,
      });
      return ingestItem(
        db,
        auth,
        rawPayload,
        // Context memberships are the authority. External is the conservative inherited unit tier:
        // it may enter either a restricted team project or an external-visible project without the
        // no-widening gate ever laundering a team unit into an external grant.
        "external",
        opts,
        pusherTier,
        undefined,
        {
          transactionBound: true,
          concurrencyHooks: { afterAttributionRead: concurrencyHooks.afterAttributionRead },
          gdrive: {
            claim: {
              integrationId: ref.integrationId,
              providerId,
              generation: ref.generation,
              audienceProjectIds: audience.projectIds,
            },
            storageProjectId,
            locks,
          },
        },
      );
    }, {
      // Runs with the connection authority held and no project row locked yet. An absent storage
      // project is created here, in this commit's transaction: a failed attempt rolls it back.
      projects: async () => {
        // Nothing has been written yet. A push that could not be published anyway — a payload that
        // fails validation, a client that cannot run the publishing transaction — is refused here,
        // after the authority refusals and before the storage project can be created.
        parseIngestPayload(rawPayload, "external");
        transactionCapability(db);
        const storage = await resolveSourceProject(runSql, auth.teamId, rawPayload.project, new Date().toISOString());
        plan = await planGdriveIngest({
          teamId: auth.teamId,
          storageProjectId: storage.id,
          requestedPath: rawPayload.path,
          providerId,
        });
        return { writeProjectIds: [plan.storageProjectId], referenceProjectIds: plan.referenceProjectIds };
      },
    });
  });
  const attempt = async (number = 1) => {
    await concurrencyHooks.beforeDriveAttempt?.(number);
    return commit();
  };
  // A retry is a WHOLE attempt only when this call owns the transaction. Joined to a caller's, the
  // locks would survive the "retry"; that caller owns the transaction and so owns any retry.
  return ambientTransactionClient() ? attempt() : runGdriveIngestAttempts(attempt);
}

function canonicalJson(value: unknown): string {
  function normalize(nested: unknown): unknown {
    if (Array.isArray(nested)) return nested.map(normalize);
    if (!isRecord(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)])
    );
  }
  return JSON.stringify(normalize(value));
}

/** Strict whole-request validation, before any project, item, or version write. */
function parseIngestPayload(rawPayload: ItemPayload, access: "team" | "external") {
  const parsedPayload = itemPayloadSchema.safeParse({
    ...rawPayload,
    access: rawPayload.access ?? access,
  });
  if (!parsedPayload.success) {
    throw new IngestValidationError(
      `invalid item payload: ${parsedPayload.error.issues[0]?.message ?? "bad shape"}`
    );
  }
  return parsedPayload.data;
}

/**
 * Sole writer for synced items and their structured row projections.
 * The payload is re-parsed here so every internal and HTTP producer receives the same
 * strict whole-request validation before any project, item, or version write.
 */
export async function ingestItem(
  db: DbClient,
  auth: { teamId: string; memberId: string; apiKeyId: string },
  rawPayload: ItemPayload,
  access: "team" | "external",
  // Attribution override, set by the CALLER (never a raw wire field). Internal callers that already
  // know the author pass it (the codebase scanner; the pm-sync per-author paths). The `/api/v1/items`
  // route DERIVES it from the push's frontmatter via `attributeIncomingItem` — but ONLY for trusted
  // TEAM-tier keys (it skips external-tier keys), so an untrusted external pusher still can't spoof
  // authorship onto a team member. When an internal caller already knows the content's author it
  // passes that here; otherwise (opts omitted entirely) the item is attributed to the ingesting actor
  // (`auth.memberId`). A caller that HAS attempted resolution but come up empty must pass
  // `authorMemberId: null` explicitly (not omit opts) — that's the only way to say "leave this
  // unattributed" rather than "attribute to whoever's pushing," so a connector ingesting on behalf of
  // an unresolved human never silently falls back to the connector's own member_id.
  opts?: AttributionOverride,
  // Tier of the PRINCIPAL pushing this item. Only a trusted (`team`) pusher may change an existing
  // item's `access` (reclassification) — an `external`-tier key must never RAISE a team item's
  // visibility by re-pushing it (see the access-heal on the unchanged path). Defaults to `team`
  // because every INTERNAL caller (connectors, scanner, meetings) is trusted; ONLY the public
  // `/api/v1/items` route passes the real key tier, so an untrusted external key is gated out.
  pusherTier: "team" | "external" = "team",
  // The seventh positional slot is deliberately EMPTY on this branch. The Slack publication option
  // (PR 714) lands here; nothing else may. Source-specific extensions of this branch are named
  // fields of `_internal` instead, so the two can never be mistaken for one another.
  _reserved?: undefined,
  _internal: IngestInternalOptions = {},
): Promise<IngestResult> {
  const mappingRevision=opts?.mappingRevision;
  const gdriveCommit = _internal.gdrive;
  // Every production caller receives one transaction. It is the lifetime of both the canonical item
  // attribution lock and all item/version/contribution writes. Unit DbClient fakes deliberately skip
  // PostgreSQL-only mechanics; every runtime DbClient is a PgClient (lib/db/types.ts).
  if (!_internal.transactionBound && isPgClient(db)) {
    return withTransaction(() => ingestItem(
      db, auth, rawPayload, access, opts, pusherTier, undefined,
      {..._internal,transactionBound:true},
    ));
  }
  // Payload and capability first: neither reads nor mutates anything, and a push that fails either
  // must not have taken a lock or touched a project.
  const requestedPayload = parseIngestPayload(rawPayload, access);
  // Fail before project/pointer writes when a legacy wrapper forgot to delegate transactions.
  transactionCapability(db);
  // The identity revision fence precedes every protected mutation, the source project's included.
  if (mappingRevision !== undefined) {
    await validateIdentityAuthorityRevision(auth.teamId,mappingRevision);
  }
  // A path identity has ONE key — the in-session ingest identity, by project id — and it closes
  // the two-new-writer race for every caller, so nothing path- or item-shaped is taken before the
  // project. (A slug-keyed path advisory used to be taken here: a second key for the same identity,
  // held before the project, which is the inverse of the order a Drive commit holds them in.)
  const requestedDriveSourceId =
    requestedPayload.frontmatter?.source === "gdrive" && typeof requestedPayload.frontmatter.source_id === "string"
      ? requestedPayload.frontmatter.source_id.trim()
      : "";
  // Authoritative change key (see contentHash). The wire `content_sha256` is advisory from here on:
  // a mismatch means the pushing client hashes something other than the body it sent, which we record
  // on the item's audit row (below) so a buggy connector is diagnosable instead of silently corrupting
  // dedup. It is NOT rejected — the body is the source of truth and we can always hash it correctly.
  const contentSha = contentHash(requestedPayload.body);
  const shaMismatch = contentSha !== requestedPayload.content_sha256;
  const now = new Date().toISOString();

  // What an UNLOCKED lookup may read: which row a push is about (identity and location) and the
  // provenance that decides a Drive adoption. Nothing here is authority — content hash, tier and
  // attribution are read exactly once, from the row lock (`lockItemContext`), never before it.
  const candidateFields = "id, project_id, path, frontmatter";
  type CandidateItem = { id: string; project_id: string; path: string; frontmatter: Record<string, unknown> | null };
  type ExistingItem = LockedItemAuthority & { project_id: string; path: string };
  // The unbound client. Inside the session below `db` is the session's own client; the Drive claim
  // writers open their own (joined) context sessions and so must be handed this one instead.
  const rootDb = db;

  const committed = await runContextTransaction(db, async (session) => {
    const db = session.db;
    // PROJECT BEFORE ITEM, inside this publication's own transaction and this session's savepoint:
    // the project a push creates, the sync timestamp it advances and the graph pointer it sets
    // commit with the item, version, evidence and context writes below or not at all, and a
    // retried attempt releases its project locks with everything else it took.
    let projectId: string;
    // Every project row this transaction holds. Null only off the runtime path — a unit fake, or a
    // test decorator around the client — where there is no ambient transaction to plan and bound
    // in; there the source project is still written first, and inside this session.
    let lockedProjectIds: ReadonlySet<string> | null = null;
    if (gdriveCommit) {
      // The commit planned and locked its complete set — this storage project for write — before
      // its provider, path, attribution and item locks. Nothing is acquired here.
      projectId = gdriveCommit.storageProjectId;
      lockedProjectIds = gdriveCommit.locks.projectIds;
    } else if (isPgClient(rootDb)) {
      const acquired = await acquireIngestProjects(session, {
        teamId: auth.teamId,
        slug: requestedPayload.project,
        path: requestedPayload.path,
        driveSourceId: requestedDriveSourceId,
        now,
      });
      projectId = acquired.sourceProjectId;
      lockedProjectIds = acquired.lockedProjectIds;
    } else {
      const { data: upserted, error: projectError } = await db
        .from("projects")
        .upsert(
          { team_id: auth.teamId, slug: requestedPayload.project, last_synced_at: now },
          { onConflict: "team_id,slug" }
        )
        .select("id")
        .single();
      if (projectError || !upserted) {
        throw new Error(`project upsert failed: ${projectError?.message}`);
      }
      projectId = upserted.id as string;
    }
    if (lockedProjectIds) {
      await touchSourceProject(db, auth.teamId, projectId, now);
    } else {
      // The fake's upsert carried the timestamp; only the pointer is left.
      const ptr = await ensureProjectGraphPointer(db, { teamId: auth.teamId, projectId });
      if (!ptr.ok) throw new Error(ptr.error);
    }
    const project = { id: projectId };
    /** A project resolved after the acquisition must already be held: it is never taken late. */
    const assertProjectHeld = (id: string, what: string) => {
      if (!lockedProjectIds || lockedProjectIds.has(id.toLowerCase())) return;
      throw gdriveCommit
        ? new GdriveIngestStateChangedError(`${what} was not among the planned projects`)
        : new ProjectPlanChangedError(`${what} was not among the planned projects`);
    };
    // Per attempt: Drive identity resolution may move the path, and a retry must start from the push.
    let payload = requestedPayload;
    // Google document identity is its exact provider id, not the normalized path. Historical gdrive
    // paths lower-cased/sanitized that id, so rename/move/reconnect must first recover the established
    // row through retained provenance. More than one match is an old collision: fail visibly rather
    // than guessing and overwriting an unrelated document.
    const gdriveSourceId = requestedDriveSourceId;
    if (gdriveSourceId) {
      // Both paths this document can be created at here — the requested one and its collision-safe
      // alternative — in the one order every Drive writer takes them, held from before the
      // existence checks below to after the insert. A Drive commit already holds them (re-entrant).
      for (const identity of driveRequestPathIdentities(auth.teamId, projectId, payload.path, gdriveSourceId)) {
        await lockIngestIdentity(session, auth.teamId, identity.projectId, identity.path);
      }
    } else {
      await lockIngestIdentity(session, auth.teamId, projectId, payload.path);
    }
    // Pre-lock identity candidate only. The authority row is read under the item lock below.
    let candidate: CandidateItem | null = null;

  let mappedItemId = "";
  let mappedProjectId: string | null = null;
  let mappedCanonicalPath: string | null = null;
  if (gdriveSourceId) {
    const { data: mapped, error: mappingError } = await db
      .from("source_item_mappings")
      .select("item_id, project_id, canonical_path")
      .eq("team_id", auth.teamId)
      .eq("source", "gdrive")
      .eq("provider_id", gdriveSourceId)
      .maybeSingle();
    if (mappingError) throw new Error(`gdrive identity mapping lookup failed: ${mappingError.message}`);
    const identity = mapped as { item_id?: string; project_id?: string | null; canonical_path?: string | null } | null;
    mappedItemId = identity?.item_id ?? "";
    mappedProjectId = identity?.project_id ?? null;
    mappedCanonicalPath = identity?.canonical_path ?? null;
    if (mappedItemId) {
      const { data: mappedItem, error: mappedItemError } = await db
        .from("items")
        .select(candidateFields)
        .eq("team_id", auth.teamId)
        .eq("id", mappedItemId)
        .maybeSingle();
      if (mappedItemError) throw new Error(`gdrive mapped item lookup failed: ${mappedItemError.message}`);
      candidate = mappedItem as CandidateItem | null;
    }
  }

  // A retained mapping is a tombstone as well as an identity map. If the content row was physically
  // removed, reconnect at its established collision-safe location instead of silently falling back to
  // the newly-normalized requested path. An occupied tombstone target is a visible repair condition —
  // never overwrite the unrelated row.
  if (gdriveSourceId && mappedItemId && !candidate && mappedCanonicalPath) {
    const targetProjectId = mappedProjectId ?? (project.id as string);
    const { data: occupant, error: occupantError } = await db
      .from("items")
      .select(candidateFields)
      .eq("team_id", auth.teamId)
      .eq("project_id", targetProjectId)
      .eq("path", mappedCanonicalPath)
      .maybeSingle();
    if (occupantError) throw new Error(`gdrive canonical path lookup failed: ${occupantError.message}`);
    if (occupant && (occupant as CandidateItem).id !== mappedItemId) {
      throw new IngestValidationError(
        `Drive canonical path collision for '${mappedCanonicalPath}' requires manual repair`,
      );
    }
  }
  if (gdriveSourceId && !candidate && !mappedItemId) {
    const { data: providerMatches, error: providerMatchError } = await db
      .from("items")
      .select(candidateFields)
      .eq("team_id", auth.teamId)
      .eq("frontmatter->>source", "gdrive")
      .eq("frontmatter->>source_id", gdriveSourceId)
      .limit(2);
    if (providerMatchError) {
      throw new Error(`gdrive identity lookup failed: ${providerMatchError.message}`);
    }
    const matches = (providerMatches ?? []) as CandidateItem[];
    if (matches.length > 1) {
      throw new IngestValidationError(
        `ambiguous historical gdrive identity '${gdriveSourceId}'; manual repair is required`
      );
    }
    candidate = matches[0] ?? null;
  }

  if (!candidate && !mappedItemId) {
    const { data, error } = await db
      .from("items")
      .select(candidateFields)
      .eq("team_id", auth.teamId)
      .eq("project_id", project.id)
      .eq("path", payload.path)
      .maybeSingle();
    if (error) throw new Error(`item identity lookup failed: ${error.message}`);
    const pathMatch = data as CandidateItem | null;
    if (!gdriveSourceId) {
      candidate = pathMatch;
    } else if (pathMatch) {
      const fm = isRecord(pathMatch.frontmatter) ? pathMatch.frontmatter : {};
      // A path is never Drive identity. Adopt only exact historical Drive provenance; otherwise
      // allocate a deterministic collision-safe path and leave the unrelated row untouched.
      if (fm.source === "gdrive" && fm.source_id === gdriveSourceId) {
        candidate = pathMatch;
      } else {
        const safePath = driveCollisionSafePath(payload.path, gdriveSourceId);
        payload = { ...payload, path: safePath };
        const { data: safeMatch, error: safeError } = await db
          .from("items").select(candidateFields).eq("team_id", auth.teamId)
          .eq("project_id", project.id).eq("path", safePath).maybeSingle();
        if (safeError) throw new Error(`collision-safe Drive identity lookup failed: ${safeError.message}`);
        const safe = safeMatch as CandidateItem | null;
        if (safe) {
          const safeFm = isRecord(safe.frontmatter) ? safe.frontmatter : {};
          if (safeFm.source !== "gdrive" || safeFm.source_id !== gdriveSourceId) {
            throw new IngestValidationError(`Drive path collision for '${payload.path}' requires manual repair`);
          }
          candidate = safe;
        }
      }
    }
  }

  // The id this session mints for a document with no item and no mapping yet. Nothing else can
  // know it, so it is the one canonical id a Drive commit may use without having locked it.
  let mintedDriveItemId: string | null = null;
  if (gdriveSourceId) {
    const minted = candidate || mappedItemId ? null : randomUUID();
    const proposedItemId = candidate?.id ?? (mappedItemId || minted!);
    const proposedProjectId = candidate?.project_id ?? mappedProjectId ?? (project.id as string);
    const proposedCanonicalPath = candidate?.path ?? mappedCanonicalPath ?? payload.path;
    const { error: mappingWriteError } = await db
      .from("source_item_mappings")
      .upsert(
        {
          team_id: auth.teamId,
          source: "gdrive",
          provider_id: gdriveSourceId,
          item_id: proposedItemId,
          connection_id: null,
          project_id: proposedProjectId,
          canonical_path: proposedCanonicalPath,
        },
        { onConflict: "team_id,source,provider_id", ignoreDuplicates: true },
      );
    if (mappingWriteError) {
      throw new Error(`gdrive identity mapping write failed: ${mappingWriteError.message}`);
    }
    const { data: mapping, error: mappingReadError } = await db
      .from("source_item_mappings")
      .select("item_id, project_id, canonical_path")
      .eq("team_id", auth.teamId)
      .eq("source", "gdrive")
      .eq("provider_id", gdriveSourceId)
      .single();
    if (mappingReadError || !mapping) {
      throw new Error(`gdrive identity mapping read failed: ${mappingReadError?.message}`);
    }
    const authoritative = mapping as { item_id: string; project_id?: string | null; canonical_path?: string | null };
    const authoritativeId = authoritative.item_id;
    if (candidate && authoritativeId !== candidate.id) {
      throw new IngestValidationError(
        `ambiguous historical gdrive identity '${gdriveSourceId}'; mapping and item disagree`,
      );
    }
    if (authoritativeId === minted) mintedDriveItemId = minted;
    mappedItemId = authoritativeId;
    mappedProjectId = candidate?.project_id ?? authoritative.project_id ?? proposedProjectId;
    mappedCanonicalPath = candidate?.path ?? authoritative.canonical_path ?? proposedCanonicalPath;
    const { error: mappingMetaError } = await db
      .from("source_item_mappings")
      .update({ project_id: mappedProjectId, canonical_path: mappedCanonicalPath, updated_at: now })
      .eq("team_id", auth.teamId)
      .eq("source", "gdrive")
      .eq("provider_id", gdriveSourceId)
      .eq("item_id", authoritativeId);
    if (mappingMetaError) throw new Error(`gdrive identity mapping update failed: ${mappingMetaError.message}`);
  }

  // Provider identity owns the canonical storage location. A source rename, changed normalization,
  // or reconnect is metadata/content evolution, not an implicit project/path move. A future move API
  // must take both the provider lock and the destination path lock and update this mapping explicitly.
  const itemProjectId = gdriveSourceId
    ? candidate?.project_id ?? mappedProjectId ?? (project.id as string)
    : (project.id as string);
  const itemPath = gdriveSourceId
    ? candidate?.path ?? mappedCanonicalPath ?? payload.path
    : payload.path;
  if (gdriveSourceId) payload = { ...payload, path: itemPath };

  // The provider/path phase has now resolved the immutable canonical id. Serialize with correction
  // and repair, then read the item's authority — for the first and only time — under the item row
  // lock. This lock is held by the surrounding transaction through item, version and contribution
  // writes, so a manual credit-nobody or named correction cannot be overwritten by a stale ingest.
  const canonicalItemId = candidate?.id ?? (mappedItemId || randomUUID());
  // The complete project set was planned and taken before any identity or item lock. A project
  // resolved only here was not in that plan, and is never acquired late.
  assertProjectHeld(itemProjectId, "the item's project");
  if (gdriveCommit && canonicalItemId !== mintedDriveItemId
      && !gdriveCommit.locks.itemIds.has(canonicalItemId)) {
    // The commit took its item advisories and rows before this session read anything. An identity
    // resolved here that it does not hold was not there to lock: taking its advisory now would come
    // after item rows, so the attempt is abandoned instead.
    throw new GdriveIngestStateChangedError("the canonical item was not among the locked candidates");
  }
  if (_internal.transactionBound) {
    await _internal.concurrencyHooks?.beforeAttributionLock?.(canonicalItemId);
    // Re-entrant for a Drive commit; for a newly minted id the key is uncontended by construction.
    // An existing item's key can be held by a correction, a repair or another ingest, so the wait
    // carries the same 10-second bound as the project rows before it and the item row after it.
    // The bracket holds only the acquisition: the caller's `lock_timeout` is back before the item
    // row is asked for, and a timeout (55P03) is not one of the context engine's retryable causes.
    await withBoundedLockWaits(() => lockItemAttribution(auth.teamId,canonicalItemId));
    await _internal.concurrencyHooks?.afterAttributionLock?.(canonicalItemId);
  }
  // ONE row lock and ONE fresh authority read for both owners: it is the attribution reread above
  // and the locked item context the context move below requires. Always after the item advisory
  // lock — correction and repair take advisory → row, and the inverse order would deadlock them.
  const locked = await lockItemContext(session, auth.teamId, canonicalItemId);
  if (candidate && !locked) {
    // Never fall through to a create with the pre-lock candidate: the removal won. For a Drive
    // document the whole attempt is abandoned by name (and, through the API owner, retried once).
    if (gdriveSourceId) {
      throw new GdriveIngestStateChangedError("the canonical item was removed before its row lock");
    }
    throw new Error("canonical item disappeared before attribution serialization");
  }
  // THE authority row: every tier, hash and attribution decision below reads this locked row.
  const existing: ExistingItem | null = locked ? (locked.item as ExistingItem) : null;
  if (_internal.transactionBound) {
    await _internal.concurrencyHooks?.afterAttributionRead?.(canonicalItemId);
  }
  if (existing && _internal.refuseDriveOwnedTarget) {
    // AUTHORITATIVE Drive-ownership decision for a payload that is not Drive-sourced, made on the
    // row this ingest has locked — not on the public owner's unlocked pre-read. Ownership is the
    // provider MAPPING for this item, not what the row says about itself: stored provenance can be
    // missing or altered, and a mapping's legacy `connection_id` is null for every document a
    // connection has claimed since claims existed. Either signal alone is enough to refuse.
    const lockedFrontmatter = isRecord(existing.frontmatter) ? existing.frontmatter : {};
    let driveOwned = lockedFrontmatter.source === "gdrive";
    if (!driveOwned) {
      const { rows: mappings } = await session.executeSql<{ provider_id: string }>(
        `select provider_id from source_item_mappings
          where team_id=$1 and source='gdrive' and item_id=$2`,
        [auth.teamId, existing.id],
      );
      driveOwned = mappings.length > 0;
    }
    if (driveOwned) throw _internal.refuseDriveOwnedTarget();
  }
  if (gdriveCommit && !existing
      && !gdriveCommit.locks.pathKeys.has(
        drivePathIdentityKey(auth.teamId, { projectId: itemProjectId, path: itemPath }))) {
    // The identity about to be created must be one the commit has held since before it was checked.
    throw new GdriveIngestStateChangedError("the creation path was not among the locked identities");
  }

  const storedFrontmatter = isRecord(existing?.frontmatter) ? existing.frontmatter : {};
  const persistedFrontmatter: Record<string, unknown> = { ...(payload.frontmatter ?? {}) };
  if (payload.frontmatter?.source === "gdrive") {
    persistedFrontmatter.contributions = mergeGdriveContributions(
      storedFrontmatter.contributions,
      payload.frontmatter.contributions,
    );
  }
  // Drive context is derived solely from the connection's surviving audience claims (recorded at
  // the end of both write paths). The system-project routing below must never place a Drive item:
  // it would publish the document to General/external-shared regardless of the approved audience.
  const driveOwnedContext =
    payload.frontmatter?.source === "gdrive" || storedFrontmatter.source === "gdrive";

  // ── Who may set this item's tier ────────────────────────────────────────────────────────────────
  // Tier is an access-control decision, so it is resolved ONCE here and both write paths below use the
  // result. #374 gated only the unchanged path, which left the changed path free to take the payload's
  // tier from any principal.
  //
  // Two different answers for an `external` pusher at an existing TEAM item's path, split on whether it
  // is actually trying to CHANGE anything:
  //   • identical body → ignore the tier and take the normal unchanged path. This is the benign race
  //     (a client connector re-pushing a doc that was narrowed upstream between syncs); erroring every
  //     tick would wedge that connector's loop over a no-op.
  //   • different body → REFUSE. Accepting it would let a client key overwrite internal content and
  //     carry the row's tier with it. Refused rather than silently clamped: it's a misconfigured
  //     connector or a probe, and both want an error the caller can see.
  // Either way the pusher's payload tier is advisory for an item that already exists, so it can't
  // promote its own external content into the team tier and inject it onto internal surfaces.
  const existingAccess = (existing as { access?: "team" | "external" | null } | null)?.access ?? null;
  const untrustedPusher = pusherTier === "external";
  const bodyUnchanged = Boolean(existing) && existing!.content_sha256 === contentSha;
  if (existing && untrustedPusher && existingAccess === "team" && !bodyUnchanged) {
    throw new TierViolationError(
      `an external-tier key may not modify the team-tier item at '${payload.path}'`
    );
  }
  // An untrusted pusher NEVER sets a tier — not on an existing item (keep the stored one) and not on a
  // new one (its own tier). The route derives the tier from the PAYLOAD, so without this clamp an
  // external key could simply declare `access: "team"` on a fresh path and land its content on every
  // internal surface — retrieval context, dashboard `visibleItems`, team arcs and timeline. That's a
  // content-injection channel into the team tier (and, since retrieval grounds LLM answers, a
  // prompt-injection one). Clamped rather than refused: "an external key's content is external" is the
  // correct reading of the push, and the `item.created` audit records the tier actually stored.
  const effectiveAccess: "team" | "external" = untrustedPusher
    ? (existingAccess ?? "external")
    : access;
  const accessChanged = existingAccess !== null && existingAccess !== effectiveAccess;
    let contextProjects: SystemProjectIds | null = null;
    if (accessChanged && !driveOwnedContext) {
      const topology = await validatedSystemProjectIds(db, auth.teamId);
      if (topology === undefined) throw new Error("context: system project read failed");
      contextProjects = topology;
      if (topology) {
        // Both ends of the move — the destination it opens and the one it closes — were planned as
        // possible system destinations and are held by key. A topology that differs from that plan
        // abandons the ingest; neither row is locked now, behind the item row.
        assertProjectHeld(topology.general, "the team system project");
        assertProjectHeld(topology.externalShared, "the external system project");
      }
      // Early desired-audience preflight: before inherited/social cascade mutation. The context
      // writer repeats this gate authoritatively after the item/unit writes. TIERRET-1: the
      // target-integrity gate runs in BOTH directions (team → General, external → external-shared)
      // — a corrupted external-shared now stops a widening push too (N2), rolling the whole
      // transaction back; repair the forbidden edge (AUDITFIX-21) to unblock it.
      if (topology) {
        const target = effectiveAccess === "team" ? topology.general : topology.externalShared;
        const gate = await systemIntegrityGate(db, auth.teamId, target, effectiveAccess);
        if (!gate.ok) {
          throw new Error(
            `context gate refusal: ${gate.error ?? "system-integrity refused desired audience"}`
          );
        }
      }
    }

  if (existing && existing.content_sha256 === contentSha) {
    // Refresh "last seen this sync"; do NOT write an audit row (audit M4). Every 30-min sync tick
    // re-pushes every unchanged item, so an `item.unchanged` audit here added ~one row/item/tick
    // (~24k/day at 500 items) — unbounded audit_log growth with no diagnostic value. The synced_at
    // bump is the freshness signal; create/update/delete stay audited on the paths below.
    //
    // RE-ATTRIBUTE on an unchanged re-push: `content_sha256` covers only the body, so an author signal
    // that changed in FRONTMATTER without touching the prose would otherwise be discarded here. Two cases,
    // both decided by `decideReattribution` (which leans on the `member_id_locked` guard, #333):
    //   • null → member: a resolved author that arrived AFTER first ingest (a source that only later
    //     exposes authorship, e.g. Notion enrichment, or a first-ingest API flake) — a HEAL.
    //   • member A → member B: a genuine SOURCE reassignment (a Linear/Plane issue's `assignee` changed
    //     but its description didn't) — RE-POINT + log `item.reassigned`, so a reassignment propagates on
    //     sync instead of waiting for the manual "Re-attribute content" batch.
    // NEVER touches a LOCKED item (a deliberate admin correction — incl. correct-to-nobody), and never
    // auto-clears a set owner to null (a connector's unresolved re-push passes `authorMemberId: null`).
    // The lock is what makes source-driven re-pointing safe (it protects corrections + human self-pushes).
    const memberLocked =
      (existing as { member_id_locked?: boolean | null }).member_id_locked ===
      true;
    const patch: {
      synced_at: string;
      member_id?: string;
      frontmatter?: Record<string, unknown>;
      access?: "team" | "external";
      work_at?: string;
      work_at_from_source?: boolean;
    } = { synced_at: now };
    const reattr = decideReattribution(
      existing.member_id,
      opts?.authorMemberId ?? null,
      memberLocked
    );
    if (reattr.memberId) patch.member_id = reattr.memberId;
    // HEAL ACCESS on an unchanged re-push: `content_sha256` covers only the body, so a source that
    // RECLASSIFIES an item's tier without touching its prose (a doc shared narrower/wider upstream)
    // would otherwise keep the first-ingest `access` forever. With no RLS backstop (CLAUDE.md §5) a
    // stale `access='external'` on a now-internal item silently keeps serving the body to an external
    // principal on EVERY read path. The trust gate that decides whether this pusher may change tier
    // at all is resolved once, above, for both write paths.
    if (accessChanged) patch.access = effectiveAccess;

    // HEAL FRONTMATTER on an unchanged re-push: `content_sha256` covers only the body, but source-derived
    // metadata in frontmatter can change while the body doesn't. Preserve BEST-EFFORT/backfilled author
    // keys the store has but this push omits, so refreshing never wipes them.
    //
    // NOT for an untrusted pusher at a TEAM item. That combination reaches this path only via the
    // identical-body carve-out above, and the heal writes `payload.frontmatter` WHOLESALE (existing keys
    // survive only where this push omits them) — so a client key holding the body of a since-narrowed doc
    // could rewrite `author`/`source`/`source_ts` on an internal item: attribution and audit-trail
    // poisoning, and a skewed episode timestamp. It gets the `synced_at` bump and nothing else.
    const metadataWritable = !(untrustedPusher && existingAccess === "team");
    if (metadataWritable) {
      const existingFrontmatter = storedFrontmatter;
      const healedFrontmatter: Record<string, unknown> = {
        ...persistedFrontmatter,
      };
      // Author signals a connector may LOSE on a later tick. `authors[]` matters most: Notion's
      // author enrichment is best-effort (the API returns [] on any hiccup), so without preserving it
      // an unchanged re-push ERASES the structured authors we already resolved — and the
      // re-attribution pass then has no raw material until the API happens to succeed again.
      for (const key of ["author", "author_email", "author_login", "authors"]) {
        if (
          existingFrontmatter[key] !== undefined &&
          healedFrontmatter[key] === undefined
        ) {
          healedFrontmatter[key] = existingFrontmatter[key];
        }
      }
      // WORK-TIME, per the source's rule (`lib/ingest/source-rules`). We are on the unchanged-body
      // path by definition, so for a source whose timestamp tracks STORAGE rather than activity
      // (`local`'s mtime — moved by touch/rsync/chmod/a checkout) letting the incoming value through
      // re-dates the item and resurfaces a file nobody has opened in a year as today's work. The
      // stored value is authoritative instead.
      //
      // Not applied globally, which is the point of the rules layer: Linear/Plane emit the issue's
      // last STATE TRANSITION here, and a ticket reaching `completed` is real work with an unchanged
      // doc body — freezing that would make completions invisible.
      //
      // Incoming work-time keys are dropped before the stored ones are restored, so a source that
      // changes spelling can't reintroduce the moved value under a new (higher-priority) key.
      // The STORED source decides, not the incoming one: a push must not be able to relabel an item
      // out of its own rule. That only holds if `source` itself is pinned too — the heal writes
      // `payload.frontmatter` wholesale, so without this the relabel is refused for one tick and then
      // stored, and the next tick reads the new label.
      const ruleSource = existingFrontmatter.source ?? payload.frontmatter?.source;
      if (sourceRules(ruleSource).workTimeOnUnchangedBody === "noise") {
        for (const key of workTimeKeysIn(healedFrontmatter)) delete healedFrontmatter[key];
        for (const key of workTimeKeysIn(existingFrontmatter)) {
          healedFrontmatter[key] = existingFrontmatter[key];
        }
        if (existingFrontmatter.source !== undefined) healedFrontmatter.source = existingFrontmatter.source;
      }
      if (canonicalJson(existingFrontmatter) !== canonicalJson(healedFrontmatter)) {
        patch.frontmatter = healedFrontmatter;
      }
    } else {
      delete patch.member_id; // no reattribution from an untrusted pusher either
    }

    // HEAL WORK-TIME on an unchanged re-push, for the same reason as the frontmatter heal above:
    // `content_sha256` covers the body alone, so a source that corrects or first supplies its own
    // timestamp without touching the prose would otherwise keep its first-ingest work-time forever.
    // This is also what CONVERGES the migration's backfill — every existing row starts at the
    // `created_at` fallback and gets its real work-time on the source's next tick.
    //
    // Resolved from the HEALED frontmatter (`patch.frontmatter ?? existing.frontmatter`), not the raw
    // push: the heal preserves author keys this push omitted, and the work-time must be read off the
    // same merged view that gets stored.
    const healedFm = (patch.frontmatter ?? existing.frontmatter ?? {}) as Record<string, unknown>;
    const firstSeen = isoOf((existing as { created_at?: string | Date }).created_at) ?? now;
    const resolvedWork = resolvePersistedWorkTime(healedFm, firstSeen);
    const storedWork = existing as { work_at?: string | Date | null; work_at_from_source?: boolean | null };
    if (
      isoOf(storedWork.work_at) !== resolvedWork.workAt ||
      Boolean(storedWork.work_at_from_source) !== resolvedWork.fromSource
    ) {
      patch.work_at = resolvedWork.workAt;
      patch.work_at_from_source = resolvedWork.fromSource;
    }

    // Phase 1 of the reclassification BEFORE `items.access` is committed, so a cascade failure leaves the
    // stored tier unchanged and the next tick retries the whole change (see reclassify.ts's ordering note
    // — the other order strands the inheriting rows at the old tier permanently).
    if (accessChanged) {
      await cascadeInheritedAudience(db, auth.teamId, existing.id, effectiveAccess);
    }

    const { error: healError } = await db
      .from("items")
      .update(patch)
      .eq("id", existing.id);
    if (healError)
      throw new Error(`item unchanged heal failed: ${healError.message}`);

    // Audit the rare attribution change (unlike the per-tick synced_at bump, so it doesn't reintroduce
    // the M4 unbounded-growth problem), so the mutation isn't silent — a source REASSIGNMENT (A→B) and a
    // first-time HEAL (null→member) are distinct facts.
    if (reattr.reassignedFrom) {
      // A genuine SOURCE reassignment (A→B) on the unchanged path is ALWAYS author-signal-driven (the only
      // trigger). Record it on the uniform item.reassigned stream with the outgoing owner's window start.
      await recordReassignment(db, {
        teamId: auth.teamId,
        itemId: existing.id,
        from: reattr.reassignedFrom,
        to: patch.member_id ?? null,
        source:
          typeof payload.frontmatter?.source === "string"
            ? payload.frontmatter.source
            : null,
        via: "author_signal",
        actor: { kind: "system", memberId: null },
        fromOwnedSince: await ownerWindowStart(db, auth.teamId, existing.id),
      });
    } else if (patch.member_id) {
      // null → member: a first-time attribution HEAL (not a reassignment).
      await audit(db, {
        team_id: auth.teamId,
        actor_kind: "system",
        member_id: null,
        action: "item.attribution_healed",
        target_type: "items",
        target_id: existing.id,
        meta: {
          to: patch.member_id,
          source: payload.frontmatter?.source ?? null,
        },
      });
    }
    // Phase 2: the tier is committed, so invalidate the tier-scoped caches and audit (shared with the
    // changed-body path below, so the two can't drift).
    let contextRefusal: string | undefined;
    if (accessChanged && contextProjects) {
      if (!locked) throw new Error("context: locked existing item missing");
      const refreshed = await refreshLockedItemContext(locked);
      if (!refreshed) throw new Error("context: locked item vanished after unchanged-body write");
      const contextResult = await reconcileLockedItemContext(refreshed, contextProjects);
      if (contextResult.skipped) throw new Error("context move failed: locked unit/item vanished");
      if (!contextResult.ok) {
        if (contextResult.refusalReason === "protected-target-exclusion") {
          contextRefusal = contextResult.error ?? "protected target exclusion";
        } else {
          throw new Error(`context move failed: ${contextResult.error ?? "unknown refusal"}`);
        }
      }
      if (contextResult.spared) {
        console.info(
          `[access] reclassification of ${existing.id}: ${contextResult.spared} standing exclusion(s) spared on the opposite system project`
        );
      }
    }
    // No projection on an unchanged push (the route also guards status !== "unchanged").
    if (gdriveCommit) {
      await recordGdriveItemClaim(rootDb, {
        teamId: auth.teamId,
        itemId: existing.id,
        ...gdriveCommit.claim,
      });
    }
    if (gdriveSourceId) {
      await syncGdriveContributionEvidence(db, auth.teamId, existing.id, healedFm, undefined, {
        memberIdLocked: existing.member_id_locked,
        memberId: existing.member_id,
        authorityRevision: mappingRevision,
      });
    }
    return {
      result: {
        status: "unchanged",
        id: existing.id,
        projectId: itemProjectId,
        accessChanged,
      },
      ...(accessChanged
        ? {
            postCommit: {
              from: existingAccess!,
              to: effectiveAccess,
              source: payload.frontmatter?.source ?? null,
            },
          }
        : {}),
      ...(contextRefusal ? { contextRefusal } : {}),
    } satisfies CommittedIngest;
  }

  const taskRows =
    payload.kind === "task" && payload.rows
      ? await validateTaskRows(db, auth.teamId, itemProjectId, payload.rows)
      : undefined;

  // Phase 1 of a reclassification on the CHANGED path: before the item row (which carries `access`) is
  // written — same fail-closed ordering as the unchanged path — but AFTER row validation, so a push that
  // 422s on invalid rows doesn't mutate anything first.
  if (accessChanged && existing) {
    await cascadeInheritedAudience(db, auth.teamId, existing.id, effectiveAccess);
  }

  const pendingSha = "";
  const changedWork = resolvePersistedWorkTime(
    persistedFrontmatter,
    isoOf((existing as { created_at?: string | Date } | null)?.created_at) ?? now
  );
  const requestedMemberId = opts ? opts.authorMemberId : auth.memberId;
  const authoritativeMemberId = existing?.member_id_locked === true
    ? existing.member_id
    : requestedMemberId;
  const itemRecord = {
    team_id: auth.teamId,
    project_id: itemProjectId,
    path: itemPath,
    kind: payload.kind,
    access: effectiveAccess,
    frontmatter: persistedFrontmatter,
    body: payload.body,
    // Work-time resolved through the ONE resolver and written down (R1). An existing row keeps its
    // `created_at` as the fallback anchor; a brand-new one has none yet, so `now` is its first-seen.
    work_at: changedWork.workAt,
    work_at_from_source: changedWork.fromSource,
    content_sha256: existing ? existing.content_sha256 : pendingSha,
    actor: payload.actor,
    member_id: authoritativeMemberId,
    synced_at: now,
    updated_at: now,
  };

  let itemId: string;
  if (existing) {
    const updateRecord: Partial<typeof itemRecord> = { ...itemRecord };
    if (existing.member_id_locked === true) delete updateRecord.member_id;
    const { error } = await db
      .from("items")
      .update(updateRecord)
      .eq("id", existing.id);
    if (error) throw new Error(`item update failed: ${error.message}`);
    itemId = existing.id;
  } else {
    const { data, error } = await db
      .from("items")
      // `created_at` is stamped explicitly (rather than left to the column default) ONLY here, on the
      // insert: for an item the source didn't date, `work_at` falls back to first-seen, and that claim
      // has to hold EXACTLY — a DB-side `now()` lands a millisecond or two after the app's, which is
      // enough to make "work_at === created_at" false for every undated item. Deliberately not part of
      // `itemRecord`, which the update path spreads: re-stamping it there would turn first-seen into
      // last-changed and quietly corrupt the knowledge-growth metric that reads it.
      .insert({ ...itemRecord, id: canonicalItemId, created_at: now })
      .select("id")
      .single();
    if (error || !data) throw new Error(`item insert failed: ${error?.message}`);
    itemId = data.id;
  }

  const { error: versionError } = await db.from("item_versions").insert({
    item_id: itemId,
    content_sha256: contentSha,
    frontmatter: persistedFrontmatter,
    body: payload.body,
    member_id: authoritativeMemberId,
  });
  if (versionError) {
    throw new Error(`item version insert failed: ${versionError.message}`);
  }

  // FORGET the bodies this push just superseded, where the source's rule says they may not be
  // retained (`lib/ingest/source-rules`). Slack is the case: one item holds a whole conversation and
  // is re-rendered every sync, so a message deleted at the source disappears from the current body
  // while every retained body still quotes it verbatim, forever.
  //
  // Structural rather than event-driven ON PURPOSE. The obvious trigger — "did the reply count
  // drop?" — has two silent holes: a delete and a new reply in the same 30-minute tick cancel out,
  // and once the count heals there is no signal left to retry on, so a single failed attempt strands
  // the text permanently. Forgetting on every body change has neither, and costs nothing: only the
  // BODY is cleared (the rows are the work ledger that attributes credit) and nothing reads it.
  if (!sourceRules(payload.frontmatter?.source).retainSupersededBodies) {
    await forgetSupersededBodies(db, itemId, contentSha);
  }

  let changedTaskRowKeys: string[] | undefined;
  if (payload.kind === "task" && taskRows) {
    changedTaskRowKeys = await materializeTasks(
      db,
      auth.teamId,
      itemProjectId,
      itemId,
      taskRows,
      now,
      effectiveAccess
    );
  } else if (payload.kind === "decision" && payload.rows) {
    await materializeDecisions(
      db,
      auth.teamId,
      itemProjectId,
      itemId,
      payload.rows,
      now
    );
  } else if (payload.kind === "fact") {
    await materializeFacts(
      db,
      auth.teamId,
      itemProjectId,
      itemId,
      payload.rows,
      now,
      effectiveAccess
    );
  } else if (payload.kind === "stakeholder_mention") {
    await materializeStakeholderMentions(
      db,
      auth.teamId,
      itemProjectId,
      itemId,
      payload.rows,
      now,
      effectiveAccess
    );
  }

  const { error: shaError } = await db
    .from("items")
    .update({ content_sha256: contentSha })
    .eq("id", itemId);
  if (shaError) throw new Error(`item sha commit failed: ${shaError.message}`);

  // Phase 2. A body edit can carry a tier change with it, and this path is where the previous fix
  // stopped looking: `materialize*` re-stamps the audience of the rows IN THIS PUSH, but nothing
  // cascaded to rows the push omits and nothing touched the tier-scoped caches.
  let contextRefusal: string | undefined;
  if (accessChanged && contextProjects) {
    if (!locked) throw new Error("context: locked existing item missing");
    const refreshed = await refreshLockedItemContext(locked);
    if (!refreshed) throw new Error("context: locked item vanished after changed-body write");
    const contextResult = await reconcileLockedItemContext(refreshed, contextProjects);
    if (contextResult.skipped) throw new Error("context move failed: locked unit/item vanished");
    if (!contextResult.ok) {
      if (contextResult.refusalReason === "protected-target-exclusion") {
        contextRefusal = contextResult.error ?? "protected target exclusion";
      } else {
        throw new Error(`context move failed: ${contextResult.error ?? "unknown refusal"}`);
      }
    }
    if (contextResult.spared) {
      console.info(
        `[access] reclassification of ${itemId}: ${contextResult.spared} standing exclusion(s) spared on the opposite system project`
      );
    }
  }

  await audit(db, {
    team_id: auth.teamId,
    actor_kind: "api_key",
    member_id: auth.memberId,
    api_key_id: auth.apiKeyId,
    action: existing ? "item.updated" : "item.created",
    target_type: "item",
    target_id: itemId,
    meta: {
      path: payload.path,
      kind: payload.kind,
      access: effectiveAccess,
      rows: payload.rows?.length ?? 0,
      // Only present when the pusher's `content_sha256` disagreed with the body it sent — a client
      // bug worth chasing. Recorded on the EXISTING create/update audit row (never its own row, and
      // never on the unchanged fast-path) so a systematically-wrong connector can't grow audit_log.
      ...(shaMismatch ? { sha_mismatch: true, client_sha: payload.content_sha256 } : {}),
    },
  });

  // A content edit already re-resolved member_id (unless LOCKED — then updateRecord dropped it). If that
  // moved an already-attributed item to a DIFFERENT member, log the ownership delta too: the audit above
  // records the edit; this records the reassignment (same `item.reassigned` fact as the unchanged path).
  // `via` disambiguates a true SOURCE reassignment (`author_signal` — the frontmatter author moved) from a
  // pusher-takeover (`pusher_default` — a different key re-pushed with no author signal → attributed to the
  // pusher), so a consumer counting "the source reassigned this" doesn't over-count collaborative edits.
  if (existing) {
    const prior = (existing as { member_id: string | null }).member_id;
    const lockedExisting =
      (existing as { member_id_locked?: boolean | null }).member_id_locked ===
      true;
    if (
      !lockedExisting &&
      prior &&
      itemRecord.member_id &&
      prior !== itemRecord.member_id
    ) {
      await recordReassignment(db, {
        teamId: auth.teamId,
        itemId,
        from: prior,
        to: itemRecord.member_id,
        source:
          typeof payload.frontmatter?.source === "string"
            ? payload.frontmatter.source
            : null,
        // author_signal = a true source reassignment (the frontmatter author moved); pusher_default = a
        // collaborative takeover (a different key re-pushed with no author signal → attributed to it).
        via: opts ? "author_signal" : "pusher_default",
        actor: { kind: "api_key", memberId: auth.memberId, apiKeyId: auth.apiKeyId },
        fromOwnedSince: await ownerWindowStart(db, auth.teamId, itemId),
      });
    }
  }

  if (gdriveCommit) {
    await recordGdriveItemClaim(rootDb, { teamId: auth.teamId, itemId, ...gdriveCommit.claim });
  }
  if (gdriveSourceId) {
    await syncGdriveContributionEvidence(db, auth.teamId, itemId, persistedFrontmatter, undefined, {
      memberIdLocked: existing?.member_id_locked,
      memberId: existing?.member_id_locked === true ? existing.member_id : authoritativeMemberId,
      authorityRevision: mappingRevision,
    });
  }
  return {
    result: {
      status: existing ? "updated" : "created",
      id: itemId,
      projectId: itemProjectId,
      changedTaskRowKeys,
      accessChanged,
    },
    ...(accessChanged
      ? {
          postCommit: {
            from: existingAccess!,
            to: effectiveAccess,
            source: payload.frontmatter?.source ?? null,
          },
        }
      : {}),
    ...(contextRefusal ? { contextRefusal } : {}),
  } satisfies CommittedIngest;
  });

  // Confirmed-commit boundary: cache invalidation and access-healed audit are diagnostic/nonfatal.
  // A fault here never rejects/replays the durable item/context success. The session above is joined
  // to the surrounding ingest transaction, so "committed" is THAT transaction's commit: the effects
  // are deferred to it and never run for a write that is later rolled back.
  const postCommit = committed.postCommit;
  if (postCommit || committed.contextRefusal) {
    await afterTransactionCommit(async () => {
      if (postCommit) {
        try {
          const { data: team, error: teamError } = await db
            .from("teams")
            .select("slug")
            .eq("id", auth.teamId)
            .maybeSingle();
          if (teamError) throw new Error(`reclassification team slug read failed: ${teamError.message}`);
          const slug = (team as { slug?: string } | null)?.slug;
          if (!slug) throw new Error("reclassification: team slug not found");
          await settleReclassification(db, slug, {
            teamId: auth.teamId,
            itemId: committed.result.id,
            ...postCommit,
          });
        } catch (error) {
          console.warn(
            `[access] post-commit reclassification effects failed for ${committed.result.id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      if (committed.contextRefusal) {
        console.warn(
          `[access] item ${committed.result.id} committed with standing context refusal: ${committed.contextRefusal}`
        );
      }
    });
  }
  return committed.result;
}
