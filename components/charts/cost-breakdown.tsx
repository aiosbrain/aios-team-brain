"use client";

import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CostSlice } from "@/lib/metrics/llm-costs";
import { AXIS_TICK, PRISM, TOOLTIP_STYLE } from "./palette";
import { ChartCard } from "./chart-card";

// Deterministic color per bar (stable by index — the slices arrive sorted by cost desc).
const CYCLE = [
  PRISM.violet,
  PRISM.accent,
  PRISM.cyan,
  PRISM.emerald,
  PRISM.amber,
  PRISM.fuchsia,
  PRISM.red,
];

function usd(n: number): string {
  // Sub-cent totals still deserve a real number, not $0.00 — show more precision when tiny.
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Horizontal bar chart of cost by slice (source / model / provider) — "what is actually costing
 * what". Bars are labelled and sorted by cost desc; the tooltip shows exact $ + call count.
 */
export function CostBreakdownChart({
  title,
  hint,
  help,
  data,
  empty,
}: {
  title: string;
  hint?: string;
  help?: React.ReactNode;
  data: CostSlice[];
  empty?: boolean;
}) {
  // Height scales with the number of bars so labels never crush together.
  const height = Math.max(140, data.length * 34 + 16);

  return (
    <ChartCard
      title={title}
      hint={hint}
      help={help}
      empty={empty}
      emptyLabel="No spend in this window."
    >
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
          barCategoryGap={8}
        >
          <XAxis
            type="number"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => usd(Number(v))}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={132}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{
              fill: "color-mix(in srgb, var(--aios-violet) 6%, transparent)",
            }}
            formatter={(value, _name, entry) => {
              const p = entry?.payload as CostSlice | undefined;
              const calls = p
                ? ` · ${p.calls} call${p.calls === 1 ? "" : "s"}`
                : "";
              const est = p?.estimated ? " · estimated" : "";
              // Billed attempts that returned nothing to price. Shown HERE, next to the feature that
              // made them, because "which feature lost the money" is the entire point of recording
              // them — a total with no attribution is the anonymous remainder this replaced. A
              // failure-only feature renders as a $0 bar, which without this reads as an unexplained
              // empty row.
              const failed =
                p && p.failed_attempts > 0
                  ? ` · ${p.failed_attempts} failed attempt${p.failed_attempts === 1 ? "" : "s"}`
                  : "";
              return [`${usd(Number(value))}${calls}${est}${failed}`, "cost"];
            }}
          />
          <Bar dataKey="cost_usd" radius={[0, 4, 4, 0]} maxBarSize={26}>
            {data.map((d, i) => (
              <Cell key={d.key} fill={CYCLE[i % CYCLE.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
