"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FunnelPoint } from "@/lib/metrics/pulse";
import { AXIS_TICK, PRISM, TOOLTIP_STYLE } from "./palette";
import { ChartCard } from "./chart-card";

const STATUS_COLOR: Record<string, string> = {
  backlog: "rgba(15,15,17,0.30)",
  ready: PRISM.cyan,
  in_progress: PRISM.violet,
  blocked: PRISM.red,
  done: PRISM.emerald,
};

export function TaskFunnel({ data }: { data: FunnelPoint[] }) {
  const empty = data.every((d) => d.count === 0);

  return (
    <ChartCard
      title="Execution"
      hint="tasks by status"
      help={
        <>
          <span className="font-medium text-ink">What this is</span>
          <br />
          Every task the brain knows about, grouped by its current status — Backlog, Ready, In
          progress, Blocked, Done.
          <br />
          <br />
          This is a <span className="font-medium text-ink">live snapshot</span>, not a windowed
          count: it reflects each task&apos;s status right now, so the date range above doesn&apos;t
          change it.
        </>
      }
      empty={empty}
      emptyLabel="No tasks yet."
    >
      <ResponsiveContainer width="100%" height={200}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
          barCategoryGap={6}
        >
          <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={84}
          />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "rgba(124,58,237,0.06)" }} />
          <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={22}>
            {data.map((d) => (
              <Cell key={d.status} fill={STATUS_COLOR[d.status] ?? PRISM.violet} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
