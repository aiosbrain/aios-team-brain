"use client";

import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import type { PersonDay } from "@/lib/dashboard/timeline-group";
import { PersonWorkCard } from "@/components/dashboard/person-work-card";

/**
 * Consolidated "Working On" — one card per person showing what they were MOST RECENTLY working on.
 * Fetches `/api/dashboard/team-work`, which collapses the SAME work-timeline the Learning → Timeline
 * panel renders to each person's most recent day — so the two surfaces are IDENTICAL (shared
 * `PersonWorkCard`). Client-fetched so a cold-cache rebuild never blocks the home page render.
 */
export function WorkingOn({ teamSlug }: { teamSlug: string }) {
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
        <p className="text-sm text-ink-tertiary">No recent team activity to show yet.</p>
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
