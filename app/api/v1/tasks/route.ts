import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { visibleTasks } from "@/lib/auth/visibility";

export const runtime = "nodejs";

/**
 * Task writeback for `aios pull`: rows created or modified IN THE DASHBOARD
 * since the cursor — origin='ui' rows, plus sync rows whose updated_at moved
 * after their source item's synced_at (i.e. a Kanban drag).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:tasks:get`, 60))) {
    return errorResponse("rate_limited", "60 pulls/min per key", 429);
  }

  const url = new URL(req.url);
  const since = url.searchParams.get("since") || "1970-01-01T00:00:00Z";

  // Tier isolation (audit H1): an external-tier key must never pull internal task boards. `tasks`
  // carries `audience` (inherited from the source item's access) — filter it via the choke-point.
  const { data, error } = await visibleTasks(
    supabase
      .from("tasks")
      .select(
        "row_key, title, assignee, status, sprint, due_date, parent_row_key, labels, priority, origin, updated_at, projects(slug), items:source_item_id(synced_at)"
      )
      .eq("team_id", auth.teamId)
      .gt("updated_at", since)
      .not("row_key", "is", null)
      .order("updated_at", { ascending: true })
      .limit(500),
    auth.memberTier
  );
  if (error) return errorResponse("internal", error.message, 500);

  const uiChanged = (data ?? []).filter((t) => {
    if (t.origin === "ui") return true;
    const synced = (t.items as unknown as { synced_at: string } | null)?.synced_at;
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
    }[]
  >();
  for (const t of uiChanged) {
    const slug = (t.projects as unknown as { slug: string })?.slug ?? "unknown";
    if (!byProject.has(slug)) byProject.set(slug, []);
    byProject.get(slug)!.push({
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
    });
  }

  return Response.json({
    tasks: [...byProject.entries()].map(([project, rows]) => ({ project, rows })),
    next_cursor: null,
  });
}
