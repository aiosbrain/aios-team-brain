import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { itemPayloadSchema, normalizeTier, errorResponse } from "@/lib/api/schemas";
import { ingestItem } from "@/lib/ingest";

export const runtime = "nodejs";

const MAX_PAYLOAD = 1_000_000; // 1 MB per contract
const PAGE_SIZE = 200;

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:items:post`, 120))) {
    return errorResponse("rate_limited", "120 pushes/min per key", 429);
  }

  const len = parseInt(req.headers.get("content-length") || "0", 10);
  if (len > MAX_PAYLOAD * 1.2) return errorResponse("payload_too_large", "max 1 MB", 413);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }
  const parsed = itemPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("invalid_payload", parsed.error.issues[0]?.message ?? "invalid", 422);
  }
  if (parsed.data.body.length > MAX_PAYLOAD) {
    return errorResponse("payload_too_large", "body exceeds 1 MB", 413);
  }

  const tier = normalizeTier(parsed.data.access);
  if (parsed.data.access === "admin" || parsed.data.access === "private") {
    return errorResponse(
      "forbidden_tier",
      "private/admin-tier content must never leave the workspace",
      422
    );
  }
  if (!tier) {
    return errorResponse("invalid_payload", `unknown access tier '${parsed.data.access}'`, 422);
  }

  try {
    const result = await ingestItem(supabase, auth, parsed.data, tier);
    return Response.json(result, { status: result.status === "created" ? 201 : 200 });
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "ingest failed", 500);
  }
}

export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:items:get`, 60))) {
    return errorResponse("rate_limited", "60 pulls/min per key", 429);
  }

  const url = new URL(req.url);
  const since = url.searchParams.get("since") || "1970-01-01T00:00:00Z";
  const cursor = url.searchParams.get("cursor");
  const project = url.searchParams.get("project");
  const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean);

  // Tier filtering re-applied server-side: external-tier keys see only external.
  let q = supabase
    .from("items")
    .select("id, path, kind, access, frontmatter, body, content_sha256, actor, updated_at, projects(slug)")
    .eq("team_id", auth.teamId)
    .gt("updated_at", cursor || since)
    .order("updated_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(PAGE_SIZE);
  if (auth.memberTier === "external") q = q.eq("access", "external");
  if (kinds?.length) q = q.in("kind", kinds);

  const { data, error } = await q;
  if (error) return errorResponse("internal", error.message, 500);

  let items = (data ?? []).map((i) => ({
    id: i.id,
    project: (i.projects as unknown as { slug: string })?.slug,
    path: i.path,
    kind: i.kind,
    access: i.access,
    frontmatter: i.frontmatter,
    body: i.body,
    content_sha256: i.content_sha256,
    actor: i.actor,
    updated_at: i.updated_at,
  }));
  if (project) items = items.filter((i) => i.project === project);

  const next_cursor =
    (data?.length ?? 0) === PAGE_SIZE ? data![data!.length - 1].updated_at : null;
  return Response.json({ items, next_cursor });
}
