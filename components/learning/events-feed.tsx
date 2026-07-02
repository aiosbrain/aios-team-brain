"use client";

import { useEffect, useState } from "react";
import { Loader2, ChevronRight } from "lucide-react";

interface GraphEvent {
  id: string;
  itemId: string | null;
  source: string;
  title: string;
  at: string;
  participants: string[];
  facts: string[];
  factCount: number;
}

const SOURCE_ICON: Record<string, string> = {
  slack: "💬",
  granola: "🎙",
  transcript: "🎙",
  notion: "📋",
  gdrive: "📄",
  confluence: "📄",
  web: "🌐",
  github: "🔧",
  linear: "📐",
  plane: "📐",
  git: "🔧",
};

// 5 brand-ish avatar colors chosen from a name hash.
const AVATAR_BG = ["bg-violet", "bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500"];

function avatarFor(name: string): { initials: string; cls: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase() || "?";
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { initials, cls: AVATAR_BG[h % AVATAR_BG.length] };
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

type Status = "loading" | "ready" | "error";

/** Layer 2 — recent events, each expandable to the facts extracted from it. */
export function EventsFeed({ teamSlug }: { teamSlug: string }) {
  const [events, setEvents] = useState<GraphEvent[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/brain/events?team=${encodeURIComponent(teamSlug)}`);
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { events?: GraphEvent[] };
        if (alive) {
          setEvents(data.events ?? []);
          setStatus("ready");
        }
      } catch {
        if (alive) setStatus("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [teamSlug]);

  if (status === "loading") {
    return (
      <p className="flex items-center gap-2 px-1 py-6 text-sm text-ink-tertiary">
        <Loader2 className="size-4 animate-spin" /> loading events…
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="rounded-lg border border-border-subtle px-4 py-3 text-sm text-ink-tertiary">
        Couldn&apos;t load events right now.
      </p>
    );
  }
  if (events.length === 0) {
    return (
      <p className="rounded-lg border border-border-subtle px-4 py-6 text-center text-sm text-ink-tertiary">
        No events in the window yet — they appear as the brain ingests and extracts from your activity.
      </p>
    );
  }

  return (
    <div className="prism-card divide-y divide-border-subtle">
      {events.map((ev) => {
        const isOpen = open[ev.id];
        return (
          <div key={ev.id} className="px-4 py-3">
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [ev.id]: !o[ev.id] }))}
              className="flex w-full items-start gap-3 text-left"
            >
              <span className="mt-0.5 text-base leading-none">{SOURCE_ICON[ev.source] ?? "📌"}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{ev.title}</p>
                <p className="mt-0.5 text-[11px] text-ink-tertiary">
                  {relTime(ev.at)} · {ev.factCount} fact{ev.factCount === 1 ? "" : "s"}
                </p>
              </div>
              {ev.participants.length ? (
                <div className="flex shrink-0 items-center">
                  {ev.participants.slice(0, 4).map((p, i) => {
                    const a = avatarFor(p);
                    return (
                      <span
                        key={p}
                        title={p}
                        style={{ marginLeft: i === 0 ? 0 : -5 }}
                        className={`flex size-6 items-center justify-center rounded-full border-2 border-surface-card text-[9px] font-semibold text-white ${a.cls}`}
                      >
                        {a.initials}
                      </span>
                    );
                  })}
                </div>
              ) : null}
              <ChevronRight
                className={`mt-0.5 size-4 shrink-0 text-ink-tertiary transition-transform ${isOpen ? "rotate-90" : ""}`}
              />
            </button>

            {isOpen && ev.facts.length ? (
              <ul className="mt-2 flex flex-col gap-1 pl-9">
                {ev.facts.map((f, i) => (
                  <li key={i} className="text-[13px] text-ink-secondary">
                    • {f}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
