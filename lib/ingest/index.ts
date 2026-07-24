import "server-only";

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
  opts?: { authorMemberId: string | null }
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
    .select("id, content_sha256, member_id, member_id_locked, frontmatter")
    .eq("team_id", auth.teamId)
    .eq("project_id", project.id)
    .eq("path", payload.path)
    .maybeSingle();

  if (existing && existing.content_sha256 === payload.content_sha256) {
    // Refresh "last seen this sync"; do NOT write an audit row (audit M4). Every 30-min sync tick
    // re-pushes every unchanged item, so an `item.unchanged` audit here added ~one row/item/tick
    // (~24k/day at 500 items) — unbounded audit_log growth with no diagnostic value. The synced_at
    // bump is the freshness signal; create/update/delete stay audited on the paths below.
    //
    // RE-ATTRIBUTE on an unchanged re-push: `content_sha256` covers only body+title, so an author signal
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
    } = { synced_at: now };
    const reattr = decideReattribution(
      existing.member_id,
      opts?.authorMemberId ?? null,
      locked
    );
    if (reattr.memberId) patch.member_id = reattr.memberId;

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
    content_sha256: payload.content_sha256,
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
    .update({ content_sha256: payload.content_sha256 })
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
