import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * TICKFIT-1: the connector-cursor store — per-repo remote sync watermarks
 * (docs/design/tickfit1-github-watermark.md D1/D2e). This module is the ONLY writer of
 * `connector_cursors`; the probe's correctness depends on a cursor advancing ONLY after a
 * fully-successful pass, so the write is one owned seam, not a convention.
 *
 * Fail directions (D2): a read error returns null (→ the caller full-passes — over-work,
 * never under-work); a write error is returned, the caller logs it, and the next tick
 * full-passes again; delete is best-effort lifecycle hygiene (an orphan row is inert —
 * absent config means the repo is never iterated).
 */

export type ConnectorCursor = Record<string, unknown>;

export const githubCursorKey = (owner: string, repo: string): string => `github:${owner}/${repo}`;

export async function readConnectorCursor(
  db: DbClient,
  teamId: string,
  key: string
): Promise<ConnectorCursor | null> {
  try {
    const { data, error } = await db
      .from("connector_cursors")
      .select("cursor")
      .eq("team_id", teamId)
      .eq("key", key)
      .maybeSingle();
    if (error || !data) return null;
    const cursor = (data as { cursor: unknown }).cursor;
    return cursor && typeof cursor === "object" ? (cursor as ConnectorCursor) : null;
  } catch {
    return null;
  }
}

export async function writeConnectorCursor(
  db: DbClient,
  teamId: string,
  key: string,
  cursor: ConnectorCursor
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db
    .from("connector_cursors")
    .upsert({ team_id: teamId, key, cursor, updated_at: new Date().toISOString() }, { onConflict: "team_id,key" });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function deleteConnectorCursor(db: DbClient, teamId: string, key: string): Promise<void> {
  try {
    await db.from("connector_cursors").delete().eq("team_id", teamId).eq("key", key);
  } catch {
    // best-effort — an orphan cursor is inert (see module header).
  }
}
