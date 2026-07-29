"use client";

import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import type { PersonDay } from "@/lib/dashboard/timeline-group";
import { PersonWorkCard } from "@/components/dashboard/person-work-card";
import { digest, DIGEST_PEOPLE_LIMIT } from "@/lib/dashboard/pulse-digest";

/**
 * Consolidated "Working On" — one entry per person showing what they were MOST RECENTLY working on.
 * Fetches `/api/dashboard/team-work`, which collapses the SAME work-timeline the Pulse Timeline
 * disclosure renders to each person's most recent day — so the two surfaces are IDENTICAL (shared
 * `PersonWorkCard`). Client-fetched so a cold-cache rebuild never blocks the home page render.
 *
 * `variant="roster"` is the Pulse snapshot density: compact rows capped at `DIGEST_PEOPLE_LIMIT`, so a
 * growing team can't push the fold down. The full cards remain the Timeline's rendering.
 */
export function WorkingOn({
  teamSlug,
  variant = "cards",
  timelineHref,
}: {
  teamSlug: string;
  variant?: "cards" | "roster";
  timelineHref?: string;
}) {
  const [people, setPeople] = useState<PersonDay[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/dashboard/team-work?team=${encodeURIComponent(teamSlug)}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { people: PersonDay[] };
        if (live) setPeople(data.people ?? []);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [teamSlug]);

  const isRoster = variant === "roster";
  const view = isRoster ? digest(people ?? [], DIGEST_PEOPLE_LIMIT) : null;

  return (
    <section className="prism-card flex flex-col px-5 py-4">
      <h2 className="mb-3 flex flex-wrap items-center gap-x-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
        <span className="flex items-center gap-2">
          <Users className="size-3.5 text-violet" /> Working on
        </span>
        {/* The band only ever covers each person's MOST RECENT day. Saying so matters: unlabelled, a
            roster of 2 out of 9 members reads as "the team is idle" rather than "2 people have activity
            in this window" — a wrong impression the compact density would only sharpen. */}
        {isRoster ? (
          <span className="font-normal normal-case tracking-normal text-ink-tertiary/70">· most recent activity</span>
        ) : null}
      </h2>

      {people === null && !failed ? (
        <p className="text-sm text-ink-tertiary">Loading team activity…</p>
      ) : failed ? (
        <p className="text-sm text-ink-tertiary">Couldn&apos;t load team activity right now.</p>
      ) : people && people.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No recent team activity to show yet.</p>
      ) : view ? (
        <div className="flex flex-col gap-2">
          {view.shown.map((p) => (
            <PersonWorkCard key={p.memberId} person={p} variant="row" />
          ))}
          {view.hidden > 0 ? (
            <p className="text-[11px] text-ink-tertiary">+{view.hidden} more with recent activity</p>
          ) : null}
          {timelineHref ? (
            <a href={timelineHref} className="mt-1 w-fit text-xs font-medium text-violet hover:underline">
              Full timeline →
            </a>
          ) : null}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {(people ?? []).map((p) => (
            <PersonWorkCard key={p.memberId} person={p} />
          ))}
        </div>
      )}
    </section>
  );
}
