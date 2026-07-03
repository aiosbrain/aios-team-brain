import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { ChatTurn } from "@/lib/query/claude";

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
  supabase: DbClient,
  owner: Owner,
  title: string
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("conversations")
    .insert({ team_id: owner.teamId, member_id: owner.memberId, title: deriveTitle(title) })
    .select("id")
    .single();
  if (error) throw new Error(`createConversation: ${error.message}`);
  return (data as { id: string } | null) ?? null;
}

/** True iff this member owns the conversation (the owner check every reader/writer runs first). */
export async function ownsConversation(
  supabase: DbClient,
  owner: Owner,
  conversationId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId)
    .is("archived_at", null)
    .maybeSingle();
  return Boolean((data as { id: string } | null)?.id);
}

export async function appendMessage(
  supabase: DbClient,
  owner: Owner,
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  usage: MessageUsage = {}
): Promise<void> {
  const { error } = await supabase.from("chat_messages").insert({
    conversation_id: conversationId,
    team_id: owner.teamId,
    member_id: owner.memberId,
    role,
    content,
    cited_item_ids: usage.cited_item_ids ?? [],
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cost_usd: usage.cost_usd ?? 0,
  });
  if (error) throw new Error(`appendMessage: ${error.message}`);
  // Bump the conversation so the list sorts most-recent-first.
  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId);
}

/** The member's conversations, newest-active first, excluding archived. */
export async function listConversations(
  supabase: DbClient,
  owner: Owner,
  limit = 100
): Promise<Conversation[]> {
  const { data } = await supabase
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as Conversation[];
}

/** A conversation's full message thread — owner-checked; null if not owned/absent. */
export async function getConversation(
  supabase: DbClient,
  owner: Owner,
  conversationId: string
): Promise<{ id: string; title: string; messages: ChatMessage[] } | null> {
  const { data: convo } = await supabase
    .from("conversations")
    .select("id, title")
    .eq("id", conversationId)
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId)
    .is("archived_at", null)
    .maybeSingle();
  const c = convo as { id: string; title: string } | null;
  if (!c) return null;
  const { data: msgs } = await supabase
    .from("chat_messages")
    .select("id, role, content, cited_item_ids, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  return { id: c.id, title: c.title, messages: (msgs ?? []) as ChatMessage[] };
}

/**
 * The last `maxTurns` completed (user→assistant) turns of a conversation, for the LLM memory window.
 * Owner-checked. Call this BEFORE persisting the current user message so it returns only prior turns.
 */
export async function recentTurns(
  supabase: DbClient,
  owner: Owner,
  conversationId: string,
  maxTurns = 6
): Promise<ChatTurn[]> {
  if (!(await ownsConversation(supabase, owner, conversationId))) return [];
  const { data } = await supabase
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  const msgs = (data ?? []) as { role: "user" | "assistant"; content: string }[];
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
  supabase: DbClient,
  owner: Owner,
  conversationId: string,
  title: string
): Promise<boolean> {
  const { data, error } = await supabase
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

/** Soft-delete (archive) — hides it from the list; messages stay for any later restore/audit. */
export async function archiveConversation(
  supabase: DbClient,
  owner: Owner,
  conversationId: string
): Promise<boolean> {
  const { data, error } = await supabase
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
