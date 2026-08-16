"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Maximize2, Minimize2, Send, Sparkles } from "lucide-react";
import { Markdown } from "@/components/markdown";

type SourceChip = {
  id: string; // S1, S2…
  item_id: string | null;
  project: string;
  path: string;
  kind: string;
};

export type Exchange = {
  question: string;
  answer: string;
  sources: SourceChip[];
  status: "streaming" | "done" | "error";
  error?: string;
};

const DEFAULT_SUGGESTIONS = [
  "What is the team working on right now?",
  "What did we decide recently, and why?",
  "What has John been posting in Slack?",
  "What's blocking us?",
];

/**
 * Normal chat UI over the brain. Messages flow top→bottom (oldest first), the composer is pinned at
 * the bottom, Enter sends (Shift+Enter = newline), and the view autoscrolls as the answer streams.
 * `variant` controls height: "page" fills the viewport (the /query chat), "embed" is a compact panel
 * (the Home launcher). Answers stream from /api/dashboard/query (SSE) and cite their sources.
 */
/** Pair persisted user→assistant messages into the chat's Exchange shape (source chips not rehydrated). */
export function messagesToExchanges(messages: { role: string; content: string }[]): Exchange[] {
  const out: Exchange[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ question: m.content, answer: "", sources: [], status: "done" });
    else if (m.role === "assistant" && out.length) out[out.length - 1].answer = m.content;
  }
  return out;
}

/**
 * Poll a thread's in-flight run until it settles, feeding the partial answer to `onPartial`.
 * Returns the terminal state so the caller can render the finished answer or the failure.
 * Exported for testing; `signal` lets a remount cancel an in-flight poll loop.
 */
export async function pollRun(
  teamSlug: string,
  conversationId: string,
  onPartial: (text: string) => void,
  opts: {
    signal?: AbortSignal;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    maxPolls?: number;
  } = {}
): Promise<{ status: "done" | "error"; error: string | null; hasAnswer: boolean } | null> {
  const intervalMs = opts.intervalMs ?? 1200;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A HARD BOUND on the loop. The server ages a silent run out after ~3 minutes, so in practice this is
  // never reached — but "in practice" is not a termination argument: an endpoint that kept answering
  // `streaming` would spin here forever, and with a zero-delay sleep the loop yields only microtasks,
  // starving the event loop so completely that even a test timeout cannot fire (observed: it killed the
  // vitest worker rather than failing). ~10 minutes of polling, then give up.
  const maxPolls = opts.maxPolls ?? 500;
  // The run we started watching. The endpoint reports the thread's LATEST run, so if the user asks a
  // new question mid-poll the id changes underneath us — that new turn belongs to the live SSE reader,
  // not to this reattach, and adopting it would write one turn's text into another's bubble.
  let watchedId: string | null = null;
  for (let polls = 0; polls < maxPolls; polls++) {
    if (opts.signal?.aborted) return null;
    let body: {
      run?: { id?: string; status?: string; partial?: string; error?: string | null; final_message_id?: string | null } | null;
    };
    try {
      // Encode the id: it is a path SEGMENT, and an unencoded value carrying `/`, `?` or `..` would
      // silently address a different endpoint than the one this function claims to poll.
      const res = await fetch(
        `/api/dashboard/conversations/${encodeURIComponent(conversationId)}/run?team=${encodeURIComponent(teamSlug)}`,
        { signal: opts.signal }
      );
      if (!res.ok) return null;
      body = await res.json();
    } catch {
      return null; // aborted or offline — the caller keeps whatever it has
    }
    const run = body.run;
    if (!run) return null;
    const id = run.id ?? null;
    if (watchedId === null) watchedId = id;
    else if (id !== watchedId) return null; // a different turn took over — leave it alone
    if (run.status === "streaming") {
      if (run.partial) onPartial(run.partial);
      await sleep(intervalMs);
      continue;
    }
    // `hasAnswer` — NOT "did we ever observe streaming". A run that settled in the gap between the
    // caller fetching the thread and this first poll was never seen streaming, yet its answer is
    // exactly what the caller is missing; keying off "was it live while I watched" left the user
    // staring at their question with a permanently blank answer bubble.
    return {
      status: run.status === "error" ? "error" : "done",
      error: run.error ?? null,
      hasAnswer: run.status === "done" && Boolean(run.final_message_id),
    };
  }
  return null; // poll budget exhausted — stop rather than spin
}

