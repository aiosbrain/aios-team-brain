import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";

export const runtime = "nodejs";

export type TaskFeedMode = "writeback" | "table" | "sync-origin";

const EPOCH = "1970-01-01T00:00:00Z";
const PAGE = 500;
/**
 * How many `row_key`s one by-key lookup may ask about (brain-api 1.14).
 *
 * Deliberately far below `PAGE`, because the whole value of the lookup is that ABSENCE IS PROOF —
 * and that only holds while the result cannot be truncated. A key may exist in more than one project
 * (`unique (team_id, project_id, row_key)`), so the row count is keys × projects; 200 leaves room for
 * that and still cannot plausibly reach 500. If it somehow does, `unknown_keys` comes back `null`
 * rather than wrong — see `unknownKeysFor`.
 */
const KEYS_MAX = 200;

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

/** A rejected `keys` request, with the reason the caller should see. */
export type TaskKeysParse = { keys: string[] } | { error: string };

/**
 * Parse `?keys=A,B,C` — the by-key existence lookup (brain-api 1.14).
 *
 * REFUSES outside table mode instead of answering. `writeback` hides `origin='sync'` rows and
 * `sync-origin` hides `origin='ui'` ones, so a real key asked about in either would come back
 * "unknown" — a confident wrong answer, which is precisely the failure this endpoint exists to end.
 * A caller that has typed the wrong mode wants to be told, not quietly misled.
 *
 * Duplicates are collapsed and blanks dropped, so `keys=A,,A` asks about one key; the caller's
 * accounting of what it asked for still has to match, which is why `unknown_keys` echoes keys rather
 * than counts.
 */
export function parseTaskKeys(raw: string | null, mode: TaskFeedMode): TaskKeysParse | null {
  if (raw === null) return null; // not a by-key request at all
  if (mode !== "table")
    return { error: "keys requires mode=table (or all=1) — other modes filter rows, so a real key would look missing" };
  const keys = [...new Set(raw.split(",").map((k) => k.trim()).filter(Boolean))];
  if (!keys.length) return { error: "keys must name at least one row_key" };
  if (keys.length > KEYS_MAX) return { error: `keys is limited to ${KEYS_MAX} per request` };
  return { keys };
}

/**
 * Which of the requested keys matched nothing the caller may see — the ANSWER to "does this exist?",
 * so a client never has to infer it from absence and get it wrong.
 *
 * `null` means UNDETERMINABLE, never "none": if the read hit the row cap it is a prefix, and a key
 * missing from a prefix proves nothing. That case is unreachable at `KEYS_MAX` × realistic project
 * counts, and it still returns null rather than a list that would be quietly wrong — the same rule
 * the CI consumer applies, kept on the side that actually knows.
 *
 * A key hidden by the caller's tier is reported as unknown, deliberately: "it exists but you may not
 * see it" is itself a disclosure, and the audience conjunct in the feed SQL is the only enforcement (no RLS).
 */
export function unknownKeysFor(
  requested: string[],
  rows: { row_key: string | null }[],
  truncated: boolean,
): string[] | null {
  if (truncated) return null;
  const found = new Set(rows.map((r) => r.row_key).filter(Boolean));
  return requested.filter((k) => !found.has(k));
}

/**
 * Task feed for `aios pull`.
 *
 *  • `writeback` (default) — rows created or modified IN THE DASHBOARD since the cursor.
 *  • `table` (`?all=1` or `?mode=table`) — the explicit tier-filtered full tasks-table read.
 *  • `keys` (`?mode=table&keys=AIO-1,AIO-2`, brain-api 1.14) — a BY-KEY lookup, answering "do these
 *    tickets exist?" in one request. `table` alone cannot answer it: it caps at 500 rows ordered
 *    `updated_at` ASCENDING with no cursor, so it returns the STALEST prefix — measured on prod, 677
 *    keyed tasks with `AIO-484` at rank 628, i.e. permanently invisible to the read that was being
 *    used to verify it. Here the query is bounded by the keys themselves, so ABSENCE IS PROOF, and
 *    `unknown_keys` states it outright instead of leaving the client to infer it.
 *  • `sync-origin` (`?mode=sync-origin&project=<slug>`, brain-api 1.13, AIO-537) — the RETURN LEG:
 *    sync-origin rows (pushed from a workspace) for ONE project, so a workspace can merge brain/
 *    Linear status + assignee changes back into its markdown. Without it the markdown decays —
 *    the projection is one-way and the writeback feed is dashboard-origin only.
 *
 * Tier isolation (audit H1) applies to every mode: the `tasks.audience` conjunct compiles into
 * the feed SQL (ENFB-2 — with the membership provenance predicate), so an external-tier key
 * never reads a team board. There is no RLS.
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

  const keysParse = parseTaskKeys(url.searchParams.get("keys"), mode);
  if (keysParse && "error" in keysParse)
    return errorResponse("invalid_request", keysParse.error, 400);
  const keys = keysParse?.keys ?? null;

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

  // ENFB-2 §2.2: EVERY filter that decides what this window serves — the provenance predicate
  // AND the per-mode filters (writeback's changed-after-push test lived app-side, post-LIMIT)
  // — compiles in-query, so the 500-row window fills with rows that will actually serve and
  // `unknown_keys`/`truncated` describe the SAME set the caller receives (design round 1 F3 +
  // the draft's by-construction claim made true). Audience conjunct preserved verbatim.
  const { visibleItemIds } = await import("@/lib/access/enforce");
  const vis = await visibleItemIds(db, { teamId: auth.teamId, memberId: auth.memberId });
  if (vis.error) return errorResponse("internal", "visibility resolution failed", 500);
  const { taskFeedWindow } = await import("@/lib/access/structured-windows");

  let data: (import("@/lib/access/structured-windows").TaskFeedRow & { projects: { slug: string } | null })[];
  try {
    const rows = await taskFeedWindow(
      auth.teamId,
      { visibleItemIds: vis.ids, teamPosture: auth.memberTier === "team" },
      {
        since,
        externalAudienceOnly: auth.memberTier !== "team",
        projectId,
        // The by-key filter is what makes absence provable: the result is bounded by what was
        // ASKED for, not by an arbitrary page of the newest-last table.
        keys,
        // Only rows a workspace pushed serve sync-origin. The writeback feed serves
        // dashboard-origin rows plus synced rows changed after their push (the client's echo
        // guard handles normalization echoes); table serves the whole scoped window.
        syncOriginOnly: mode === "sync-origin",
        writebackOnly: !all && mode !== "sync-origin",
        page: PAGE,
      }
    );
    data = rows.map((r) => ({ ...r, projects: r.project_slug ? { slug: r.project_slug } : null }));
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "task feed read failed", 500);
  }

  // Every in-window row serves — the mode filters moved into the window above.
  const selected = data;

  const byProject = new Map<
    string,
    {
      row_key: string;
      title: string;
      assignee: string;
      status: string;
      sprint: string;
      due: string | Date | null; // node-pg returns date columns as Date; JSON serialization is unchanged
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
    // 1.14, by-key requests ONLY — a caller that didn't ask about keys gets a byte-identical body.
    ...(keys
      ? {
          unknown_keys: unknownKeysFor(
            keys,
            selected as { row_key: string | null }[],
            (data ?? []).length >= PAGE,
          ),
        }
      : {}),
  });
}
