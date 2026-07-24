import type { Kpi } from "@/lib/metrics/pulse";
import { KpiStat } from "./kpi-stat";

export function KpiBand({ kpis, teamSlug }: { kpis: Kpi[]; teamSlug?: string }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {kpis.map((kpi, i) => (
        // The Spend card drills into the full cost breakdown ("what's costing what") when a teamSlug is
        // provided (the Pulse band). The last card sits against the right edge — align its help popover
        // right so it can't overflow the viewport (single column on mobile, so only matters from sm: up).
        <KpiStat
          key={kpi.key}
          kpi={teamSlug && kpi.key === "spend" ? { ...kpi, href: `/t/${teamSlug}/costs` } : kpi}
          helpAlign={i === kpis.length - 1 ? "right" : "left"}
        />
      ))}
    </div>
  );
}
