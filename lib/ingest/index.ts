import "server-only";

import { audit } from "@/lib/api/audit";
import {
  type ItemPayload,
} from "@/lib/api/item-payload-schema";
import { itemPayloadSchema, IngestValidationError } from "@/lib/api/schemas";
import type { DbClient } from "@/lib/db/types";
import { materializeDecisions } from "@/lib/ingest/decisions";
import {
  materializeFacts,
  materializeStakeholderMentions,
} from "@/lib/ingest/evidence";
import {
  materializeTasks,
  validateTaskRows,
} from "@/lib/ingest/tasks";

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
    const patch: {
      synced_at: string;
      member_id?: string;
      frontmatter?: Record<string, unknown>;
    } = { synced_at: now };
    if (
      opts?.authorMemberId &&
      existing.member_id === null &&
      existing.member_id_locked !== true
    ) {
      patch.member_id = opts.authorMemberId;
    }

    const existingFrontmatter = isRecord(existing.frontmatter)
      ? existing.frontmatter
      : {};
    const healedFrontmatter = { ...payload.frontmatter };
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
    if (healError) throw new Error(`item unchanged heal failed: ${healError.message}`);

    if (patch.member_id) {
      await audit(db, {
        team_id: auth.teamId,
        actor_kind: "system",
        member_id: null,
        action: "item.attribution_healed",
        target_type: "items",
        target_id: existing.id,
        meta: {
          to: patch.member_id,
          source: payload.frontmatter.source ?? null,
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
      ? await validateTaskRows(
          db,
          auth.teamId,
          project.id,
          payload.rows
        )
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

  return {
    status: existing ? "updated" : "created",
    id: itemId,
    projectId: project.id,
    changedTaskRowKeys,
  };
}
