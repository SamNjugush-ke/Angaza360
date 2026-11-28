"use client";

import { useEffect, useId, useRef, useState } from "react";
import { moneyScale } from "@/lib/charts/scale";
import type { TrendBucket } from "@/lib/dashboard/types";
import { formatKES, formatKESCompact, parseCents } from "@/lib/money";

// Revenue (bars) and net profit (a line with dots) over the last months. Restrained by design:
// no gridlines and no decoration — the axis labels, a solid ZERO BASELINE (a loss reads as below
// it) and the current month marked "to date". Shape distinguishes the series as well as colour,
// the figure has a title and description, and the exact figures are one keyboard step away in a
// table. Colours come from the theme tokens, so it reads in light and dark alike.

const HEIGHT = 240;
const MARGIN = { top: 12, right: 12, bottom: 40, left: 64 };

const monthFormatter = new Intl.DateTimeFormat("en-KE", { month: "short", timeZone: "UTC" });
const monthYearFormatter = new Intl.DateTimeFormat("en-KE", { month: "long", year: "numeric", timeZone: "UTC" });

function monthDate(month: string): Date {
  const [year, m] = month.split("-");
  return new Date(Date.UTC(Number(year), Number(m) - 1, 15));
}

export function monthLabel(month: string): string {
  return monthFormatter.format(monthDate(month));
}

export function monthLongLabel(month: string): string {
  return monthYearFormatter.format(monthDate(month));
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** A one-sentence account of the series, for the figure's description. */
export function trendSummary(buckets: readonly TrendBucket[]): string {
  return buckets
    .map((b) => `${monthLongLabel(b.month)}${b.partial ? " (to date)" : ""}: revenue ${formatKES(b.revenue, { currency: true })}, net profit ${formatKES(b.netProfit, { currency: true })}`)
    .join("; ");
}

export function TrendChart({ buckets }: { buckets: readonly TrendBucket[] }) {
  const [ref, width] = useWidth();
  const titleId = useId();
  const descId = useId();
  const hatchId = useId().replace(/:/g, "");

  const plotWidth = width - MARGIN.left - MARGIN.right;
  const values = buckets.flatMap((b) => [parseCents(b.revenue), parseCents(b.netProfit)]);
  const scale = moneyScale(values, HEIGHT);
  const band = plotWidth / Math.max(1, buckets.length);
  const barWidth = Math.min(40, band * 0.5);
  const x = (index: number) => MARGIN.left + band * index + band / 2;
  const y = (cents: bigint) => MARGIN.top + scale.y(cents);
  const zeroY = y(0n);
  const netPoints = buckets.map((b, i) => `${x(i).toFixed(1)},${y(parseCents(b.netProfit)).toFixed(1)}`).join(" ");

  return (
    <figure className="space-y-3">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-hidden>
        <span className="flex items-center gap-2">
          <span className="inline-block size-3 rounded-sm" style={{ background: "rgb(var(--chart-revenue))" }} />
          Revenue
        </span>
        <span className="flex items-center gap-2">
          <svg width="22" height="12" viewBox="0 0 22 12">
            <line x1="1" y1="6" x2="21" y2="6" stroke="rgb(var(--chart-net))" strokeWidth="2" />
            <circle cx="11" cy="6" r="3.5" fill="rgb(var(--chart-net))" />
          </svg>
          Net profit
        </span>
      </div>
      <div ref={ref} className="w-full">
        <svg role="img" aria-labelledby={titleId} aria-describedby={descId} width={width} height={HEIGHT + MARGIN.top + MARGIN.bottom} className="block max-w-full overflow-visible">
          <title id={titleId}>Revenue and net profit by month</title>
          <desc id={descId}>{trendSummary(buckets)}</desc>
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="rgb(var(--chart-revenue) / 0.35)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgb(var(--chart-revenue))" strokeWidth="2" />
            </pattern>
          </defs>
          {/* Axis labels only — no gridlines. */}
          {scale.ticks.map((tick) => (
            <text key={tick.toString()} x={MARGIN.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle" className="tabular fill-muted-foreground text-[11px]">
              {tick === 0n ? "0" : formatKESCompact(tick)}
            </text>
          ))}
          {buckets.map((b, i) => {
            const revenue = parseCents(b.revenue);
            const top = Math.min(y(revenue), zeroY);
            const height = Math.abs(zeroY - y(revenue));
            return (
              <g key={b.month}>
                <rect x={x(i) - barWidth / 2} y={top} width={barWidth} height={height} rx={2} fill={b.partial ? `url(#${hatchId})` : "rgb(var(--chart-revenue))"} />
                <text x={x(i)} y={MARGIN.top + HEIGHT + 18} textAnchor="middle" className="fill-foreground text-[12px]">
                  {monthLabel(b.month)}
                </text>
                {b.partial ? (
                  <text x={x(i)} y={MARGIN.top + HEIGHT + 32} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                    to date
                  </text>
                ) : null}
              </g>
            );
          })}
          {/* The zero baseline, drawn over the bars so a loss is visibly below it. */}
          <line x1={MARGIN.left} x2={width - MARGIN.right} y1={zeroY} y2={zeroY} stroke="rgb(var(--foreground))" strokeWidth="1.5" />
          <polyline points={netPoints} fill="none" stroke="rgb(var(--chart-net))" strokeWidth="2" strokeLinejoin="round" />
          {buckets.map((b, i) => (
            <circle
              key={b.month}
              cx={x(i)}
              cy={y(parseCents(b.netProfit))}
              r={4}
              fill={b.partial ? "rgb(var(--card))" : "rgb(var(--chart-net))"}
              stroke="rgb(var(--chart-net))"
              strokeWidth="2"
            />
          ))}
        </svg>
      </div>
      <details className="text-sm">
        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          View as table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">Revenue and net profit by month</caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Month
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Revenue
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Net profit
                </th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.month} className="border-b last:border-0">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    {monthLongLabel(b.month)}
                    {b.partial ? " (to date)" : ""}
                  </th>
                  <td className="tabular py-2 pr-4 text-right">{formatKES(b.revenue)}</td>
                  <td className="tabular py-2 text-right">{formatKES(b.netProfit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
