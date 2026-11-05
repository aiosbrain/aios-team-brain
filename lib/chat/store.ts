import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { ChatTurn } from "@/lib/query/claude";
import { runSql } from "@/lib/db/pg/pool";
import {
  outputReadable,
  readableOutputSql,
  outputReusable,
  withOutputRead,
  type OutputProvenance,
} from "@/lib/query/output-provenance";

/**
 * Single writer + reader for persistent chat history (`conversations` + `chat_messages`).
 *
 * Owner-scoped: every query is filtered by `(team_id, member_id)`, so a member only ever touches
 * their own conversations — there is no RLS backstop on the postgres target, so this module IS the
 * gate (guarded by test/guards/single-writer-chat). Threads persist server-side so the same history
 * shows up across sessions and interfaces (web, mobile, CLI, Telegram/Hermes) keyed by `conversation_id`.
 */

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  cited_item_ids: string[];
  created_at: string;
}

export interface MessageUsage {
  cited_item_ids?: string[];
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

const MAX_TITLE = 80;

/** A conversation title derived from its first question (cheap; an LLM title is a later nicety). */
export function deriveTitle(firstQuestion: string): string {
  const t = firstQuestion.trim().replace(/\s+/g, " ");
  if (!t) return "New chat";
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE).trimEnd()}…` : t;
}

type Owner = { teamId: string; memberId: string };

export async function createConversation(
  db: DbClient,
  owner: Owner,
  title: string
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from("conversations")
    .insert({ team_id: owner.teamId, member_id: owner.memberId, title: deriveTitle(title) })
    .select("id")
    .single();
  if (error) throw new Error(`createConversation: ${error.message}`);
  return (data as { id: string } | null) ?? null;
}

/** True iff this member owns the conversation (the owner check every reader/writer runs first). */
export async function ownsConversation(
  db: DbClient,
  owner: Owner,
  conversationId: string
): Promise<boolean> {
  const { data } = await db
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId)
    .is("archived_at", null)
    .maybeSingle();
  return Boolean((data as { id: string } | null)?.id);
}

/**
 * Insert one message and RETURN ITS ID. The id is what `chat_turn_runs.final_message_id` points at
 * (QBGSTREAM-1): the assistant message is written first, then the run flips to `done` carrying this
 * id, so a reader always prefers the completed answer over the run's partial text. Callers that don't
 * need the id can keep ignoring the return value.
 */
export async function appendMessage(
  db: DbClient,
  owner: Owner,
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  usage: MessageUsage,
  // AIO-1167 R76: the message's output provenance — 0 for a user message or a non-Google answer, the
  // answer's ORIGINAL positive epoch for a protected one. Required: new messages never store NULL.
  provenance: OutputProvenance,
): Promise<string | null> {
  const { data, error } = await db
    .from("chat_messages")
    .insert({
      conversation_id: conversationId,
      team_id: owner.teamId,
      member_id: owner.memberId,
      role,
      content,
      context_authorization_epoch: provenance.epoch,
      cited_item_ids: usage.cited_item_ids ?? [],
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cost_usd: usage.cost_usd ?? 0,
    })
    .select("id")
    .single();
  if (error) throw new Error(`appendMessage: ${error.message}`);
  const insertedId = (data as { id: string } | null)?.id ?? null;
  // Use the same database clock and precision as creation. PostgreSQL resolves
  // this timestamp input when the parameterized UPDATE executes, avoiding app
  // clock skew and millisecond rounding that can move activity backwards.
  await db
    .from("conversations")
    .update({ updated_at: "now" })
    .eq("id", conversationId)
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId);
  return insertedId;
}

/**
 * AIO-1167 R88 — the ONE fail-closed title projection, shared by list, detail and search.
 *
 * Titles carry no provenance of their own, and before R76 an automatic title was generated from the
 * question AND the answer, after the answer was stored. So a conversation holding ANY historical
 * assistant message (NULL provenance — uncertified generated output, R86 F1) may hold a title derived
 * from text that is no longer readable. Its stored title is therefore uncertified too, and is projected
 * as the title derived from the member's own FIRST question (`"New chat"` when there is none). Later
 * modern messages never re-certify it. A conversation with no historical answer keeps its stored title
 * (modern automatic titles are question-derived for protected answers and certified for source-free
 * ones; manual titles are the member's own). The classification does not depend on the revocation
 * epoch; when it cannot be read the reader throws — it never falls back to a raw title.
 */
async function projectTitles<T extends { id: string; title: string }>(owner: Owner, rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;
  const { rows: facts } = await runSql<{ id: string; uncertified: boolean; first_question: string | null }>(
    `select c.id::text as id,
            exists(select 1 from chat_messages m
                    where m.conversation_id = c.id and m.team_id = $2 and m.member_id = $3
                      and m.role = 'assistant' and m.context_authorization_epoch is null) as uncertified,
            (select m.content from chat_messages m
              where m.conversation_id = c.id and m.team_id = $2 and m.member_id = $3 and m.role = 'user'
              order by m.created_at asc, m.id asc limit 1) as first_question
       from unnest($1::uuid[]) as c(id)`,
    [rows.map((row) => row.id), owner.teamId, owner.memberId],
  );
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  return rows.map((row) => {
    const fact = byId.get(row.id);
    if (!fact) throw new Error("conversation title classification is incomplete");
    return fact.uncertified ? { ...row, title: deriveTitle(fact.first_question ?? "") } : row;
  });
}

/** The member's conversations, newest-active first, excluding archived. */
export async function listConversations(
  db: DbClient,
  owner: Owner,
  limit = 100
): Promise<Conversation[]> {
  const { data } = await db
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(limit);
  return projectTitles(owner, (data ?? []) as Conversation[]);
}

/**
 * Search the member's conversations by title OR message content (owner-scoped). Content matches use
 * FTS over `chat_messages` (`websearch_to_tsquery`); title matches are a case-insensitive substring
 * over the member's own list. Most-recent-active first, capped. Empty query → the plain list.
 */
export async function searchConversations(
  db: DbClient,
  owner: Owner,
  query: string,
  limit = 50
): Promise<Conversation[]> {
  const q = query.trim();
  if (!q) return listConversations(db, owner, limit);
  // Content matches: message bodies via FTS → the conversations they belong to (owner-scoped). AIO-1167
  // R76/R86 F1: a match inside generated output that is not certified now is no match — the member's own
  // questions always match; an answer only at 0 or the current epoch (historical NULL never).
  const hits = await withOutputRead(owner.teamId, async (current) => (await runSql<{ conversation_id: string }>(
    `select distinct conversation_id from chat_messages
      where team_id=$1 and member_id=$2 and search @@ websearch_to_tsquery('english', $3)
        and (role = 'user' or ${readableOutputSql("context_authorization_epoch", "$4")})
      limit 1000`,
    [owner.teamId, owner.memberId, q, current ?? -1],
  )).rows);
  const contentIds = new Set(hits.map((h) => h.conversation_id));
  // The member's non-archived conversations; keep those whose title matches OR whose content matched.
  const { data } = await db
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(500);
  const ql = q.toLowerCase();
  // R88: titles are matched AFTER projection — text only an uncertified stored title holds never matches.
  return (await projectTitles(owner, (data ?? []) as Conversation[]))
    .filter((c) => (c.title || "").toLowerCase().includes(ql) || contentIds.has(c.id))
    .slice(0, limit);
}

/** User-authored text is not generated output and stays readable; an answer follows `outputReadable`. */
function messageReadable(role: string, stored: unknown, current: number | null): boolean {
  return role === "user" || outputReadable(stored, current);
}

/** A conversation's full message thread — owner-checked; null if not owned/absent. */
export async function getConversation(
  db: DbClient,
  owner: Owner,
  conversationId: string
): Promise<{ id: string; title: string; messages: ChatMessage[] } | null> {
  const { data: convo } = await db
    .from("conversations")
    .select("id, title")
    .eq("id", conversationId)
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId)
    .is("archived_at", null)
    .maybeSingle();
  const c = convo as { id: string; title: string } | null;
  if (!c) return null;
  // AIO-1167 R76/R86 F1: the member's own questions are always kept; an answer (text and citations) only
  // when its output is certified now — historical (NULL), obsolete or unverifiable answers are omitted.
  const messages = await withOutputRead(owner.teamId, async (current) => {
    const { data: msgs } = await db
      .from("chat_messages")
      .select("id, role, content, cited_item_ids, created_at, context_authorization_epoch")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    return ((msgs ?? []) as (ChatMessage & { context_authorization_epoch?: unknown })[])
      .filter((m) => messageReadable(m.role, m.context_authorization_epoch, current))
      .map(({ context_authorization_epoch: _stored, ...message }) => message);
  });
  const [projected] = await projectTitles(owner, [c]);
  return { id: c.id, title: projected.title, messages };
}

/**
 * The last `maxTurns` completed (user→assistant) turns of a conversation, for the LLM memory window.
 * Owner-checked. Call this BEFORE persisting the current user message so it returns only prior turns.
 */
export async function recentTurns(
  db: DbClient,
  owner: Owner,
  conversationId: string,
  maxTurns = 6
): Promise<ChatTurn[]> {
  if (!(await ownsConversation(db, owner, conversationId))) return [];
  // AIO-1167 R76: only answers CERTIFIED for reuse as model input are history — 0, or protected output
  // whose epoch is current. Historical (NULL) answers stay readable but are not reused; obsolete ones
  // are excluded, and their question is left without a pair.
  const msgs = await withOutputRead(owner.teamId, async (current) => {
    const { data } = await db
      .from("chat_messages")
      .select("role, content, created_at, context_authorization_epoch")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    return ((data ?? []) as { role: "user" | "assistant"; content: string; context_authorization_epoch?: unknown }[])
      .filter((m) => m.role === "user" || outputReusable(m.context_authorization_epoch, current));
  });
  // Pair user→assistant into turns; keep only complete pairs.
  const turns: ChatTurn[] = [];
  let pendingQ: string | null = null;
  for (const m of msgs) {
    if (m.role === "user") {
      pendingQ = m.content;
    } else if (m.role === "assistant" && pendingQ !== null) {
      turns.push({ question: pendingQ, answer: m.content });
      pendingQ = null;
    }
  }
  return turns.slice(-maxTurns);
}

export async function renameConversation(
  db: DbClient,
  owner: Owner,
  conversationId: string,
  title: string
): Promise<boolean> {
  const { data, error } = await db
    .from("conversations")
    .update({ title: deriveTitle(title), updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`renameConversation: ${error.message}`);
  return Boolean((data as { id: string } | null)?.id);
}

/**
 * Set a conversation's title without bumping `updated_at` (so an auto-generated title doesn't
 * reorder the list). Owner-scoped. Used by the background title generator; a no-op if not owned.
 */
export async function setTitle(
  db: DbClient,
  owner: Owner,
  conversationId: string,
  title: string
): Promise<void> {
  const { error } = await db
    .from("conversations")
    .update({ title: deriveTitle(title) })
    .eq("id", conversationId)
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId);
  if (error) throw new Error(`setTitle: ${error.message}`);
}

/** Soft-delete (archive) — hides it from the list; messages stay for any later restore/audit. */
export async function archiveConversation(
  db: DbClient,
  owner: Owner,
  conversationId: string
): Promise<boolean> {
  const { data, error } = await db
    .from("conversations")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`archiveConversation: ${error.message}`);
  return Boolean((data as { id: string } | null)?.id);
}
