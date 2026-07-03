import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { querySchema, errorResponse } from "@/lib/api/schemas";
import { retrieve } from "@/lib/query/retrieve";
import { streamAnswer } from "@/lib/query/claude";
import { pickTimezone, DEFAULT_TIMEZONE } from "@/lib/query/timezone";
import { getProviderKey } from "@/lib/integrations/manage";
import {
  ownsConversation,
  recentTurns,
  createConversation,
  appendMessage,
} from "@/lib/chat/store";
import { generateAndSetTitle } from "@/lib/chat/title";

export const runtime = "nodejs";
export const maxDuration = 120;

const DAILY_QUERIES_PER_MEMBER = 20;
const DAILY_TEAM_BUDGET_USD = 10;

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.memberId}:query`, 10))) {
    return errorResponse("rate_limited", "10 queries/min per member", 429);
  }

  // Daily guards: per-member count + per-team budget from query_log
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const { count: todayCount } = await supabase
    .from("query_log")
    .select("id", { count: "exact", head: true })
    .eq("member_id", auth.memberId)
    .gte("created_at", dayStart.toISOString());
  if ((todayCount ?? 0) >= DAILY_QUERIES_PER_MEMBER) {
    return errorResponse("rate_limited", `${DAILY_QUERIES_PER_MEMBER} queries/day per member`, 429);
  }
  const { data: spend } = await supabase
    .from("query_log")
    .select("cost_usd")
    .eq("team_id", auth.teamId)
    .gte("created_at", dayStart.toISOString());
  const teamSpend = (spend ?? []).reduce((s, r) => s + Number(r.cost_usd), 0);
  if (teamSpend >= DAILY_TEAM_BUDGET_USD) {
    return errorResponse("rate_limited", "team daily query budget reached — see admin/policy", 429);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }
  const parsed = querySchema.safeParse(json);
  if (!parsed.success) return errorResponse("invalid_payload", "question required", 422);
  const { question, project, conversation_id } = parsed.data;

  // Persistent thread, owned by the key's member — same store as the dashboard chat, so a CLI /
  // Telegram-via-Hermes turn continues the member's existing conversation. Load prior turns BEFORE
  // recording the current question; the assistant turn is persisted once streaming completes.
  const owner = { teamId: auth.teamId, memberId: auth.memberId };
  let conversationId = conversation_id && (await ownsConversation(supabase, owner, conversation_id)) ? conversation_id : null;
  const priorTurns = conversationId ? await recentTurns(supabase, owner, conversationId) : [];
  let createdNew = false;
  if (!conversationId) {
    const created = await createConversation(supabase, owner, question);
    conversationId = created?.id ?? null;
    createdNew = true;
  }
  if (conversationId) await appendMessage(supabase, owner, conversationId, "user", question);

  // Who the answer is FOR — anchors first-person resolution ("what did I ship?") to this member.
  const caller = { displayName: auth.displayName, email: auth.email, handle: auth.actorHandle };

  // Timezone for relative-date anchoring (no browser here): member profile → instance default.
  const { data: prof } = await supabase
    .from("member_profiles")
    .select("timezone")
    .eq("team_id", auth.teamId)
    .eq("member_id", auth.memberId)
    .maybeSingle();
  const timeZone = pickTimezone([prof?.timezone, DEFAULT_TIMEZONE]);

  const started = Date.now();
  const ctx = await retrieve(supabase, auth.teamId, auth.memberTier, question, project);

  // Per-team provider keys (encrypted in integrations); null → env fallback in streamAnswer.
  const [anthropicKey, openaiKey] = await Promise.all([
    getProviderKey(supabase, auth.teamId, "anthropic"),
    getProviderKey(supabase, auth.teamId, "openai"),
  ]);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      if (conversationId) send("conversation", { id: conversationId });

      let answer = "";
      try {
        for await (const chunk of streamAnswer(ctx, question, { anthropicKey, openaiKey }, priorTurns, caller, timeZone)) {
          if (chunk.type === "delta") {
            answer += chunk.text;
            send("delta", { text: chunk.text });
          } else {
            // Citations: map [S#] markers in the answer to source items
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

            if (conversationId) {
              await appendMessage(supabase, owner, conversationId, "assistant", answer, {
                cited_item_ids: sources.map((s) => s.item_id).filter((id): id is string => Boolean(id)),
                input_tokens: chunk.usage.input_tokens,
                output_tokens: chunk.usage.output_tokens,
                cost_usd: chunk.usage.cost_usd,
              });
              if (createdNew) {
                await generateAndSetTitle(supabase, owner, conversationId, question, answer, { anthropicKey, openaiKey });
              }
            }

            await supabase.from("query_log").insert({
              team_id: auth.teamId,
              member_id: auth.memberId,
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
