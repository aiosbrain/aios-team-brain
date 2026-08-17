import { NextRequest } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { formatSseFrame } from "@/lib/api/sse";
import { retrieve } from "@/lib/query/retrieve";
import { pickTimezone, DEFAULT_TIMEZONE } from "@/lib/query/timezone";
import {
  ownsConversation,
  recentTurns,
  createConversation,
  appendMessage,
} from "@/lib/chat/store";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { runAnswerTurn } from "@/lib/query/stream-persist";
import { createRun } from "@/lib/query/turn-runs";
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
function syncResponse(db: ReturnType<typeof adminClient>, teamId: string, memberId: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(formatSseFrame(event, data)));
      try {
        send("delta", { text: "🔄 Scraping connectors (Slack · Plane · Linear · GitHub)…\n\n" });
        const r = await runManualSync(teamId);
        send("delta", { text: r.summary });
        send("sources", { sources: [] });
        send("done", { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 });
        await audit(db, {
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
  // Browser-detected IANA timezone (Intl.DateTimeFormat().resolvedOptions().timeZone) so relative
  // dates ("today") resolve in the ASKER's timezone. Optional/validated; falls back to profile/UTC.
  tz: z.string().max(64).optional(),
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
  const { question, team: teamSlug, project, conversation_id, tz } = parsed.data;

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

  // Timezone for relative-date anchoring: browser tz (most accurate) → member profile → instance default.
  const { data: prof } = await rls
    .from("member_profiles")
    .select("timezone")
    .eq("team_id", team.id)
    .eq("member_id", me.id)
    .maybeSingle();
  const timeZone = pickTimezone([tz, prof?.timezone, DEFAULT_TIMEZONE]);

  const memberTier = me.tier as "team" | "external";
  const db = adminClient();

  // The query box doubles as a scrape trigger: "/sync" / "scrape now" / … pulls every enabled
  // connector instead of asking the LLM. team-tier only (external collaborators can't trigger a
  // sync of internal data); its own tighter rate limit; doesn't consume the daily LLM query budget.
  if (isSyncCommand(question)) {
    if (isRestrictedTier(memberTier)) {
      return errorResponse("forbidden", "scraping is available to team members only", 403);
    }
    if (!(await rateLimit(db, `${me.id}:sync`, 2))) {
      return errorResponse("rate_limited", "2 scrapes/min per member — try again shortly", 429);
    }
    return syncResponse(db, team.id, me.id);
  }

  if (!(await rateLimit(db, `${me.id}:query`, 10))) {
    return errorResponse("rate_limited", "10 queries/min per member", 429);
  }

  // Daily guards: per-member count + per-team budget from query_log
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const { count: todayCount } = await db
    .from("query_log")
    .select("id", { count: "exact", head: true })
    .eq("member_id", me.id)
    .gte("created_at", dayStart.toISOString());
  if ((todayCount ?? 0) >= DAILY_QUERIES_PER_MEMBER) {
    return errorResponse("rate_limited", `${DAILY_QUERIES_PER_MEMBER} queries/day per member`, 429);
  }
  const { data: spend } = await db
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
  let conversationId = conversation_id && (await ownsConversation(db, owner, conversation_id)) ? conversation_id : null;
  const priorTurns = conversationId ? await recentTurns(db, owner, conversationId) : [];
  let createdNew = false;
  if (!conversationId) {
    const created = await createConversation(db, owner, question);
    conversationId = created?.id ?? null;
    createdNew = true;
  }
  if (conversationId) await appendMessage(db, owner, conversationId, "user", question);

  // Access enforcement (Phase B slice 2): same as the API query route — filter retrieval to the
  // member's membership-visible items on an 'enforcing' team; permissive → null → byte-identical.
  let enforce: import("@/lib/query/retrieve").RetrieveEnforce | null = null;
  try {
    const { teamEnforcesAccess, visibleItemIds } = await import("@/lib/access/enforce");
    if (await teamEnforcesAccess(db, team.id)) {
      const { ids, projectIds } = await visibleItemIds(db, { teamId: team.id, memberId: me.id });
      // PCCC-6: the dashboard chat is the members' PRIMARY conversational surface — it gets the
      // K-capped partitioned graph leg exactly like /api/v1/query (review Medium 7: leaving it on
      // the omit path while the API had the leg was an unrecorded split). Team-tier members only.
      // QMIR-1: only members reach this route (`authenticateApiKey` fail-closes the aiosd_ prefix
      // before it), so `principal: "member"` — the org-structural legs follow the tier.
      enforce = { visibleItemIds: ids, principal: "member", ...(me.tier === "team" ? { graphProjectIds: projectIds } : {}) };
    }
  } catch {
    return errorResponse("internal", "enforcement check failed", 500);
  }

  // Access enforcement (Codex HIGH): prior assistant turns can quote content whose items are no
  // longer visible to this principal (e.g. after a group change) — omit history under enforcing
  // until turns are visibility-revalidated. The current turn's answer is freshly retrieval-grounded.
  const historyTurns = enforce ? [] : priorTurns;
  const started = Date.now();
  const ctx = await retrieve(db, team.id, memberTier, question, project, enforce);

  // Per-team provider keys + models + the explicit answering-backend override (null fields → env
  // fallback in streamAnswer; `activeProvider` forces a backend, else selectLlmBackend precedence).
  const keys = await resolveAnsweringKeys(db, team.id);

  // DEFERRED, deliberately (review: "no idempotency or active-run guard"). Two tabs — or a client that
  // re-POSTs after losing the SSE — start two turns in one conversation: two answers, two spend rows,
  // and interleaved messages that can mispair `recentTurns`. That is TRUE TODAY on `main` and is not
  // introduced here; this slice widens it only slightly, by auto-reopening the same thread in a second
  // tab. It is NOT fixed here because the obvious guard is worse than the bug: rejecting a POST while a
  // `streaming` run exists blocks the user for up to the staleness window (3 min) whenever a run is
  // orphaned but not yet aged out — turning a rare duplicate into a routine lockout. Doing it properly
  // means a client-supplied idempotency key + a unique constraint, which is its own slice with its own
  // wire-format change. Tracked; see docs/design/query-background-stream.md "Scope".
  //
  // The in-flight run row: what makes this turn survive its client and be re-attachable on return
  // (QBGSTREAM-1). Best-effort — a run-table failure must not stop the user getting an answer.
  let runId: string | null = null;
  if (conversationId) {
    try {
      runId = (await createRun(db, owner, conversationId, question))?.id ?? null;
    } catch (e) {
      console.error("[query] could not create turn run:", e instanceof Error ? e.message : e);
    }
  }

  const encoder = new TextEncoder();
  // `cancelled` flips when the browser goes away (tab close / reload / navigation / network drop).
  // After that, `send` is a NO-OP rather than a throw: the generation + persistence below must run to
  // completion regardless, which is exactly what a disconnected turn previously lost (no assistant
  // message and no query_log row for an answer the provider had already billed).
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(formatSseFrame(event, data)));
        } catch {
          // The client vanished between the check and the write — stop trying, keep working.
          cancelled = true;
        }
      };

      // Tell the client which thread this turn belongs to (a new conversation returns its fresh id).
      // The payload stays EXACTLY `{ id }`: the foreground SSE contract is byte-identical to before
      // this slice (spec acceptance criterion 8), and reattach keys off the conversation id anyway —
      // a `run_id` here would have changed a shipped wire format for a field nothing reads.
      if (conversationId) send("conversation", { id: conversationId });

      // Stream + persist. Everything durable happens inside, decoupled from `send`, so a client that
      // disappears mid-answer still gets its message, query_log row and cost metered (and its run row
      // finalized, so a returning tab sees the finished answer instead of a dead spinner).
      await runAnswerTurn({
        db,
        owner,
        conversationId,
        runId,
        question,
        ctx,
        keys,
        historyTurns,
        caller,
        timeZone,
        createdNew,
        startedAt: started,
        send,
      });

      try {
        controller.close();
      } catch {
        // Already closed by the client's cancel — nothing to do.
      }
    },
    cancel() {
      // The browser went away. Mark it so `send` stops enqueuing; the `start` task keeps running to
      // completion on this long-lived Node server (Railway), which is what makes the turn survive.
      // NOTE for self-hosters: on a freeze-after-response serverless platform the process may be
      // suspended here instead, and the turn would not complete — this design assumes a persistent
      // Node server, as documented in docs/design/query-background-stream.md.
      cancelled = true;
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
