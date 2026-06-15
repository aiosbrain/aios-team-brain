"use client";

import { useImperativeHandle, useState, type Ref } from "react";
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

/** Imperative handle so parents (e.g. suggestion chips) can fire a query. */
export type QueryChatHandle = { ask: (question: string) => void };

export function QueryChat({
  teamSlug,
  initialQuestion,
  ref,
}: {
  teamSlug: string;
  initialQuestion?: string;
  ref?: Ref<QueryChatHandle>;
}) {
  const [question, setQuestion] = useState(initialQuestion ?? "");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);

  async function ask(e?: React.FormEvent, override?: string) {
    e?.preventDefault();
    const q = (override ?? question).trim();
    if (!q || busy) return;
    setQuestion("");
    setBusy(true);

    const idx = exchanges.length;
    setExchanges((xs) => [...xs, { question: q, answer: "", sources: [], status: "streaming" }]);
    const patch = (p: Partial<Exchange>) =>
      setExchanges((xs) => xs.map((x, i) => (i === idx ? { ...x, ...p } : x)));

    try {
      const res = await fetch("/api/dashboard/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, team: teamSlug }),
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

      // Parse the SSE stream
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
      // if the stream ended without a done/error event, settle it
      setExchanges((xs) =>
        xs.map((x, i) => (i === idx && x.status === "streaming" ? { ...x, status: "done" } : x))
      );
    } catch (err) {
      patch({
        status: "error",
        error: err instanceof Error ? err.message : "network error",
      });
    } finally {
      setBusy(false);
    }
  }

  useImperativeHandle(ref, () => ({
    ask: (q: string) => {
      setQuestion(q);
      void ask(undefined, q);
    },
  }));

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={ask} className="prism-card flex flex-col gap-3 bg-surface-inset px-4 py-4">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask(e);
          }}
          rows={3}
          placeholder="What did we decide about…? Who owns…? What changed since…?"
          className="w-full resize-y bg-transparent text-sm text-ink outline-none placeholder:text-ink-tertiary"
        />
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-ink-tertiary">⌘↵ to send · answers cite synced sources</p>
          <button type="submit" disabled={busy || !question.trim()} className="btn-prism">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Ask the brain
          </button>
        </div>
      </form>

      {exchanges
        .map((x, i) => ({ x, i }))
        .reverse()
        .map(({ x, i }) => (
          <div key={i} className="flex flex-col gap-3">
            <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-violet/10 px-4 py-2.5 text-sm text-ink">
              {x.question}
            </div>
            <div className="prism-card max-w-full bg-surface-inset px-5 py-4">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gradient-prism">
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
  );
}
