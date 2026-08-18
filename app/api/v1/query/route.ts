import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey, authenticateAgentToken, isAgentBearer, type ApiAuth, type AgentApiAuth } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { querySchema, errorResponse } from "@/lib/api/schemas";
import { formatSseFrame } from "@/lib/api/sse";
import { retrieve } from "@/lib/query/retrieve";
import { streamAnswer } from "@/lib/query/claude";
import { pickTimezone, DEFAULT_TIMEZONE } from "@/lib/query/timezone";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import {
  ownsConversation,
  recentTurns,
  createConversation,
  appendMessage,
} from "@/lib/chat/store";
import { generateAndSetTitle } from "@/lib/chat/title";
import { recordLlmUsage } from "@/lib/costs/llm-usage";

export const runtime = "nodejs";
export const maxDuration = 120;

const DAILY_QUERIES_PER_MEMBER = 20;
const DAILY_TEAM_BUDGET_USD = 10;

export async function POST(req: NextRequest) {
  // Phase B slice 3 (spec §10/§17-B): `query` honors delegated `aiosd_*` tokens — the Phase A 403
  // refusal is lifted now that the retrieval path can attenuate (slice 2). A delegated principal
  // is ALWAYS oracle-attenuated (independent of `teams.access_enforcement`, which is the MEMBER
  // rollout flag) and STATELESS: no conversation read/write and no history leg — the launcher's
  // prior turns may quote items outside the token's scope. Rate limits, query_log and cost
  // metering attribute to the LAUNCHING member row — a token never burns the REPRESENTED
  // member's quota. (Distinct agent member rows do each get their own per-member bucket;
  // minting is admin-gated and the team-wide daily budget still caps total spend.)
  let agent: AgentApiAuth | null = null;
  let auth: ApiAuth | null = null;
  if (isAgentBearer(req)) {
    agent = await authenticateAgentToken(req);
    if (!agent) return errorResponse("unauthorized", "invalid agent token or team", 401);
  } else {
    auth = await authenticateApiKey(req);
    if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  }
  const teamId = agent?.teamId ?? auth!.teamId;
  const launcherId = agent?.memberId ?? auth!.memberId;
  const memberTier = agent?.memberTier ?? auth!.memberTier;

  const db = adminClient();
  if (!(await rateLimit(db, `${launcherId}:query`, 10))) {
    return errorResponse("rate_limited", "10 queries/min per member", 429);
  }

  // Daily guards: per-member count + per-team budget from query_log
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const { count: todayCount } = await db
    .from("query_log")
    .select("id", { count: "exact", head: true })
    .eq("member_id", launcherId)
    .gte("created_at", dayStart.toISOString());
  if ((todayCount ?? 0) >= DAILY_QUERIES_PER_MEMBER) {
    return errorResponse("rate_limited", `${DAILY_QUERIES_PER_MEMBER} queries/day per member`, 429);
  }
  const { data: spend } = await db
    .from("query_log")
    .select("cost_usd")
    .eq("team_id", teamId)
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

  // Delegated queries are STATELESS — refuse the param explicitly rather than silently ignoring
  // it (a caller passing a thread id must learn it isn't continuing one, not find out later).
  if (agent && conversation_id) {
    return errorResponse("invalid_payload", "delegated tokens are stateless — conversation_id is not supported", 422);
  }

  // Persistent thread, owned by the key's member — same store as the dashboard chat, so a CLI /
  // Telegram-via-Hermes turn continues the member's existing conversation. Load prior turns BEFORE
  // recording the current question; the assistant turn is persisted once streaming completes.
  // Delegated tokens get NO thread: nothing is read or written to the member's conversations.
  const owner = auth ? { teamId: auth.teamId, memberId: auth.memberId } : null;
  let conversationId = owner && conversation_id && (await ownsConversation(db, owner, conversation_id)) ? conversation_id : null;
  const priorTurns = owner && conversationId ? await recentTurns(db, owner, conversationId) : [];
  let createdNew = false;
  if (owner && !conversationId) {
    const created = await createConversation(db, owner, question);
    conversationId = created?.id ?? null;
    createdNew = true;
  }
  if (owner && conversationId) await appendMessage(db, owner, conversationId, "user", question);

  // Who the answer is FOR — anchors first-person resolution ("what did I ship?"). For a delegated
  // token that is the REPRESENTED member (on_behalf_of ?? launcher), resolved live.
  let caller: { displayName: string | null; email: string | null; handle: string };
  const representedId = agent ? (agent.onBehalfOf ?? agent.memberId) : auth!.memberId;
  if (agent) {
    const { data: rep } = await db
      .from("members")
      .select("display_name, email, actor_handle")
      .eq("team_id", teamId)
      .eq("id", representedId)
      .maybeSingle();
    caller = { displayName: rep?.display_name ?? null, email: rep?.email ?? null, handle: rep?.actor_handle ?? "agent" };
  } else {
    caller = { displayName: auth!.displayName, email: auth!.email, handle: auth!.actorHandle };
  }

  // Timezone for relative-date anchoring (no browser here): member profile → instance default.
  const { data: prof } = await db
    .from("member_profiles")
    .select("timezone")
    .eq("team_id", teamId)
    .eq("member_id", representedId)
    .maybeSingle();
  const timeZone = pickTimezone([prof?.timezone, DEFAULT_TIMEZONE]);

  // Access enforcement (spec §5.2/§5.8b/§10). Members: on an 'enforcing' team, retrieval filters
  // to the member's membership-visible items (permissive → null → byte-identical to today).
  // Delegated tokens: ALWAYS attenuated to the live triple intersection — flag-independent; a
  // permissive team must never widen a scoped token to full-corpus answers. Graph legs (PCCC-6):
  // team-tier MEMBERS get the K-capped partitioned leg via graphProjectIds; external members and
  // delegated tokens keep the §5.8b omit. Any error fails closed (500).
  let enforce: import("@/lib/query/retrieve").RetrieveEnforce | null = null;
  try {
    const { visibleItemIds, delegatedVisibleItemIds } = await import("@/lib/access/enforce");
    if (agent) {
      const { ids } = await delegatedVisibleItemIds(db, agent);
      // QMIR-1: a delegated token is `principal: "token"` — the org-structural mirror legs stay
      // absolutely omitted for it, tier-independent (the round-3 Codex Critical posture).
      enforce = { visibleItemIds: ids, principal: "token" };
    } else {
      // PRET-6: enforcing is the only behavior — the member arm is unconditional.
      const { ids, projectIds } = await visibleItemIds(db, { teamId, memberId: auth!.memberId });
      // PCCC-6, widened by PRET-4 §1b (ruling 2): EVERY member principal gets the graph leg
      // over their oracle-resolved partitions — an external member's projectIds resolve their
      // granted projects, so their graph scope is exactly their membership. The delegated path
      // above still passes NO graphProjectIds (token omit, program §8). QMIR-1's
      // `principal: "member"` readmits the org-structural mirror legs for every member.
      enforce = { visibleItemIds: ids, principal: "member", graphProjectIds: projectIds };
    }
  } catch {
    return errorResponse("internal", "enforcement check failed", 500);
  }

  // Access enforcement (Codex HIGH): prior assistant turns can quote content whose items are no
  // longer visible to this principal (e.g. after a group change) — omit history under enforcing
  // until turns are visibility-revalidated. The current turn's answer is freshly retrieval-grounded.
  const historyTurns = enforce ? [] : priorTurns;

  // Quota integrity (Codex B3 High): write the query_log row BEFORE streaming and UPDATE it on
  // `done` — the daily count and team budget read query_log, and a row written only in the done
  // branch made read-the-deltas-and-disconnect free and uncounted (10/min sustained, forever).
  // An attempt now consumes quota even when the stream errors or is canceled; token/cost fields
  // stay 0 for incomplete streams (the usage numbers only exist at `done`).
  const started = Date.now();
  const { data: logRow, error: logErr } = await db
    .from("query_log")
    .insert({ team_id: teamId, member_id: launcherId, question })
    .select("id")
    .single();
  if (logErr || !logRow) {
    // Fail closed: an uncountable query must not run (otherwise the bypass reopens on DB errors).
    return errorResponse("internal", "query accounting failed", 500);
  }
  const queryLogId = (logRow as { id: string }).id;
  const ctx = await retrieve(db, teamId, memberTier, question, project, enforce);

  // Per-team provider keys + models + the explicit answering-backend override (same resolver the
  // dashboard route uses, so both honor OpenRouter/OpenAI/local + `teams.answering_provider`).
  const keys = await resolveAnsweringKeys(db, teamId);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(formatSseFrame(event, data)));

      if (conversationId) send("conversation", { id: conversationId });

      let answer = "";
      try {
        for await (const chunk of streamAnswer(ctx, question, keys, historyTurns, caller, timeZone)) {
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

            if (owner && conversationId) {
              await appendMessage(db, owner, conversationId, "assistant", answer, {
                cited_item_ids: sources.map((s) => s.item_id).filter((id): id is string => Boolean(id)),
                input_tokens: chunk.usage.input_tokens,
                output_tokens: chunk.usage.output_tokens,
                cost_usd: chunk.usage.cost_usd,
              });
              if (createdNew) {
                await generateAndSetTitle(db, owner, conversationId, question, answer, keys);
              }
            }

            await db.from("query_log").update({
              answer_preview: answer.slice(0, 500),
              cited_item_ids: sources.map((s) => s.item_id).filter(Boolean),
              input_tokens: chunk.usage.input_tokens,
              output_tokens: chunk.usage.output_tokens,
              cache_read_tokens: chunk.usage.cache_read_tokens,
              cost_usd: chunk.usage.cost_usd,
              latency_ms: Date.now() - started,
            }).eq("id", queryLogId);

            // Meter this answer's spend into the unified brain-inference ledger (source "query"), so
            // the Pulse Spend KPI + costs breakdown see it alongside every background LLM task.
            await recordLlmUsage(db, {
              teamId,
              memberId: launcherId,
              source: "query",
              provider: chunk.usage.provider,
              model: chunk.usage.model,
              inputTokens: chunk.usage.input_tokens,
              outputTokens: chunk.usage.output_tokens,
              costUsd: chunk.usage.cost_usd,
              estimated: chunk.usage.estimated,
            });
          }
        }
      } catch (e) {
        // Generic wire message (Codex B3 Low): raw LLM errors carry the model, internal base URL
        // and upstream body — infrastructure detail no bearer (least of all a delegated one)
        // should receive. Full detail goes to the server log.
        console.error("[query] stream failed:", e instanceof Error ? e.message : e);
        send("error", { message: "query failed" });
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