export function QueryChat({
  teamSlug,
  initialQuestion,
  variant = "embed",
  suggestions = DEFAULT_SUGGESTIONS,
  initialConversationId = null,
  initialMessages,
  onConversationChange,
  persistKey,
}: {
  teamSlug: string;
  initialQuestion?: string;
  variant?: "page" | "embed";
  suggestions?: string[];
  /** Seed an existing thread (the sidebar remounts QueryChat with `key` when switching threads). */
  initialConversationId?: string | null;
  initialMessages?: Exchange[];
  /** Fires when this chat gets/changes its persistent thread id (so a list can refresh). */
  onConversationChange?: (id: string) => void;
  /** localStorage key: when set (e.g. the Home embed), remember the thread across remounts and
   *  reload it on mount, so navigating away and back doesn't lose the visible history. */
  persistKey?: string;
}) {
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>(initialMessages ?? []);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const askedInitial = useRef(false);
  const [expanded, setExpanded] = useState(false);
  // Persistent thread id — null until the server creates/returns one; sent on later turns so the
  // brain loads this conversation's history server-side (shared across sessions and interfaces).
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const restored = useRef(false);
  // The in-flight reattach poll, so starting a new turn can cancel it (otherwise the old run's
  // partial keeps arriving while the new turn streams, writing one turn's text under another).
  const reattachAbort = useRef<AbortController | null>(null);

  // Remember-the-thread (Home embed): on mount, reload the last thread from the server so navigating
  // away and back restores the visible history. The thread is already persisted server-side; we just
  // remember WHICH one in localStorage. Only when persistKey is set and we weren't seeded a thread.
  useEffect(() => {
    if (!persistKey || restored.current || initialConversationId) return;
    restored.current = true;
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(persistKey) : null;
    if (!saved) return;
    (async () => {
      try {
        const res = await fetch(`/api/dashboard/conversations/${saved}?team=${encodeURIComponent(teamSlug)}`);
        if (!res.ok) {
          window.localStorage.removeItem(persistKey); // thread deleted/renamed away — forget it
          return;
        }
        const convo = (await res.json()) as { id: string; messages?: { role: string; content: string }[] };
        const ex = messagesToExchanges(convo.messages ?? []);
        // Only hydrate if the user hasn't already started a new turn while this was loading.
        setExchanges((cur) => (cur.length === 0 && ex.length ? ex : cur));
        setConversationId((cur) => cur ?? convo.id);
      } catch {
        // ignore — start fresh
      }
    })();
  }, [persistKey, teamSlug, initialConversationId]);

  // Persist the thread id so a later remount can reload it.
  useEffect(() => {
    if (persistKey && conversationId && typeof window !== "undefined") {
      window.localStorage.setItem(persistKey, conversationId);
    }
  }, [persistKey, conversationId]);

  // REATTACH (QBGSTREAM-1): if this thread has a turn still running server-side — because the user
  // navigated away mid-answer and came back — resume showing it instead of a question with no answer.
  // The generation itself never stopped; only this component's view of it did.
  useEffect(() => {
    const convo = initialConversationId;
    if (!convo) return;
    const ctl = new AbortController();
    reattachAbort.current = ctl; // so `ask()` can stop this poll the moment a new turn starts
    (async () => {
      // The reattached turn is the trailing exchange that has NO answer yet — a rehydrated thread
      // renders it as `done` with an empty answer (there is no assistant message to pair with), which
      // is why "unanswered" and not `status === "streaming"` is the condition here.
      //
      // PATCH BY CAPTURED INDEX, not "the last exchange": if the user asks a NEW question while this
      // poll is still in flight, the last exchange is that new turn, and the old run's partial (or its
      // error) would land on the wrong bubble. `ask()` also aborts this poll, but the index makes the
      // patch correct even in the window before that takes effect.
      let targetIdx = -1;
      setExchanges((xs) => {
        targetIdx = xs.length - 1;
        return xs;
      });
      const patchTarget = (patch: Partial<Exchange>) =>
        setExchanges((xs) => {
          const i = targetIdx;
          if (i < 0 || i >= xs.length) return xs;
          if (xs[i].answer && xs[i].status !== "streaming") return xs;
          return xs.map((x, n) => (n === i ? { ...x, ...patch } : x));
        });
      const result = await pollRun(
        teamSlug,
        convo,
        (partial) => patchTarget({ answer: partial, status: "streaming" }),
        { signal: ctl.signal }
      );
      if (!result || ctl.signal.aborted) return;
      if (result.status === "error") {
        patchTarget({ status: "error", error: result.error ?? "The answer failed." });
        return;
      }
      // Ordinary thread open: the seeded messages already include the answer, so there is nothing to
      // reattach to. Checked against the RENDERED state rather than "was it streaming while I watched",
      // because a run that settled in the gap before the first poll is precisely the case where the
      // caller is missing the answer and must refetch.
      let needsAnswer = false;
      setExchanges((xs) => {
        needsAnswer = targetIdx >= 0 && targetIdx < xs.length && !xs[targetIdx].answer;
        return xs;
      });
      if (!needsAnswer || !result.hasAnswer) return;
      // The answer landed (possibly while we were away) — pull the durable copy from the thread.
      try {
        const res = await fetch(
          `/api/dashboard/conversations/${convo}?team=${encodeURIComponent(teamSlug)}`,
          { signal: ctl.signal }
        );
        if (!res.ok) return;
        const body = (await res.json()) as { messages?: { role: string; content: string }[] };
        const ex = messagesToExchanges(body.messages ?? []);
        if (ex.length) setExchanges(ex);
      } catch {
        // offline / aborted — keep what we have
      }
    })();
    return () => ctl.abort();
  }, [initialConversationId, teamSlug]);

  // Esc collapses the expanded (near-fullscreen) chat.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // Autoscroll to the newest content as the answer streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [exchanges]);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    // A new turn supersedes any reattach poll for this thread.
    reattachAbort.current?.abort();
    reattachAbort.current = null;
    setQuestion("");
    setBusy(true);

    const idx = exchanges.length;
    setExchanges((xs) => [...xs, { question: text, answer: "", sources: [], status: "streaming" }]);
    const patch = (p: Partial<Exchange>) =>
      setExchanges((xs) => xs.map((x, i) => (i === idx ? { ...x, ...p } : x)));

    try {
      const res = await fetch("/api/dashboard/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: text,
          team: teamSlug,
          // Browser timezone so "today"/"this week" resolve in the user's local time, not server UTC.
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(conversationId ? { conversation_id: conversationId } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        let message = `Query failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body.error?.message) message = body.error.message;
        } catch {
          // non-JSON error body
        }
        patch({ status: "error", error: message });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let answer = "";

      const handle = (event: string, data: string) => {
        try {
          const payload = JSON.parse(data) as Record<string, unknown>;
          if (event === "conversation") {
            const id = String(payload.id ?? "");
            if (id) {
              setConversationId(id);
              onConversationChange?.(id);
            }
          } else if (event === "delta") {
            answer += String(payload.text ?? "");
            patch({ answer });
          } else if (event === "sources") {
            patch({ sources: (payload.sources as SourceChip[]) ?? [] });
          } else if (event === "done") {
            patch({ status: "done" });
          } else if (event === "error") {
            patch({ status: "error", error: String(payload.message ?? "query failed") });
          }
        } catch {
          // malformed frame — skip
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) handle(event, data);
        }
      }
      setExchanges((xs) =>
        xs.map((x, i) => (i === idx && x.status === "streaming" ? { ...x, status: "done" } : x))
      );
    } catch (err) {
      patch({ status: "error", error: err instanceof Error ? err.message : "network error" });
    } finally {
      setBusy(false);
    }
  }

  // Auto-ask a deep-linked question (e.g. from the Home launcher → /query?q=…), once.
  useEffect(() => {
    if (initialQuestion && !askedInitial.current) {
      askedInitial.current = true;
      void ask(initialQuestion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  const height = variant === "page" ? "h-[calc(100dvh-11rem)]" : "h-[26rem]";
  // Expanded = a focused near-fullscreen overlay so long conversations are readable.
  const panelClass = expanded
    ? "fixed inset-3 z-50 mx-auto flex max-w-5xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-inset shadow-2xl sm:inset-6"
    : `flex ${height} flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-inset`;

  return (
    <>
      {expanded ? (
        <div
          className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
          aria-hidden
        />
      ) : null}
      <div className={panelClass}>
      {/* Slim chrome bar with the expand / collapse control. */}
      <div className="flex items-center justify-end border-b border-border-subtle px-2 py-1">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="rounded-md p-1 text-ink-tertiary transition-colors hover:bg-surface-raised hover:text-ink"
          aria-label={expanded ? "Collapse chat" : "Expand chat"}
          title={expanded ? "Collapse (Esc)" : "Expand"}
        >
          {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      </div>
      {/* Messages (oldest → newest); scrolls; composer is pinned below. */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        {exchanges.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <Sparkles className="size-6 text-violet" />
            <p className="max-w-sm text-sm text-ink-secondary">
              Ask anything about your team — Slack, decisions, tasks, code, and the knowledge graph.
              Answers cite their sources. Type <span className="font-mono text-violet">/sync</span> to
              pull the latest from your connectors.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="rounded-full border border-violet/25 bg-violet/5 px-3 py-1 text-xs text-violet transition-colors hover:bg-violet/12"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {exchanges.map((x, i) => (
              <div key={i} className="flex flex-col gap-2">
                <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-violet/10 px-4 py-2.5 text-sm text-ink">
                  {x.question}
                </div>
                <div className="mr-auto max-w-full rounded-2xl rounded-bl-sm bg-surface-card px-4 py-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gradient-prism">
                    <Sparkles className="size-3 text-violet" /> Team Brain
                  </p>
                  {x.answer ? (
                    <Markdown>{x.answer}</Markdown>
                  ) : x.status === "streaming" ? (
                    <p className="flex items-center gap-2 text-sm text-ink-tertiary">
                      <Loader2 className="size-3.5 animate-spin" /> retrieving and thinking…
                    </p>
                  ) : null}
                  {x.status === "error" ? (
                    <p className="mt-2 rounded-lg border border-red/30 bg-red/5 px-3 py-2 text-sm text-red">
                      {x.error}
                    </p>
                  ) : null}
                  {x.sources.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-border-subtle pt-3">
                      {x.sources.map((s) =>
                        s.item_id ? (
                          <Link
                            key={s.id}
                            href={`/t/${teamSlug}/library/${s.item_id}`}
                            className="inline-flex items-center gap-1.5 rounded-full border border-violet/25 bg-violet/8 px-2.5 py-1 font-mono text-[11px] text-violet transition-colors hover:bg-violet/15"
                            title={`${s.project}/${s.path}`}
                          >
                            <span className="font-semibold">{s.id}</span>
                            <span className="max-w-48 truncate">{s.path.split("/").pop()}</span>
                          </Link>
                        ) : (
                          <span
                            key={s.id}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border-default px-2.5 py-1 font-mono text-[11px] text-ink-tertiary"
                          >
                            {s.id}
                          </span>
                        )
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Composer — pinned at the bottom (normal chat). Enter sends; Shift+Enter = newline. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className="flex items-end gap-2 border-t border-border-subtle bg-surface-base/40 px-3 py-3"
      >
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(question);
            }
          }}
          rows={variant === "page" ? 4 : 1}
          placeholder="Ask the brain…  (or /sync to pull latest · Enter to send, Shift+Enter for newline)"
          className={`w-full resize-none rounded-xl border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-tertiary focus:border-violet/50 ${
            variant === "page" ? "min-h-[7rem] max-h-72" : "min-h-[2.5rem] max-h-40"
          }`}
        />
        <button
          type="submit"
          disabled={busy || !question.trim()}
          className="btn-prism shrink-0"
          aria-label="Send"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </form>
      </div>
    </>
  );
}
