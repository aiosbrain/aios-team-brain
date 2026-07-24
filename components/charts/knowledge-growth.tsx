"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { KnowledgePoint } from "@/lib/metrics/pulse";
import { AXIS_TICK, GRID_STROKE, PRISM, TOOLTIP_STYLE } from "./palette";
import { ChartCard } from "./chart-card";

const SERIES: { key: keyof KnowledgePoint; color: string }[] = [
  { key: "deliverable", color: PRISM.violet },
  { key: "transcript", color: PRISM.blue },
  { key: "decision", color: PRISM.amber },
  { key: "task", color: PRISM.emerald },
  { key: "skill", color: PRISM.fuchsia },
  { key: "artifact", color: PRISM.cyan },
];

export function KnowledgeGrowth({ data }: { data: KnowledgePoint[] }) {
  const empty = data.every((d) =>
    SERIES.every((s) => (d[s.key] as number) === 0)
  );

  return (
    <ChartCard title="Knowledge growth" hint="new items / day" empty={empty}>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis
            dataKey="date"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          {SERIES.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stackId="kinds"
              stroke={s.color}
              fill={s.color}
              fillOpacity={0.18}
              strokeWidth={1.5}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
