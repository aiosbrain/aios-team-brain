import "server-only";
import type { DbClient } from "@/lib/db/types";
import { computeTaskLinks } from "./issue-ref";

/**
 * The sole writer of `task_evidence` — persists the deterministic task↔evidence links (which items are
 * the actual work behind a task, by issue-key reference) for surfaces BEYOND the timeline (Query/CLI:
 * "what work went into AIO-123?"). Links ALL tasks (not just active ones) — a query surface must still
 * answer for a ticket that later went Done, unlike the timeline DISPLAY which links active tasks only.
 * The pure link core is `computeTaskLinks` (lib/dashboard/issue-ref). An LLM grouping pass
 * (method='llm') is a later, lower-confidence addition.
 */

const LINK_TASK_LIMIT = 5000;
const LINK_ITEM_LIMIT = 4000;

/**
 * Recompute + persist `task_evidence` for a team from deterministic issue-key references. Fetches the
 * team's issue-shaped tasks + recent items, computes links, and REPLACES this team's `issue_ref` edges
 * (delete-then-insert, so a removed reference prunes). Leaves `llm`/`manual` edges untouched. Sole
 * writer of `task_evidence`. Best-effort — never throws (the scheduler must not fail on this).
 *
 * Text source per item mirrors the timeline builder (the pg adapter's `.select` can't do `left(body,n)`,
 * and full doc bodies are large): a git commit's issue key lives in its BODY (small — fetched), every
 * other item's in its TITLE or PATH (a `chetan/AIO-123-fix` branch, a doc titled with the key). Two
 * scoped fetches avoid pulling large doc bodies.
 */
export async function linkTaskEvidence(db: DbClient, teamId: string): Promise<{ linked: number }> {
  try {
    const [taskRes, gitRes, allRes] = await Promise.all([
      db.from("tasks").select("id, row_key").eq("team_id", teamId).not("row_key", "is", null).order("id", { ascending: true }).limit(LINK_TASK_LIMIT),
      // git items: issue key is in the commit message (body) — bodies are small.
      db
        .from("items")
        .select("id, frontmatter, body")
        .eq("team_id", teamId)
        .eq("frontmatter->>source", "git")
        .order("synced_at", { ascending: false })
        .limit(LINK_ITEM_LIMIT),
      // everything else: title + path only (no large-body fetch). Fetch ALL items and exclude git in JS
      // — a `.neq("frontmatter->>source","git")` is NULL-falsy and would silently drop no-source docs
      // (which the builder DOES include), making the two "same links" surfaces disagree.
      db
        .from("items")
        .select("id, frontmatter, path")
        .eq("team_id", teamId)
        .order("synced_at", { ascending: false })
        .limit(LINK_ITEM_LIMIT),
    ]);
    if (taskRes.error || gitRes.error || allRes.error) return { linked: 0 };

    const tasks = (taskRes.data ?? []) as { id: string; row_key: string | null }[];
    const gitItems = ((gitRes.data ?? []) as { id: string; frontmatter: Record<string, unknown> | null; body: string | null }[]).map(
      (r) => ({ id: r.id, text: `${(r.frontmatter?.title as string) ?? ""}\n${r.body ?? ""}` })
    );
    const otherItems = ((allRes.data ?? []) as { id: string; frontmatter: Record<string, unknown> | null; path: string | null }[])
      .filter((r) => r.frontmatter?.source !== "git") // git handled above (with body) — no double / no override
      .map((r) => ({ id: r.id, text: `${(r.frontmatter?.title as string) ?? ""}\n${r.path ?? ""}` }));
    const links = computeTaskLinks(tasks, [...gitItems, ...otherItems]);

    // Replace this team's deterministic edges: drop all issue_ref rows, re-insert the current set. If the
    // delete errored, skip the insert so we don't append duplicates onto a stale set (best-effort; the
    // next tick reconverges). Non-transactional is acceptable while nothing reads the table yet.
    const del = await db.from("task_evidence").delete().eq("team_id", teamId).eq("method", "issue_ref");
    if (del.error) return { linked: 0 };
    const rows: { team_id: string; task_id: string; item_id: string; method: string; confidence: number }[] = [];
    for (const [itemId, taskIds] of links) {
      for (const taskId of taskIds) rows.push({ team_id: teamId, task_id: taskId, item_id: itemId, method: "issue_ref", confidence: 1.0 });
    }
    if (rows.length) await db.from("task_evidence").upsert(rows, { onConflict: "team_id,task_id,item_id" });
    return { linked: rows.length };
  } catch {
    return { linked: 0 };
  }
}
