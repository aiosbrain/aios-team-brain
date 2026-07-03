"use client";

import { useEffect, useState } from "react";
import { Users, CheckCircle2 } from "lucide-react";

interface PersonWork {
  memberId: string;
  name: string;
  handle: string;
  summary: string;
  threads: string[];
  openTasks: { id: string; title: string; status: string }[];
  accomplished: { id: string; title: string; at: string }[];
}

const STATUS_DOT: Record<string, string> = {
  blocked: "bg-red",
  in_progress: "bg-violet",
  ready: "bg-cyan",
};

/**
 * Consolidated "Working On" — one card, one entry per person (deduped, roster-keyed). Each person
 * shows a summary from the Learning layer's narrative arcs, their open tasks, and a running list of
 * what they've accomplished. Client-fetched from /api/dashboard/team-work so the LLM arc synthesis
 * never blocks the home page render.
 */
export function WorkingOn({ teamSlug }: { teamSlug: string }) {
  const [people, setPeople] = useState<PersonWork[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/dashboard/team-work?team=${encodeURIComponent(teamSlug)}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { people: PersonWork[] };
        if (live) setPeople(data.people ?? []);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [teamSlug]);

  return (
    <section className="prism-card px-5 py-4">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
        <Users className="size-3.5 text-violet" /> Working on
      </h2>

      {people === null && !failed ? (
        <p className="text-sm text-ink-tertiary">Loading team activity…</p>
      ) : failed ? (
        <p className="text-sm text-ink-tertiary">Couldn&apos;t load team activity right now.</p>
      ) : people && people.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No recent team activity to summarize yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {(people ?? []).map((p) => (
            <PersonCard key={p.memberId} person={p} />
          ))}
        </div>
      )}
    </section>
  );
}

function PersonCard({ person }: { person: PersonWork }) {
  const { name, summary, threads, openTasks, accomplished } = person;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-inset px-4 py-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-ink">{name}</p>
        {summary ? (
          <p className="text-sm text-ink-secondary">{summary}</p>
        ) : (
          <p className="text-sm text-ink-tertiary">No narrative summary yet.</p>
        )}
        {threads.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {threads.map((t) => (
              <span
                key={t}
                className="rounded-full bg-violet/8 px-2 py-0.5 text-[11px] font-medium text-violet"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {openTasks.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Open tasks</p>
          <ul className="flex flex-col gap-1">
            {openTasks.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-xs text-ink-secondary">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[t.status] ?? "bg-ink-tertiary"}`}
                  title={t.status.replace("_", " ")}
                />
                <span className="truncate">{t.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {accomplished.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Accomplished</p>
          <ul className="flex flex-col gap-1">
            {accomplished.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-xs text-ink-secondary">
                <CheckCircle2 className="size-3 shrink-0 text-emerald" />
                <span className="truncate">{t.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
