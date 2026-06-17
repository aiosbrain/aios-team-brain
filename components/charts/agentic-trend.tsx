"use client";

import {
  Line,
  LineChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TrendPoint } from "@/lib/metrics/codebases";
import { AXIS_TICK, GRID_STROKE, PRISM, TOOLTIP_STYLE } from "./palette";
import { ChartCard } from "./chart-card";

const SERIES: { key: keyof TrendPoint; name: string; color: string }[] = [
  { key: "agentic", name: "Agentic", color: PRISM.violet },
  { key: "coverage", name: "Coverage", color: PRISM.cyan },
  { key: "ai", name: "AI commits", color: PRISM.blue },
];

export function AgenticTrend({ data }: { data: TrendPoint[] }) {
  return (
    <ChartCard title="Trend" hint="scores over time" empty={data.length < 2}>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={28} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={32} domain={[0, 100]} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          {SERIES.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={1.75}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
