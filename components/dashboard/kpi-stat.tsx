import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { Kpi, KpiAccent } from "@/lib/metrics/pulse";

const ACCENT_TEXT: Record<KpiAccent, string> = {
  violet: "text-violet",
  blue: "text-blue",
  cyan: "text-cyan",
  amber: "text-amber",
  emerald: "text-emerald",
};

/** Inline sparkline. Inherits color from the parent via currentColor. */
function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const w = 64;
  const h = 20;
  const step = w / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.85}
      />
    </svg>
  );
}

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
