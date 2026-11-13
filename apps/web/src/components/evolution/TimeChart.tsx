import { useId } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { NO_DATA, shortDate } from '@/lib/evolution-format';

export interface Series {
  key: string;
  label: string;
  color: string;
}

export type Row = Record<string, string | number | null>;

interface TimeChartProps {
  title: string;
  rows: Row[];
  /** The key holding an ISO date for the x axis. */
  x: string;
  series: Series[];
  kind: 'line' | 'bar' | 'area';
  /** Stacked shares of a whole, shown as percentages. */
  shares?: boolean;
  height?: number;
  domain?: [number, number];
}

const axis = { fontSize: 11, fill: 'var(--muted-foreground)' };
const formatValue = (v: unknown, shares: boolean): string => {
  if (typeof v !== 'number') return NO_DATA;
  return shares ? `${Math.round(v * 100)}%` : v.toLocaleString();
};

/**
 * One time series chart with a data table underneath. Missing values stay missing: lines break,
 * bars are absent and the table says "no data".
 */
export function TimeChart({ title, rows, x, series, kind, shares = false, height = 180, domain }: TimeChartProps) {
  const captionId = useId();
  const hasData = rows.some((r) => series.some((s) => typeof r[s.key] === 'number'));
  const common = { data: rows, margin: { top: 8, right: 8, bottom: 0, left: -12 } };
  const grid = <CartesianGrid vertical={false} stroke="var(--border)" />;
  const xAxis = <XAxis dataKey={x} tickFormatter={(v: string) => shortDate(v)} tick={axis} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={24} />;
  const yAxis = <YAxis tick={axis} tickLine={false} axisLine={false} width={44} allowDecimals={false} {...(domain && { domain })} {...(shares && { tickFormatter: (v: number) => `${Math.round(v * 100)}%`, domain: [0, 1] })} />;
  const tooltip = (
    <Tooltip
      cursor={kind === 'bar' ? { fill: 'var(--muted)' } : { stroke: 'var(--border)' }}
      labelFormatter={(v) => (typeof v === 'string' ? shortDate(v) : '')}
      formatter={(v) => formatValue(v, shares)}
      contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--popover-foreground)' }}
    />
  );
  const legend = series.length > 1 ? <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: 'var(--muted-foreground)' }} /> : null;

  return (
    <figure className="space-y-1" aria-labelledby={captionId}>
      <figcaption id={captionId} className="text-sm font-medium">{title}</figcaption>
      {hasData ? (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            {kind === 'line' ? (
              <LineChart {...common}>
                {grid}{xAxis}{yAxis}{tooltip}{legend}
                {series.map((s) => <Line key={s.key} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />)}
              </LineChart>
            ) : kind === 'bar' ? (
              <BarChart {...common} barCategoryGap={2} barGap={2}>
                {grid}{xAxis}{yAxis}{tooltip}{legend}
                {series.map((s) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} isAnimationActive={false} />)}
              </BarChart>
            ) : (
              <AreaChart {...common}>
                {grid}{xAxis}{yAxis}{tooltip}{legend}
                {series.map((s) => <Area key={s.key} dataKey={s.key} name={s.label} stackId={shares ? 'share' : undefined} stroke="var(--card)" strokeWidth={2} fill={s.color} fillOpacity={0.85} connectNulls={false} isAnimationActive={false} />)}
              </AreaChart>
            )}
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No data for this period.</p>
      )}
      <details className="text-xs">
        <summary className="text-muted-foreground cursor-pointer">Show data</summary>
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-left">
            <thead>
              <tr>
                <th className="pr-3 font-medium">Date</th>
                {series.map((s) => <th key={s.key} className="pr-3 font-medium">{s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${String(r[x])}-${i}`}>
                  <td className="pr-3">{typeof r[x] === 'string' ? shortDate(r[x]) : ''}</td>
                  {series.map((s) => <td key={s.key} className="pr-3 tabular-nums">{formatValue(r[s.key], shares)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
} // prettier-ignore
