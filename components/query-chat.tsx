"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Send, Sparkles } from "lucide-react";
import { Markdown } from "@/components/markdown";

type SourceChip = {
  id: string; // S1, S2…
  item_id: string | null;
  project: string;
  path: string;
  kind: string;
};

type Exchange = {
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
export function QueryChat({
  teamSlug,
  initialQuestion,
  variant = "embed",
  suggestions = DEFAULT_SUGGESTIONS,
}: {
  teamSlug: string;
  initialQuestion?: string;
  variant?: "page" | "embed";
  suggestions?: string[];
}) {
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const askedInitial = useRef(false);

  // Autoscroll to the newest content as the answer streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [exchanges]);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || busy) return;
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
        body: JSON.stringify({ question: text, team: teamSlug }),
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
          if (event === "delta") {
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

  return (
    <div className={`flex ${height} flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-inset`}>
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
          rows={1}
          placeholder="Ask the brain…  (or /sync to pull latest · Enter to send, Shift+Enter for newline)"
          className="max-h-40 min-h-[2.5rem] w-full resize-none rounded-xl border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-tertiary focus:border-violet/50"
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
  );
}
