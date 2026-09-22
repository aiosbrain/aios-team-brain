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
import type { DbClient } from "@/lib/db/types";
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
import { lockGdriveProvider, recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import type { ApiAuth } from "@/lib/api/auth";
import { afterTransactionCommit, runSql, withTransaction } from "@/lib/db/pg/pool";
import { isPgClient } from "@/lib/db/pg/client";
import { lockItemAttribution } from "@/lib/ingest/item-attribution-lock";
import {
  GdriveAuthorityError,
  type GdriveExecutionRef,
  withGdriveExecutionCommit,
} from "@/lib/integrations/gdrive-authority";

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
}

interface IngestInternalOptions {
  transactionBound?: boolean;
  concurrencyHooks?: IngestConcurrencyHooks;
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

/**
 * Public-ingest owner. Locks both candidate identities before deciding whether the stored target is
 * Drive-owned, so omitting/relabeling incoming provenance and concurrent first creation cannot skip
 * the immutable connection fence.
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
  return withTransaction(async () => {
    // Global lock order: team identity authority -> path/provider identity -> canonical item.
    if (opts?.mappingRevision !== undefined) {
      await validateIdentityAuthorityRevision(auth.teamId,opts.mappingRevision);
    }
    const incomingSourceId = rawPayload.frontmatter?.source === "gdrive"
      && typeof rawPayload.frontmatter.source_id === "string"
      ? rawPayload.frontmatter.source_id.trim() : "";
    // Transaction-scoped identity locks close both path-vs-provider and two-new-writer races.
    await runSql(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${auth.teamId}:item:${rawPayload.project}:${rawPayload.path}`,
    ]);
    if (incomingSourceId) {
      await lockGdriveProvider(auth.teamId, incomingSourceId);
    }
    // Resolve candidate immutable ids without taking row locks, then acquire the canonical item
    // advisory locks in sorted order before any `for update`. Correction/repair take item advisory ->
    // item row too; doing the inverse here would permit the classic ingest-vs-correction deadlock.
    // The path and provider locks above keep these candidate identities stable until the locked reread.
    const {rows:candidates}=await runSql<{target_id:string|null;incoming_id:string|null}>(
      `select (
         select i.id from items i join projects p on p.id=i.project_id and p.team_id=i.team_id
          where i.team_id=$1 and p.slug=$2 and i.path=$3
       ) as target_id, (
         select m.item_id from source_item_mappings m
          where m.team_id=$1 and m.source='gdrive' and m.provider_id=nullif($4,'')
       ) as incoming_id`,
      [auth.teamId,rawPayload.project,rawPayload.path,incomingSourceId],
    );
    const candidateIds=[...new Set([candidates[0]?.target_id,candidates[0]?.incoming_id]
      .filter((id):id is string=>Boolean(id)))].sort();
    for(const itemId of candidateIds){
      await concurrencyHooks.beforeAttributionLock?.(itemId);
      await lockItemAttribution(auth.teamId,itemId);
      await concurrencyHooks.afterAttributionLock?.(itemId);
    }
    const { rows } = await runSql<{
      item_id: string | null;
      item_source: string | null;
      item_connection: string | null;
      mapping_connection: string | null;
      incoming_mapping_item: string | null;
      incoming_mapping_connection: string | null;
    }>(
      `with target as (
         select i.id, i.frontmatter->>'source' as source, i.frontmatter->>'connection_id' as connection_id
           from items i join projects p on p.id=i.project_id and p.team_id=i.team_id
          where i.team_id=$1 and p.slug=$2 and i.path=$3
          for update of i
       ), target_mapping as (
         select m.item_id, m.connection_id from source_item_mappings m
          where m.team_id=$1 and m.source='gdrive' and m.item_id=(select id from target)
          for update
       ), incoming_mapping as (
         select m.item_id, m.connection_id from source_item_mappings m
          where m.team_id=$1 and m.source='gdrive' and m.provider_id=nullif($4,'')
          for update
       )
       select t.id as item_id, t.source as item_source, t.connection_id as item_connection,
              tm.connection_id as mapping_connection, im.item_id as incoming_mapping_item,
              im.connection_id as incoming_mapping_connection
         from (select 1) seed left join target t on true
         left join target_mapping tm on true left join incoming_mapping im on true`,
      [auth.teamId, rawPayload.project, rawPayload.path, incomingSourceId],
    );
    const stored = rows[0];
    const incomingConnection = rawPayload.frontmatter?.source === "gdrive"
      && typeof rawPayload.frontmatter.connection_id === "string"
      ? rawPayload.frontmatter.connection_id.trim() : "";
    const requiresDriveAuthority = rawPayload.frontmatter?.source === "gdrive"
      || stored?.item_source === "gdrive"
      || Boolean(stored?.mapping_connection)
      || Boolean(stored?.incoming_mapping_item);
    const commit = () => ingestItem(
      db,auth,rawPayload,access,opts,pusherTier,undefined,{transactionBound:true},
    );
    if (!requiresDriveAuthority) return commit();
    if (!execution) {
      throw new GdriveAuthorityError("connector_principal_required", "current Google Drive execution authority is required for this stored item", 403);
    }
    if (!incomingSourceId || incomingConnection !== execution.integrationId) {
      throw new GdriveAuthorityError("wrong_connection", "Google Drive payload is not bound to this authorized connection", 403);
    }
    return withGdriveExecutionCommit(auth, execution, (audience) => ingestItem(
      db,
      auth,
      rawPayload,
      // Context memberships are the authority. External is the conservative inherited unit tier:
      // it may enter either a restricted team project or an external-visible project without the
      // no-widening gate ever laundering a team unit into an external grant.
      "external",
      opts,
      pusherTier,
      {
        integrationId: execution.integrationId,
        providerId: incomingSourceId,
        generation: execution.generation,
        audienceProjectIds: audience.projectIds,
      },
      {transactionBound:true},
    ));
  });
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
  gdriveClaim?: {
    integrationId: string;
    providerId: string;
    generation: number;
    audienceProjectIds: readonly string[];
  },
  _internal: IngestInternalOptions = {},
): Promise<IngestResult> {
  const mappingRevision=opts?.mappingRevision;
  // Every production caller receives one transaction. It is the lifetime of both the canonical item
  // attribution lock and all item/version/contribution writes. Unit DbClient fakes deliberately skip
  // PostgreSQL-only mechanics; every runtime DbClient is a PgClient (lib/db/types.ts).
  if (!_internal.transactionBound && isPgClient(db)) {
    return withTransaction(() => ingestItem(
      db, auth, rawPayload, access, opts, pusherTier, gdriveClaim,
      {..._internal,transactionBound:true},
    ));
  }
  if (mappingRevision !== undefined) {
    await validateIdentityAuthorityRevision(auth.teamId,mappingRevision);
  }
  const parsedPayload = itemPayloadSchema.safeParse({
    ...rawPayload,
    access: rawPayload.access ?? access,
  });
  if (!parsedPayload.success) {
    throw new IngestValidationError(
      `invalid item payload: ${parsedPayload.error.issues[0]?.message ?? "bad shape"}`
    );
  }
  // Fail before project/pointer writes when a legacy wrapper forgot to delegate transactions.
  transactionCapability(db);
  const requestedPayload = parsedPayload.data;
  if (_internal.transactionBound) {
    // Creation identity precedes canonical item identity. This closes two-new-writer races for direct
    // internal callers; API ingestion already holds the same key, and advisory locks are re-entrant.
    await runSql(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [
      `${auth.teamId}:item:${requestedPayload.project}:${requestedPayload.path}`,
    ]);
  }
  // Authoritative change key (see contentHash). The wire `content_sha256` is advisory from here on:
  // a mismatch means the pushing client hashes something other than the body it sent, which we record
  // on the item's audit row (below) so a buggy connector is diagnosable instead of silently corrupting
  // dedup. It is NOT rejected — the body is the source of truth and we can always hash it correctly.
  const contentSha = contentHash(requestedPayload.body);
  const shaMismatch = contentSha !== requestedPayload.content_sha256;
  const now = new Date().toISOString();
  const { data: project, error: projectError } = await db
    .from("projects")
    .upsert(
      {
        team_id: auth.teamId,
        slug: requestedPayload.project,
        last_synced_at: now,
      },
      { onConflict: "team_id,slug" }
    )
    .select("id")
    .single();
  if (projectError || !project) {
    throw new Error(`project upsert failed: ${projectError?.message}`);
  }
  // PCCC-4: a freshly upserted source project records its graph partition pointer; the null-guarded
  // write makes the re-sync case (project already pointed) a no-op.
  const ptr = await ensureProjectGraphPointer(db, { teamId: auth.teamId, projectId: project.id as string });
  if (!ptr.ok) throw new Error(ptr.error);

  const existingFields = "id, project_id, path, content_sha256, member_id, member_id_locked, frontmatter, access, created_at, work_at, work_at_from_source";
  type ExistingItem = LockedItemAuthority & { project_id: string; path: string };
  // The unbound client. Inside the session below `db` is the session's own client; the Drive claim
  // writers open their own (joined) context sessions and so must be handed this one instead.
  const rootDb = db;

  const committed = await runContextTransaction(db, async (session) => {
    const db = session.db;
    const projectId = project.id as string;
    // Per attempt: Drive identity resolution may move the path, and a retry must start from the push.
    let payload = requestedPayload;
    await lockIngestIdentity(session, auth.teamId, projectId, payload.path);
    // Pre-lock identity candidate only. It is replaced by the freshly locked authority row below.
    let existing: ExistingItem | null = null;

  // Google document identity is its exact provider id, not the normalized path. Historical gdrive
  // paths lower-cased/sanitized that id, so rename/move/reconnect must first recover the established
  // row through retained provenance. More than one match is an old collision: fail visibly rather
  // than guessing and overwriting an unrelated document.
  const gdriveSourceId =
    payload.frontmatter?.source === "gdrive" && typeof payload.frontmatter.source_id === "string"
      ? payload.frontmatter.source_id.trim()
      : "";
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
        .select(existingFields)
        .eq("team_id", auth.teamId)
        .eq("id", mappedItemId)
        .maybeSingle();
      if (mappedItemError) throw new Error(`gdrive mapped item lookup failed: ${mappedItemError.message}`);
      existing = mappedItem as ExistingItem | null;
    }
  }

  // A retained mapping is a tombstone as well as an identity map. If the content row was physically
  // removed, reconnect at its established collision-safe location instead of silently falling back to
  // the newly-normalized requested path. An occupied tombstone target is a visible repair condition —
  // never overwrite the unrelated row.
  if (gdriveSourceId && mappedItemId && !existing && mappedCanonicalPath) {
    const targetProjectId = mappedProjectId ?? (project.id as string);
    const { data: occupant, error: occupantError } = await db
      .from("items")
      .select(existingFields)
      .eq("team_id", auth.teamId)
      .eq("project_id", targetProjectId)
      .eq("path", mappedCanonicalPath)
      .maybeSingle();
    if (occupantError) throw new Error(`gdrive canonical path lookup failed: ${occupantError.message}`);
    if (occupant && (occupant as ExistingItem).id !== mappedItemId) {
      throw new IngestValidationError(
        `Drive canonical path collision for '${mappedCanonicalPath}' requires manual repair`,
      );
    }
  }
  if (gdriveSourceId && !existing && !mappedItemId) {
    const { data: providerMatches, error: providerMatchError } = await db
      .from("items")
      .select(existingFields)
      .eq("team_id", auth.teamId)
      .eq("frontmatter->>source", "gdrive")
      .eq("frontmatter->>source_id", gdriveSourceId)
      .limit(2);
    if (providerMatchError) {
      throw new Error(`gdrive identity lookup failed: ${providerMatchError.message}`);
    }
    const matches = (providerMatches ?? []) as ExistingItem[];
    if (matches.length > 1) {
      throw new IngestValidationError(
        `ambiguous historical gdrive identity '${gdriveSourceId}'; manual repair is required`
      );
    }
    existing = matches[0] ?? null;
  }

  if (!existing && !mappedItemId) {
    const { data, error } = await db
      .from("items")
      .select(existingFields)
      .eq("team_id", auth.teamId)
      .eq("project_id", project.id)
      .eq("path", payload.path)
      .maybeSingle();
    if (error) throw new Error(`item identity lookup failed: ${error.message}`);
    const pathMatch = data as ExistingItem | null;
    if (!gdriveSourceId) {
      existing = pathMatch;
    } else if (pathMatch) {
      const fm = isRecord(pathMatch.frontmatter) ? pathMatch.frontmatter : {};
      // A path is never Drive identity. Adopt only exact historical Drive provenance; otherwise
      // allocate a deterministic collision-safe path and leave the unrelated row untouched.
      if (fm.source === "gdrive" && fm.source_id === gdriveSourceId) {
        existing = pathMatch;
      } else {
        const dot = payload.path.lastIndexOf(".");
        const suffix = createHash("sha256").update(gdriveSourceId).digest("hex").slice(0, 10);
        const safePath = dot > payload.path.lastIndexOf("/")
          ? `${payload.path.slice(0, dot)}--drive-${suffix}${payload.path.slice(dot)}`
          : `${payload.path}--drive-${suffix}`;
        payload = { ...payload, path: safePath };
        const { data: safeMatch, error: safeError } = await db
          .from("items").select(existingFields).eq("team_id", auth.teamId)
          .eq("project_id", project.id).eq("path", safePath).maybeSingle();
        if (safeError) throw new Error(`collision-safe Drive identity lookup failed: ${safeError.message}`);
        const safe = safeMatch as ExistingItem | null;
        if (safe) {
          const safeFm = isRecord(safe.frontmatter) ? safe.frontmatter : {};
          if (safeFm.source !== "gdrive" || safeFm.source_id !== gdriveSourceId) {
            throw new IngestValidationError(`Drive path collision for '${payload.path}' requires manual repair`);
          }
          existing = safe;
        }
      }
    }
  }

  if (gdriveSourceId) {
    const proposedItemId = existing?.id ?? (mappedItemId || randomUUID());
    const proposedProjectId = existing?.project_id ?? mappedProjectId ?? (project.id as string);
    const proposedCanonicalPath = existing?.path ?? mappedCanonicalPath ?? payload.path;
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
    if (existing && authoritativeId !== existing.id) {
      throw new IngestValidationError(
        `ambiguous historical gdrive identity '${gdriveSourceId}'; mapping and item disagree`,
      );
    }
    mappedItemId = authoritativeId;
    mappedProjectId = existing?.project_id ?? authoritative.project_id ?? proposedProjectId;
    mappedCanonicalPath = existing?.path ?? authoritative.canonical_path ?? proposedCanonicalPath;
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
    ? existing?.project_id ?? mappedProjectId ?? (project.id as string)
    : (project.id as string);
  const itemPath = gdriveSourceId
    ? existing?.path ?? mappedCanonicalPath ?? payload.path
    : payload.path;
  if (gdriveSourceId) payload = { ...payload, path: itemPath };

  // The provider/path phase has now resolved the immutable canonical id. Serialize with correction
  // and repair, then throw away the pre-lock attribution snapshot and reread it under the item row
  // lock. This lock is held by the surrounding transaction through item, version and contribution
  // writes, so a manual credit-nobody or named correction cannot be overwritten by a stale ingest.
  const canonicalItemId = existing?.id ?? (mappedItemId || randomUUID());
  if (_internal.transactionBound) {
    await _internal.concurrencyHooks?.beforeAttributionLock?.(canonicalItemId);
    await lockItemAttribution(auth.teamId,canonicalItemId);
    await _internal.concurrencyHooks?.afterAttributionLock?.(canonicalItemId);
  }
  // ONE row lock and ONE fresh authority read for both owners: it is the attribution reread above
  // and the locked item context the context move below requires. Always after the item advisory
  // lock — correction and repair take advisory → row, and the inverse order would deadlock them.
  const locked = await lockItemContext(session, auth.teamId, canonicalItemId);
  if (existing && !locked) {
    throw new Error("canonical item disappeared before attribution serialization");
  }
  if (locked) existing = locked.item as ExistingItem;
  if (_internal.transactionBound) {
    await _internal.concurrencyHooks?.afterAttributionRead?.(canonicalItemId);
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
    if (gdriveClaim) {
      await recordGdriveItemClaim(rootDb, {
        teamId: auth.teamId,
        itemId: existing.id,
        ...gdriveClaim,
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

  if (gdriveClaim) {
    await recordGdriveItemClaim(rootDb, { teamId: auth.teamId, itemId, ...gdriveClaim });
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
