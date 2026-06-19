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
import { AXIS_TICK, GRID_STROKE, PRISM, TOOLTIP_STYLE } from "./palette";
import { ChartCard } from "./chart-card";

export type TimelinePoint = { date: string; overall: number };

/** Overall AEM score (0–4) over time — shows progression as the loop re-assesses. */
export function MaturityTimeline({ data }: { data: TimelinePoint[] }) {
  return (
    <ChartCard title="Progression" hint="overall score over time" empty={data.length < 2}>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={28} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={32} domain={[0, 4]} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Line type="monotone" dataKey="overall" name="Overall" stroke={PRISM.violet} strokeWidth={1.75} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
