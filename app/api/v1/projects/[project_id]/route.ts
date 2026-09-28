import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/api/auth";
import { adminClient } from "@/lib/db/admin";
import { visibleProjectsWithError } from "@/lib/access/oracle";
import { errorResponse } from "@/lib/api/schemas";

export const runtime = "nodejs";
const noStore = (response: Response): Response => {
  response.headers.set("Cache-Control", "no-store");
  return response;
};

/** Verify one explicitly selected destination using current member authorization. */
export async function GET(req: NextRequest, context: { params: Promise<{ project_id: string }> }) {
  let auth;
  try {
    auth = await authenticateApiKey(req, { preserveErrors: true });
  } catch {
    return noStore(errorResponse("unavailable", "destination verification unavailable", 503));
  }
  if (!auth) return noStore(errorResponse("unauthorized", "invalid API key or team", 401));
  const { project_id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project_id)) {
    return noStore(errorResponse("not_found", "destination unavailable", 404));
  }
  const db = adminClient();
  const visible = await visibleProjectsWithError(db, { teamId: auth.teamId, memberId: auth.memberId });
  if (visible.error) return noStore(errorResponse("unavailable", "destination verification unavailable", 503));
  if (!visible.set.projectIds.has(project_id)) {
    return noStore(errorResponse("not_found", "destination unavailable", 404));
  }
  const { data, error } = await db.from("projects").select("id,team_id")
    .eq("team_id", auth.teamId).eq("id", project_id).maybeSingle();
  if (error) return noStore(errorResponse("unavailable", "destination verification unavailable", 503));
  if (!data) return noStore(errorResponse("not_found", "destination unavailable", 404));
  return noStore(Response.json({ project_id: data.id, team_id: data.team_id }));
}
