"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Loader2, Trash2, Pencil } from "lucide-react";
import { QueryChat, type Exchange } from "@/components/query-chat";

interface ConversationListItem {
  id: string;
  title: string;
  updated_at: string;
}

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}

interface Seed {
  key: string; // remount key — changes ONLY on explicit open/new (never mid-stream)
  conversationId: string | null;
  messages: Exchange[];
}

/** Pair persisted user→assistant messages into the chat's Exchange shape (source chips not rehydrated). */
function toExchanges(messages: StoredMessage[]): Exchange[] {
  const out: Exchange[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ question: m.content, answer: "", sources: [], status: "done" });
    else if (m.role === "assistant" && out.length) out[out.length - 1].answer = m.content;
  }
  return out;
}

/**
 * The /query chat workspace: a sidebar of the member's saved conversations + the live QueryChat.
 * Threads persist server-side, so this list is shared across sessions/devices. Opening a thread
 * remounts QueryChat (via `seed.key`) seeded with its history; a new turn's thread id arrives via
 * `onConversationChange` and only refreshes the list/highlight — it never remounts mid-stream.
 */
export function ChatWorkspace({ teamSlug, initialQuestion }: { teamSlug: string; initialQuestion?: string }) {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const newNonce = useRef(0);
  const [seed, setSeed] = useState<Seed>({ key: "new-0", conversationId: null, messages: [] });

  const loadList = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/conversations?team=${encodeURIComponent(teamSlug)}`);
      if (!res.ok) return;
      const body = (await res.json()) as { conversations?: ConversationListItem[] };
      setConversations(body.conversations ?? []);
    } catch {
      // non-fatal — the list just stays as-is
    }
  }, [teamSlug]);

  useEffect(() => {
    // Fetch-on-mount: setState happens only after the async fetch resolves, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadList();
  }, [loadList]);

  async function openConversation(id: string) {
    setLoadingId(id);
    try {
      const res = await fetch(`/api/dashboard/conversations/${id}?team=${encodeURIComponent(teamSlug)}`);
      if (!res.ok) return;
      const convo = (await res.json()) as { id: string; messages: StoredMessage[] };
      setSeed({ key: id, conversationId: id, messages: toExchanges(convo.messages) });
      setActiveId(id);
    } finally {
      setLoadingId(null);
    }
  }

  function newChat() {
    newNonce.current += 1;
    setSeed({ key: `new-${newNonce.current}`, conversationId: null, messages: [] });
    setActiveId(null);
  }

  async function deleteConversation(id: string) {
    await fetch(`/api/dashboard/conversations/${id}?team=${encodeURIComponent(teamSlug)}`, { method: "DELETE" });
    if (activeId === id || seed.conversationId === id) newChat();
    void loadList();
  }

  async function renameConversation(id: string, current: string) {
    const title = window.prompt("Rename conversation", current)?.trim();
    if (!title || title === current) return;
    await fetch(`/api/dashboard/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: teamSlug, title }),
    });
    void loadList();
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[230px_1fr]">
      <aside className="flex flex-col gap-2 md:max-h-[calc(100dvh-11rem)]">
        <button
          type="button"
          onClick={newChat}
          className="flex items-center justify-center gap-2 rounded-xl border border-violet/30 bg-violet/5 px-3 py-2 text-sm font-medium text-violet transition-colors hover:bg-violet/12"
        >
          <MessageSquarePlus className="size-4" /> New chat
        </button>
        <div className="flex flex-col gap-0.5 overflow-y-auto">
          {conversations.length === 0 ? (
            <p className="px-2 py-3 text-xs text-ink-tertiary">No saved chats yet.</p>
          ) : (
            conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <div
                  key={c.id}
                  className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm transition-colors ${
                    active ? "bg-violet/10 text-violet" : "text-ink-secondary hover:bg-surface-raised"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => openConversation(c.id)}
                    className="min-w-0 flex-1 truncate text-left"
                    title={c.title}
                  >
                    {loadingId === c.id ? (
                      <Loader2 className="inline size-3.5 animate-spin" />
                    ) : (
                      c.title || "Untitled"
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => renameConversation(c.id, c.title)}
                    className="shrink-0 rounded p-1 text-ink-tertiary opacity-0 transition hover:text-ink group-hover:opacity-100"
                    aria-label="Rename"
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteConversation(c.id)}
                    className="shrink-0 rounded p-1 text-ink-tertiary opacity-0 transition hover:text-red group-hover:opacity-100"
                    aria-label="Delete"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <QueryChat
        key={seed.key}
        teamSlug={teamSlug}
        variant="page"
        initialConversationId={seed.conversationId}
        initialMessages={seed.messages}
        initialQuestion={seed.key === "new-0" ? initialQuestion : undefined}
        onConversationChange={(id) => {
          setActiveId(id);
          void loadList();
        }}
      />
    </div>
  );
}
