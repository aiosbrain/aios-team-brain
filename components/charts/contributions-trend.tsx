"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CommitVolumePoint } from "@/lib/metrics/codebases";
import { AXIS_TICK, GRID_STROKE, PRISM, TOOLTIP_STYLE } from "./palette";
import { ChartCard } from "./chart-card";

/** Commit volume per day, AI-assisted vs human, stacked. */
export function ContributionsTrend({ data }: { data: CommitVolumePoint[] }) {
  return (
    <ChartCard title="Commit volume" hint="AI-assisted vs human / day" empty={data.length === 0}>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={20} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Bar dataKey="ai" name="AI-assisted" stackId="c" fill={PRISM.violet} radius={[0, 0, 0, 0]} />
          <Bar dataKey="human" name="Human" stackId="c" fill={PRISM.cyan} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
