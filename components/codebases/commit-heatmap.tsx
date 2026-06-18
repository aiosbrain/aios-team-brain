import type { ContributorDay } from "@/lib/metrics/codebases";

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function bucket(c: number): string {
  if (c <= 0) return "bg-surface-inset";
  if (c <= 2) return "bg-violet/30";
  if (c <= 5) return "bg-violet/60";
  return "bg-violet";
}

/**
 * GitHub-style commit calendar from per-day contribution rows. Pure render (no client
 * JS) — weeks are columns, weekdays are rows, cells coloured by commit count.
 */
export function CommitHeatmap({ days }: { days: ContributorDay[] }) {
  if (days.length === 0) {
    return <p className="text-sm text-ink-tertiary">No commits in this window.</p>;
  }
  const counts = new Map(days.map((d) => [d.day, d.commits]));

  const [y, m, d] = days[0].day.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  start.setDate(start.getDate() - start.getDay()); // back to Sunday
  const today = new Date();

  const weeks: { date: string; commits: number }[][] = [];
  const cur = new Date(start);
  while (cur <= today && weeks.length < 53) {
    const week: { date: string; commits: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const iso = fmt(cur);
      week.push({ date: iso, commits: counts.get(iso) ?? 0 });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  return (
    <div className="flex gap-[3px] overflow-x-auto pb-1">
      {weeks.map((week, wi) => (
        <div key={wi} className="flex flex-col gap-[3px]">
          {week.map((cell) => (
            <span
              key={cell.date}
              title={`${cell.date}: ${cell.commits} commit${cell.commits === 1 ? "" : "s"}`}
              className={`size-3 rounded-[2px] ${bucket(cell.commits)}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
