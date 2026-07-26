import "server-only";

import { createHash } from "node:crypto";
import { audit } from "@/lib/api/audit";
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

export interface IngestResult {
  status: "created" | "updated" | "unchanged";
  id: string;
  projectId?: string;
  changedTaskRowKeys?: string[];
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
  opts?: { authorMemberId: string | null },
  // Tier of the PRINCIPAL pushing this item. Only a trusted (`team`) pusher may change an existing
  // item's `access` (reclassification) — an `external`-tier key must never RAISE a team item's
  // visibility by re-pushing it (see the access-heal on the unchanged path). Defaults to `team`
  // because every INTERNAL caller (connectors, scanner, meetings) is trusted; ONLY the public
  // `/api/v1/items` route passes the real key tier, so an untrusted external key is gated out.
  pusherTier: "team" | "external" = "team"
): Promise<IngestResult> {
  const parsedPayload = itemPayloadSchema.safeParse({
    ...rawPayload,
    access: rawPayload.access ?? access,
  });
  if (!parsedPayload.success) {
    throw new IngestValidationError(
      `invalid item payload: ${parsedPayload.error.issues[0]?.message ?? "bad shape"}`
    );
  }
  const payload = parsedPayload.data;
  // Authoritative change key (see contentHash). The wire `content_sha256` is advisory from here on:
  // a mismatch means the pushing client hashes something other than the body it sent, which we record
  // on the item's audit row (below) so a buggy connector is diagnosable instead of silently corrupting
  // dedup. It is NOT rejected — the body is the source of truth and we can always hash it correctly.
  const contentSha = contentHash(payload.body);
  const shaMismatch = contentSha !== payload.content_sha256;
  const now = new Date().toISOString();
  const { data: project, error: projectError } = await db
    .from("projects")
    .upsert(
      {
        team_id: auth.teamId,
        slug: payload.project,
        last_synced_at: now,
      },
      { onConflict: "team_id,slug" }
    )
    .select("id")
    .single();
  if (projectError || !project) {
    throw new Error(`project upsert failed: ${projectError?.message}`);
  }

  const { data: existing } = await db
    .from("items")
    .select("id, content_sha256, member_id, member_id_locked, frontmatter, access, created_at, work_at, work_at_from_source")
    .eq("team_id", auth.teamId)
    .eq("project_id", project.id)
    .eq("path", payload.path)
    .maybeSingle();

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
  /** Only looked up when a reclassification actually fires (rare) — the cache keys need the slug. */
  const teamSlug = async (): Promise<string> => {
    const { data } = await db.from("teams").select("slug").eq("id", auth.teamId).maybeSingle();
    const slug = (data as { slug?: string } | null)?.slug;
    if (!slug) throw new Error("reclassification: team slug not found");
    return slug;
  };

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
    const locked =
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
      locked
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
      const existingFrontmatter = isRecord(existing.frontmatter)
        ? existing.frontmatter
        : {};
      const healedFrontmatter: Record<string, unknown> = {
        ...(payload.frontmatter ?? {}),
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
    if (accessChanged) {
      await settleReclassification(db, await teamSlug(), {
        teamId: auth.teamId,
        itemId: existing.id,
        from: existingAccess,
        to: effectiveAccess,
        source: payload.frontmatter?.source ?? null,
      });
    }
    // No projection on an unchanged push (the route also guards status !== "unchanged").
    return {
      status: "unchanged",
      id: existing.id,
      projectId: project.id,
    };
  }

  const taskRows =
    payload.kind === "task" && payload.rows
      ? await validateTaskRows(db, auth.teamId, project.id, payload.rows)
      : undefined;

  // Phase 1 of a reclassification on the CHANGED path: before the item row (which carries `access`) is
  // written — same fail-closed ordering as the unchanged path — but AFTER row validation, so a push that
  // 422s on invalid rows doesn't mutate anything first.
  if (accessChanged && existing) {
    await cascadeInheritedAudience(db, auth.teamId, existing.id, effectiveAccess);
  }

  const pendingSha = "";
  const changedWork = resolvePersistedWorkTime(
    payload.frontmatter,
    isoOf((existing as { created_at?: string | Date } | null)?.created_at) ?? now
  );
  const itemRecord = {
    team_id: auth.teamId,
    project_id: project.id,
    path: payload.path,
    kind: payload.kind,
    access: effectiveAccess,
    frontmatter: payload.frontmatter,
    body: payload.body,
    // Work-time resolved through the ONE resolver and written down (R1). An existing row keeps its
    // `created_at` as the fallback anchor; a brand-new one has none yet, so `now` is its first-seen.
    work_at: changedWork.workAt,
    work_at_from_source: changedWork.fromSource,
    content_sha256: existing ? existing.content_sha256 : pendingSha,
    actor: payload.actor,
    member_id: opts ? opts.authorMemberId : auth.memberId,
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
      .insert({ ...itemRecord, created_at: now })
      .select("id")
      .single();
    if (error || !data) throw new Error(`item insert failed: ${error?.message}`);
    itemId = data.id;
  }

  const { error: versionError } = await db.from("item_versions").insert({
    item_id: itemId,
    content_sha256: contentSha,
    frontmatter: payload.frontmatter,
    body: payload.body,
    member_id: opts ? opts.authorMemberId : auth.memberId,
  });
  if (versionError) {
    throw new Error(`item version insert failed: ${versionError.message}`);
  }

  let changedTaskRowKeys: string[] | undefined;
  if (payload.kind === "task" && taskRows) {
    changedTaskRowKeys = await materializeTasks(
      db,
      auth.teamId,
      project.id,
      itemId,
      taskRows,
      now,
      effectiveAccess
    );
  } else if (payload.kind === "decision" && payload.rows) {
    await materializeDecisions(
      db,
      auth.teamId,
      project.id,
      itemId,
      payload.rows,
      now
    );
  } else if (payload.kind === "fact") {
    await materializeFacts(
      db,
      auth.teamId,
      project.id,
      itemId,
      payload.rows,
      now,
      effectiveAccess
    );
  } else if (payload.kind === "stakeholder_mention") {
    await materializeStakeholderMentions(
      db,
      auth.teamId,
      project.id,
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
  if (accessChanged) {
    await settleReclassification(db, await teamSlug(), {
      teamId: auth.teamId,
      itemId,
      from: existingAccess,
      to: effectiveAccess,
      source: payload.frontmatter?.source ?? null,
    });
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

  return {
    status: existing ? "updated" : "created",
    id: itemId,
    projectId: project.id,
    changedTaskRowKeys,
  };
}
