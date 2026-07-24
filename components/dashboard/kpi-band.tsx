import type { Kpi } from "@/lib/metrics/pulse";
import { KpiStat } from "./kpi-stat";

export function KpiBand({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {kpis.map((kpi) => (
        <KpiStat key={kpi.key} kpi={kpi} />
      ))}
    </div>
  );
}
