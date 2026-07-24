import "server-only";

import { createHash } from "node:crypto";
import { audit } from "@/lib/api/audit";
import { decideReattribution } from "@/lib/ingest/reattribution-decision";
import { recordReassignment, ownerWindowStart } from "@/lib/ingest/reassignment-log";
import type { ItemPayload } from "@/lib/api/item-payload-schema";
import { itemPayloadSchema, IngestValidationError } from "@/lib/api/schemas";
import type { DbClient } from "@/lib/db/types";
import { materializeDecisions } from "@/lib/ingest/decisions";
import {
  materializeFacts,
  materializeStakeholderMentions,
} from "@/lib/ingest/evidence";
import { materializeTasks, validateTaskRows } from "@/lib/ingest/tasks";

export interface IngestResult {
  status: "created" | "updated" | "unchanged";
  id: string;
  projectId?: string;
  changedTaskRowKeys?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    .select("id, content_sha256, member_id, member_id_locked, frontmatter, access")
    .eq("team_id", auth.teamId)
    .eq("project_id", project.id)
    .eq("path", payload.path)
    .maybeSingle();

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
    // principal on EVERY read path. Heal it here (like the frontmatter heal) and cascade to the tasks
    // that inherit it (materialize does NOT run on the unchanged path).
    //
    // TRUST GATE: only a `team`-tier pusher may change tier. An `external` key re-pushing the identical
    // body of a known team item must NOT be able to flip its `access` (widening it to `external` would
    // leak the real team content it preserves). Internal callers default to `team` (trusted); the public
    // route passes the real key tier, so an untrusted external pusher leaves the stored tier untouched.
    const existingAccess =
      (existing as { access?: "team" | "external" | null }).access ?? null;
    const accessChanged = existingAccess !== access && pusherTier === "team";
    if (accessChanged) patch.access = access;

    // HEAL FRONTMATTER on an unchanged re-push: `content_sha256` covers only the body, but source-derived
    // metadata in frontmatter can change while the body doesn't. Preserve BEST-EFFORT/backfilled author
    // keys the store has but this push omits, so refreshing never wipes them.
    const existingFrontmatter = isRecord(existing.frontmatter)
      ? existing.frontmatter
      : {};
    const healedFrontmatter: Record<string, unknown> = {
      ...(payload.frontmatter ?? {}),
    };
    for (const key of ["author", "author_email", "author_login"]) {
      if (
        existingFrontmatter[key] !== undefined &&
        healedFrontmatter[key] === undefined
      ) {
        healedFrontmatter[key] = existingFrontmatter[key];
      }
    }
    if (canonicalJson(existingFrontmatter) !== canonicalJson(healedFrontmatter)) {
      patch.frontmatter = healedFrontmatter;
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
    // Cascade a healed tier to the rows that inherit it. Tasks carry the item's `access` as their
    // `audience` (materialize sets it on the changed path; here it's stale). Decisions are excluded
    // deliberately — a decision row's audience is per-row (its own wire field), not inherited from
    // the item (see the decisions-audience data-mechanics test).
    if (accessChanged) {
      const { error: cascadeErr } = await db
        .from("tasks")
        .update({ audience: access })
        .eq("source_item_id", existing.id);
      if (cascadeErr)
        throw new Error(`task audience cascade failed: ${cascadeErr.message}`);
      // Audit the rare reclassification so the tier change isn't silent (like the reassignment/heal
      // audits above; rare enough not to reintroduce the M4 per-tick unbounded-growth problem).
      await audit(db, {
        team_id: auth.teamId,
        actor_kind: "system",
        member_id: null,
        action: "item.access_healed",
        target_type: "items",
        target_id: existing.id,
        meta: {
          from: existingAccess,
          to: access,
          source: payload.frontmatter?.source ?? null,
        },
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

  const pendingSha = "";
  const itemRecord = {
    team_id: auth.teamId,
    project_id: project.id,
    path: payload.path,
    kind: payload.kind,
    access,
    frontmatter: payload.frontmatter,
    body: payload.body,
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
      .insert(itemRecord)
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
      access
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
      access
    );
  } else if (payload.kind === "stakeholder_mention") {
    await materializeStakeholderMentions(
      db,
      auth.teamId,
      project.id,
      itemId,
      payload.rows,
      now,
      access
    );
  }

  const { error: shaError } = await db
    .from("items")
    .update({ content_sha256: contentSha })
    .eq("id", itemId);
  if (shaError) throw new Error(`item sha commit failed: ${shaError.message}`);

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
      access,
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
