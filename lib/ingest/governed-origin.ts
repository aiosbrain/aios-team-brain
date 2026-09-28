import "server-only";
import type { DbClient } from "@/lib/db/types";

export const GOVERNED_ITEM_PREFIX = "1-inbox/governed/";
export class ImmutableOriginError extends Error {
  readonly code = "immutable_origin";
  constructor() {
    super("This governed record is immutable; refresh the read-only mirror.");
  }
}

/** Legacy ingress never acquires server-owned provenance from a path or frontmatter. */
export async function assertNotGovernedItem(
  db: DbClient,
  teamId: string,
  projectId: string | null,
  path: string,
): Promise<void> {
  if (path.startsWith(GOVERNED_ITEM_PREFIX)) throw new ImmutableOriginError();
  if (!projectId) return;
  const { data, error } = await db.from("items").select("id")
    .eq("team_id", teamId).eq("project_id", projectId).eq("path", path).maybeSingle();
  if (error) throw new Error("governed item lookup unavailable");
  if (!data) return;
  const { data: origin, error: originError } = await db.from("governed_item_origins")
    .select("item_id").eq("team_id", teamId).eq("item_id", data.id).maybeSingle();
  if (originError) throw new Error("governed origin lookup unavailable");
  if (origin) throw new ImmutableOriginError();
}
