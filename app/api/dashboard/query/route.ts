import { NextRequest } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth/session";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { retrieve } from "@/lib/query/retrieve";
import { streamAnswer } from "@/lib/query/claude";
import {
  ownsConversation,
  recentTurns,
  createConversation,
  appendMessage,
} from "@/lib/chat/store";
import { getProviderKey } from "@/lib/integrations/manage";
import { isSyncCommand, runManualSync } from "@/lib/ingest/manual-sync";
import { audit } from "@/lib/api/audit";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/**
 * Stream a manual scrape as the brain's "answer" (same delta/done SSE the chat already renders).
 * The query box doubles as a sync trigger: typing "/sync" (or "scrape now", …) pulls every enabled
 * connector for the team instead of asking the LLM. team-tier only + its own rate limit (enforced
 * by the caller); writes go through the single-writer ingestion underneath, and the run is audited.
 */
function syncResponse(supabase: ReturnType<typeof adminClient>, teamId: string, memberId: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        send("delta", { text: "🔄 Scraping connectors (Slack · Plane · Linear · GitHub)…\n\n" });
        const r = await runManualSync(teamId);
        send("delta", { text: r.summary });
        send("sources", { sources: [] });
        send("done", { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 });
        await audit(supabase, {
          team_id: teamId,
          actor_kind: "member",
          member_id: memberId,
          action: "ingest.manual_sync",
          meta: { created: r.created, updated: r.updated, errors: r.errors },
        });
      } catch (e) {
        send("error", { message: e instanceof Error ? e.message : "scrape failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

export const runtime = "nodejs";
export const maxDuration = 120;

// Same daily caps as the machine API (/api/v1/query).
const DAILY_QUERIES_PER_MEMBER = 20;
const DAILY_TEAM_BUDGET_USD = 10;

const dashboardQuerySchema = z.object({
  question: z.string().min(1).max(4000),
  team: z.string().min(1).max(120),
  project: z.string().nullable().optional(),
  // Persistent thread id. Omit to start a new conversation (the server creates one and returns its
  // id via a `conversation` SSE event); pass it back on later turns so history loads server-side.
  conversation_id: z.string().uuid().optional(),
});

/**
 * Session-authenticated twin of /api/v1/query for dashboard users:
 * Supabase session → member + tier under RLS, then the same caps,
 * retrieval and Claude streaming as the API-key path.
 */
export async function POST(req: NextRequest) {
  const rls = await serverClient();
  const user = await getSessionUser();
  if (!user) return errorResponse("unauthorized", "sign in required", 401);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }
  const parsed = dashboardQuerySchema.safeParse(json);
  if (!parsed.success) return errorResponse("invalid_payload", "question and team required", 422);
  const { question, team: teamSlug, project, conversation_id } = parsed.data;

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
    .select("id, tier, display_name, email, actor_handle")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return errorResponse("forbidden", "not a member of this team", 403);

  // Who the answer is FOR — anchors first-person resolution ("how about me?") to this person.
  const caller = { displayName: me.display_name, email: me.email, handle: me.actor_handle };

  const memberTier = me.tier as "team" | "external";
  const supabase = adminClient();

  // The query box doubles as a scrape trigger: "/sync" / "scrape now" / … pulls every enabled
  // connector instead of asking the LLM. team-tier only (external collaborators can't trigger a
  // sync of internal data); its own tighter rate limit; doesn't consume the daily LLM query budget.
  if (isSyncCommand(question)) {
    if (memberTier === "external") {
      return errorResponse("forbidden", "scraping is available to team members only", 403);
    }
    if (!(await rateLimit(supabase, `${me.id}:sync`, 2))) {
      return errorResponse("rate_limited", "2 scrapes/min per member — try again shortly", 429);
    }
    return syncResponse(supabase, team.id, me.id);
  }

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

  // Resolve the persistent thread: adopt the caller's conversation if they own it, else start one.
  // Load the prior turns for the LLM memory window BEFORE persisting the current question, then
  // record the user message. The assistant message is persisted once the answer finishes streaming.
  const owner = { teamId: team.id, memberId: me.id };
  let conversationId = conversation_id && (await ownsConversation(supabase, owner, conversation_id)) ? conversation_id : null;
  const priorTurns = conversationId ? await recentTurns(supabase, owner, conversationId) : [];
  if (!conversationId) {
    const created = await createConversation(supabase, owner, question);
    conversationId = created?.id ?? null;
  }
  if (conversationId) await appendMessage(supabase, owner, conversationId, "user", question);

  const started = Date.now();
  const ctx = await retrieve(supabase, team.id, memberTier, question, project);

  // Per-team provider keys (encrypted in integrations); null → env fallback in streamAnswer.
  const [anthropicKey, openaiKey] = await Promise.all([
    getProviderKey(supabase, team.id, "anthropic"),
    getProviderKey(supabase, team.id, "openai"),
  ]);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      // Tell the client which thread this turn belongs to (a new conversation returns its fresh id).
      if (conversationId) send("conversation", { id: conversationId });

      let answer = "";
      try {
        for await (const chunk of streamAnswer(ctx, question, { anthropicKey, openaiKey }, priorTurns, caller)) {
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

            // Persist the assistant turn into the thread (full answer + cited sources + cost).
            if (conversationId) {
              await appendMessage(supabase, owner, conversationId, "assistant", answer, {
                cited_item_ids: sources.map((s) => s.item_id).filter((id): id is string => Boolean(id)),
                input_tokens: chunk.usage.input_tokens,
                output_tokens: chunk.usage.output_tokens,
                cost_usd: chunk.usage.cost_usd,
              });
            }

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
