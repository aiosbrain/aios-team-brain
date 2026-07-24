import Link from "next/link";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { Kpi, KpiAccent } from "@/lib/metrics/pulse";
import { Sparkline } from "@/components/sparkline";
import { HelpHint } from "@/components/help-hint";

const ACCENT_TEXT: Record<KpiAccent, string> = {
  violet: "text-violet",
  blue: "text-blue",
  cyan: "text-cyan",
  amber: "text-amber",
  emerald: "text-emerald",
};

export function KpiStat({ kpi, helpAlign = "left" }: { kpi: Kpi; helpAlign?: "left" | "right" }) {
  const accent = ACCENT_TEXT[kpi.accent];

  // The content sits ABOVE a full-card link overlay (when href is set) but is pointer-events-none so
  // clicks fall through to the overlay — except the help "?" (pointer-events-auto), which stays its
  // own click target. This "stretched link" pattern keeps the whole card clickable without nesting a
  // <button> inside an <a> (invalid HTML).
  const body = (
    <div className={`flex flex-col gap-2 ${kpi.href ? "pointer-events-none relative z-[1]" : ""}`}>
      <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
        {kpi.label}
        {kpi.help ? (
          <span className={kpi.href ? "pointer-events-auto" : undefined}>
            <HelpHint label={`About ${kpi.label}`} align={helpAlign}>
              {kpi.help}
            </HelpHint>
          </span>
        ) : null}
      </p>
      <div className="flex items-end justify-between gap-2">
        <span className="font-display text-2xl leading-none text-ink">{kpi.value}</span>
        <span className={accent}>
          <Sparkline data={kpi.spark} />
        </span>
      </div>
      <div className="flex items-center gap-2 text-[11px]">
        {kpi.delta !== null ? (
          <span className="inline-flex items-center gap-0.5 text-ink-secondary">
            {kpi.delta >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
            {Math.abs(kpi.delta)}%
          </span>
        ) : null}
        {kpi.hint ? <span className="text-ink-tertiary">{kpi.hint}</span> : null}
      </div>
    </div>
  );

  if (kpi.href) {
    return (
      <div className="prism-card prism-card-hover relative flex flex-col px-4 py-3.5">
        <Link
          href={kpi.href}
          aria-label={`${kpi.label} — view cost breakdown`}
          className="absolute inset-0 z-0 rounded-[inherit] focus:outline-none focus-visible:ring-1 focus-visible:ring-violet/40"
        />
        {body}
      </div>
    );
  }

  return <div className="prism-card prism-card-hover flex flex-col px-4 py-3.5">{body}</div>;
}
