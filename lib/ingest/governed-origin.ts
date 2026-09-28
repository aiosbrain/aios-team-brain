import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { ItemPayload } from "@/lib/api/item-payload-schema";
import { canSeeItem } from "@/lib/access/enforce";

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

/** A known note mirror may be echoed, never created or changed through legacy ingress. */
export async function governedNoteEcho(
  db: DbClient,
  auth: { teamId: string; memberId: string },
  projectId: string | null,
  payload: ItemPayload,
  pusherTier: "team" | "external",
): Promise<string | null> {
  if (!projectId) {
    if (payload.kind === "note" || payload.path.startsWith(GOVERNED_ITEM_PREFIX)) throw new ImmutableOriginError();
    return null;
  }
  const { data: item, error } = await db.from("items")
    .select("id,kind,access,body,actor,frontmatter,content_sha256")
    .eq("team_id", auth.teamId).eq("project_id", projectId).eq("path", payload.path).maybeSingle();
  if (error) throw new Error("governed note lookup unavailable");
  if (!item) {
    if (payload.kind === "note" || payload.path.startsWith(GOVERNED_ITEM_PREFIX)) throw new ImmutableOriginError();
    return null;
  }
  const { data: origin, error: originError } = await db.from("governed_item_origins")
    .select("kind").eq("team_id", auth.teamId).eq("item_id", item.id).maybeSingle();
  if (originError) throw new Error("governed origin lookup unavailable");
  if (origin?.kind !== "note") {
    if (payload.kind === "note") throw new ImmutableOriginError();
    return null;
  }
  const stable = (v: unknown): string => {
    if (Array.isArray(v)) return JSON.stringify(v.map(stable));
    if (v && typeof v === "object") return JSON.stringify(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,value]) => [k,stable(value)]));
    return JSON.stringify(v);
  };
  if (pusherTier !== "team" || !(await canSeeItem(db, auth, item.id as string)) ||
      payload.kind !== "note" || item.kind !== "note" || payload.access !== item.access ||
      payload.actor !== item.actor || payload.body !== item.body ||
      payload.content_sha256 !== item.content_sha256 || stable(payload.frontmatter) !== stable(item.frontmatter)) {
    throw new ImmutableOriginError();
  }
  return item.id as string;
}
