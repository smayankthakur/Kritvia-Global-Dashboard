"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDate, formatINR, formatNumber } from "@/lib/format";

export interface DayPoint {
  day: string;
  qty: number;
  revenue: number;
}

/** Portions sold per day. A data table follows the chart for screen readers. */
export function SalesChart({ data }: { data: DayPoint[] }) {
  return (
    <figure>
      <div className="h-64 w-full" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="day"
              tickFormatter={(d: string) => d.slice(8, 10) + "/" + d.slice(5, 7)}
              tick={{ fill: "var(--fg-subtle)", fontSize: 11 }}
              axisLine={{ stroke: "var(--border)" }}
              tickLine={false}
              minTickGap={12}
            />
            <YAxis tick={{ fill: "var(--fg-subtle)", fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--fg)" }}
              labelFormatter={(d) => formatDate(String(d))}
              formatter={(v, _n, item) => [`${formatNumber(Number(v), 0)} portions · ${formatINR((item.payload as DayPoint).revenue, { whole: true })}`, "Sold"]}
            />
            <Bar dataKey="qty" fill="var(--accent)" radius={[3, 3, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">
        Portions sold per day:{" "}
        {data.map((d) => `${formatDate(d.day)}: ${d.qty}`).join("; ")}
      </figcaption>
    </figure>
  );
}
