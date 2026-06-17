import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { Kpi, KpiAccent } from "@/lib/metrics/pulse";
import { Sparkline } from "@/components/sparkline";

const ACCENT_TEXT: Record<KpiAccent, string> = {
  violet: "text-violet",
  blue: "text-blue",
  cyan: "text-cyan",
  amber: "text-amber",
  emerald: "text-emerald",
};

export function KpiStat({ kpi }: { kpi: Kpi }) {
  const accent = ACCENT_TEXT[kpi.accent];
  return (
    <div className="prism-card prism-card-hover flex flex-col gap-2 px-4 py-3.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
        {kpi.label}
      </p>
      <div className="flex items-end justify-between gap-2">
        <span className="font-display text-2xl font-semibold leading-none text-ink">
          {kpi.value}
        </span>
        <span className={accent}>
          <Sparkline data={kpi.spark} />
        </span>
      </div>
      <div className="flex items-center gap-2 text-[11px]">
        {kpi.delta !== null ? (
          <span className="inline-flex items-center gap-0.5 text-ink-secondary">
            {kpi.delta >= 0 ? (
              <ArrowUpRight className="size-3" />
            ) : (
              <ArrowDownRight className="size-3" />
            )}
            {Math.abs(kpi.delta)}%
          </span>
        ) : null}
        {kpi.hint ? <span className="text-ink-tertiary">{kpi.hint}</span> : null}
      </div>
    </div>
  );
}
