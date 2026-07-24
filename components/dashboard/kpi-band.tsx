import type { Kpi } from "@/lib/metrics/pulse";
import { KpiStat } from "./kpi-stat";

export function KpiBand({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {kpis.map((kpi, i) => (
        // The last card sits against the right edge of the band — align its help popover right so it
        // can't overflow the viewport (single column on mobile, so only matters from sm: up).
        <KpiStat key={kpi.key} kpi={kpi} helpAlign={i === kpis.length - 1 ? "right" : "left"} />
      ))}
    </div>
  );
}
