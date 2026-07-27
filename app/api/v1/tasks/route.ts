import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { visibleTasks } from "@/lib/auth/visibility";

export const runtime = "nodejs";

export type TaskFeedMode = "writeback" | "table" | "sync-origin";

const EPOCH = "1970-01-01T00:00:00Z";
const PAGE = 500;

/**
 * Resolve the feed mode (brain-api 1.13). `mode` is the explicit, versioned selector; the legacy
 * `?all=1` flag stays honoured so old clients get their exact response. Returns `null` for an
 * unrecognized `mode` value (→ 400) so a typo can't silently degrade into the writeback feed.
 *
 * Forward-compat: a PRE-1.13 brain ignores `mode` entirely and answers with `mode:"writeback"`,
 * which is how a 1.13 client feature-detects (it checks the echoed mode, not a version header).
 */
export function parseTaskFeedMode(
  mode: string | null,
  all: string | null,
): TaskFeedMode | null {
  if (mode === null || mode === "") return all === "1" ? "table" : "writeback";
  if (mode === "writeback" || mode === "table" || mode === "sync-origin")
    return mode;
  return null;
}

/**
 * sync-origin PAGES (1.13). The feed is ordered by `updated_at` ascending and capped at `PAGE`, so
 * a full page may be a truncation — and the client advances its cursor after a merge, which would
 * skip the remainder forever. Hand back the last row's `updated_at` as `next_cursor` so the client
 * can drain the backlog; null means "you have everything". The writeback/table modes keep their
 * historical `next_cursor: null` (pre-1.13 clients never page here).
 */
export function nextCursorFor(
  mode: TaskFeedMode,
  rows: { updated_at: string }[],
): string | null {
  if (mode !== "sync-origin" || rows.length < PAGE) return null;
  return new Date(rows[rows.length - 1].updated_at).toISOString();
}

/**
 * Task feed for `aios pull`.
 *
 *  • `writeback` (default) — rows created or modified IN THE DASHBOARD since the cursor.
 *  • `table` (`?all=1` or `?mode=table`) — the explicit tier-filtered full tasks-table read.
 *  • `sync-origin` (`?mode=sync-origin&project=<slug>`, brain-api 1.13, AIO-537) — the RETURN LEG:
 *    sync-origin rows (pushed from a workspace) for ONE project, so a workspace can merge brain/
 *    Linear status + assignee changes back into its markdown. Without it the markdown decays —
 *    the projection is one-way and the writeback feed is dashboard-origin only.
 *
 * Tier isolation (audit H1) applies to every mode: `tasks.audience` is filtered through the
 * `visibleTasks` choke-point, so an external-tier key never reads a team board. There is no RLS.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth)
    return errorResponse("unauthorized", "invalid API key or team", 401);

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:tasks:get`, 60))) {
    return errorResponse("rate_limited", "60 pulls/min per key", 429);
  }

  const url = new URL(req.url);
  const mode = parseTaskFeedMode(
    url.searchParams.get("mode"),
    url.searchParams.get("all"),
  );
  if (!mode)
    return errorResponse(
      "invalid_request",
      "mode must be one of: writeback, table, sync-origin",
      400,
    );
  const all = mode === "table";
  const since = all ? EPOCH : url.searchParams.get("since") || EPOCH;

  // sync-origin is deliberately single-project: the return leg answers "what changed on MY
  // workspace's rows", and a workspace only ever merges its own project's markdown table.
  let projectId: string | null = null;
  if (mode === "sync-origin") {
    const projectSlug = url.searchParams.get("project");
    if (!projectSlug)
      return errorResponse(
        "invalid_request",
        "project is required in sync-origin mode",
        400,
      );
    const { data: project, error: projectError } = await db
      .from("projects")
      .select("id")
      .eq("team_id", auth.teamId)
      .eq("slug", projectSlug)
      .maybeSingle();
    if (projectError)
      return errorResponse("internal", projectError.message, 500);
    // Unknown project → an empty feed, not an error: a workspace may legitimately have nothing
    // pushed yet, and an error here would be indistinguishable from "this brain predates 1.13".
    if (!project) return Response.json({ mode, tasks: [], next_cursor: null });
    projectId = (project as { id: string }).id;
  }

  let query = db
    .from("tasks")
    .select(
      "row_key, title, assignee, status, raw_status, sprint, due_date, parent_row_key, labels, priority, origin, updated_at, projects(slug), items:source_item_id(synced_at)",
    )
    .eq("team_id", auth.teamId)
    .gt("updated_at", since)
    .not("row_key", "is", null);
  if (projectId) query = query.eq("project_id", projectId);
  // Only rows a workspace pushed. Dashboard-origin rows stay the writeback feed's job, so the
  // two feeds never double-merge the same row.
  if (mode === "sync-origin") query = query.eq("origin", "sync");

  const { data, error } = await visibleTasks(
    query.order("updated_at", { ascending: true }).limit(PAGE),
    auth.memberTier,
  );
  if (error) return errorResponse("internal", error.message, 500);

  const selected = (data ?? []).filter((t) => {
    if (all) return true;
    // sync-origin rows are already scoped by project + origin in SQL; the writeback feed's
    // "changed after our push" test does not apply — the point is to surface drift that
    // accumulated at ANY time, bounded only by the caller's `since` cursor. The client's own
    // echo guard (raw_status / status equality) decides what is a real change.
    if (mode === "sync-origin") return true;
    if (t.origin === "ui") return true;
    const synced = (t.items as unknown as { synced_at: string } | null)
      ?.synced_at;
    return synced ? new Date(t.updated_at) > new Date(synced) : false;
  });

  const byProject = new Map<
    string,
    {
      row_key: string;
      title: string;
      assignee: string;
      status: string;
      sprint: string;
      due: string | null;
      parent: string | null;
      labels: string[];
      priority: string;
      raw_status?: string | null;
    }[]
  >();
  for (const t of selected) {
    const slug = (t.projects as unknown as { slug: string })?.slug ?? "unknown";
    if (!byProject.has(slug)) byProject.set(slug, []);
    const row = {
      row_key: t.row_key!,
      title: t.title,
      assignee: t.assignee,
      status: t.status,
      sprint: t.sprint,
      due: t.due_date,
      // v1.2 hierarchy fields (body is intentionally excluded — dashboard/DB-only).
      parent: t.parent_row_key ?? null,
      labels: (t.labels as string[] | null) ?? [],
      priority: t.priority ?? "none",
    };
    // `raw_status` is 1.13 and sync-origin-ONLY: the original markdown status string the workspace
    // pushed when it didn't map onto a canonical status (normalizeTaskStatus → backlog +
    // raw_status). The client uses it to tell a normalization echo ("todo" → backlog) apart from a
    // real brain-side change and must not overwrite the author's word for the former. Kept out of
    // the other modes so their responses stay byte-identical for pre-1.13 clients.
    byProject
      .get(slug)!
      .push(
        mode === "sync-origin"
          ? { ...row, raw_status: (t.raw_status as string | null) ?? null }
          : row,
      );
  }

  return Response.json({
    mode,
    tasks: [...byProject.entries()].map(([project, rows]) => ({
      project,
      rows,
    })),
    next_cursor: nextCursorFor(mode, (data ?? []) as { updated_at: string }[]),
  });
}
