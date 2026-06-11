import { NextRequest } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { retrieve } from "@/lib/query/retrieve";
import { streamAnswer } from "@/lib/query/claude";

export const runtime = "nodejs";
export const maxDuration = 120;

// Same daily caps as the machine API (/api/v1/query).
const DAILY_QUERIES_PER_MEMBER = 20;
const DAILY_TEAM_BUDGET_USD = 10;

const dashboardQuerySchema = z.object({
  question: z.string().min(1).max(4000),
  team: z.string().min(1).max(120),
  project: z.string().nullable().optional(),
});

/**
 * Session-authenticated twin of /api/v1/query for dashboard users:
 * Supabase session → member + tier under RLS, then the same caps,
 * retrieval and Claude streaming as the API-key path.
 */
export async function POST(req: NextRequest) {
  const rls = await serverClient();
  const {
    data: { user },
  } = await rls.auth.getUser();
  if (!user) return errorResponse("unauthorized", "sign in required", 401);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }
  const parsed = dashboardQuerySchema.safeParse(json);
  if (!parsed.success) return errorResponse("invalid_payload", "question and team required", 422);
  const { question, team: teamSlug, project } = parsed.data;

  // Resolve team + membership under RLS — returns nothing unless the
  // signed-in user is an active member of that team.
  const { data: team } = await rls
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return errorResponse("forbidden", "not a member of this team", 403);

  const { data: me } = await rls
    .from("members")
    .select("id, tier")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return errorResponse("forbidden", "not a member of this team", 403);

  const memberTier = me.tier as "team" | "external";
  const supabase = adminClient();

  if (!(await rateLimit(supabase, `${me.id}:query`, 10))) {
    return errorResponse("rate_limited", "10 queries/min per member", 429);
  }

  // Daily guards: per-member count + per-team budget from query_log
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const { count: todayCount } = await supabase
    .from("query_log")
    .select("id", { count: "exact", head: true })
    .eq("member_id", me.id)
    .gte("created_at", dayStart.toISOString());
  if ((todayCount ?? 0) >= DAILY_QUERIES_PER_MEMBER) {
    return errorResponse("rate_limited", `${DAILY_QUERIES_PER_MEMBER} queries/day per member`, 429);
  }
  const { data: spend } = await supabase
    .from("query_log")
    .select("cost_usd")
    .eq("team_id", team.id)
    .gte("created_at", dayStart.toISOString());
  const teamSpend = (spend ?? []).reduce((s, r) => s + Number(r.cost_usd), 0);
  if (teamSpend >= DAILY_TEAM_BUDGET_USD) {
    return errorResponse("rate_limited", "team daily query budget reached — see admin/policy", 429);
  }

  const started = Date.now();
  const ctx = await retrieve(supabase, team.id, memberTier, question, project);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      let answer = "";
      try {
        for await (const chunk of streamAnswer(ctx, question)) {
          if (chunk.type === "delta") {
            answer += chunk.text;
            send("delta", { text: chunk.text });
          } else {
            const cited = new Set<string>();
            for (const m of answer.matchAll(/\[(S\d+)\]/g)) cited.add(m[1]);
            const sources = ctx.sources
              .filter((s) => cited.has(s.sid))
              .map((s) => ({
                id: s.sid,
                item_id: s.item_id,
                project: s.project,
                path: s.path,
                kind: s.kind,
              }));
            send("sources", { sources });
            send("done", chunk.usage);

            await supabase.from("query_log").insert({
              team_id: team.id,
              member_id: me.id,
              question,
              answer_preview: answer.slice(0, 500),
              cited_item_ids: sources.map((s) => s.item_id).filter(Boolean),
              input_tokens: chunk.usage.input_tokens,
              output_tokens: chunk.usage.output_tokens,
              cache_read_tokens: chunk.usage.cache_read_tokens,
              cost_usd: chunk.usage.cost_usd,
              latency_ms: Date.now() - started,
            });
          }
        }
      } catch (e) {
        send("error", { message: e instanceof Error ? e.message : "query failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
