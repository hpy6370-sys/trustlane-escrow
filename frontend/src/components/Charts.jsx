import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/** Reads chart colours from CSS custom properties so light/dark themes stay in styles.css. */
function useChartTheme() {
  const read = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    return {
      s1: v("--series-1"),
      s2: v("--series-2"),
      grid: v("--grid"),
      axis: v("--muted"),
      surface: v("--surface"),
      text: v("--text"),
    };
  };
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setTheme(read());
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return theme;
}

const axisProps = (t) => ({
  stroke: t.grid,
  tick: { fill: t.axis, fontSize: 12 },
  tickLine: false,
  axisLine: { stroke: t.grid },
});

function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-title">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="chart-tip-row">
          <span className="swatch" style={{ background: p.color }} aria-hidden="true" />
          <span>{p.name}</span>
          <span className="num">
            {typeof p.value === "number" ? p.value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : p.value}
            {unit ? ` ${unit}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function Legend({ items }) {
  return (
    <ul className="legend">
      {items.map(([name, color]) => (
        <li key={name}>
          <span className="swatch" style={{ background: color }} aria-hidden="true" />
          {name}
        </li>
      ))}
    </ul>
  );
}

function TableView({ columns, rows }) {
  return (
    <details className="table-view">
      <summary>Show data table</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map(([k, label]) => (
                <th key={k}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map(([k]) => (
                  <td key={k} className={typeof r[k] === "number" ? "num" : ""}>
                    {typeof r[k] === "number" ? r[k].toLocaleString(undefined, { maximumFractionDigits: 4 }) : r[k]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const shortDate = (d) => d.slice(5); // MM-DD
const compactFmt = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
const compact = (v) => compactFmt.format(v);

/** Escrows created vs disputes opened per day (same unit -> one axis). */
export function ActivityChart({ series }) {
  const t = useChartTheme();
  const data = series.map((d) => ({ date: shortDate(d.date), created: d.created, disputes: d.disputes }));
  return (
    <div>
      <Legend
        items={[
          ["Escrows created", t.s1],
          ["Disputes opened", t.s2],
        ]}
      />
      <div className="chart" style={{ height: 240 }}>
        <ResponsiveContainer>
          <BarChart data={data} barGap={2} barCategoryGap="20%" margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={t.grid} strokeWidth={1} />
            <XAxis dataKey="date" {...axisProps(t)} interval="preserveStartEnd" minTickGap={16} />
            <YAxis allowDecimals={false} {...axisProps(t)} axisLine={false} width={40} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: t.grid, opacity: 0.4 }} />
            <Bar dataKey="created" name="Escrows created" fill={t.s1} radius={[4, 4, 0, 0]} maxBarSize={14} />
            <Bar dataKey="disputes" name="Disputes opened" fill={t.s2} radius={[4, 4, 0, 0]} maxBarSize={14} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <TableView
        columns={[
          ["date", "Date"],
          ["created", "Created"],
          ["disputes", "Disputes"],
        ]}
        rows={series.filter((d) => d.created || d.disputes)}
      />
    </div>
  );
}

const STATUS_ORDER = ["Created", "Active", "Disputed", "Completed", "Resolved", "Refunded", "Cancelled"];

/** Count of escrows per lifecycle status: single series, horizontal bars, direct value labels. */
export function StatusChart({ byStatus }) {
  const t = useChartTheme();
  const data = STATUS_ORDER.map((s) => ({ status: s, count: byStatus[s] || 0 }));
  return (
    <div>
      <div className="chart" style={{ height: 240 }}>
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 32, left: 8, bottom: 0 }} barCategoryGap={6}>
            <CartesianGrid horizontal={false} stroke={t.grid} />
            <XAxis type="number" allowDecimals={false} {...axisProps(t)} />
            <YAxis type="category" dataKey="status" {...axisProps(t)} axisLine={false} width={78} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: t.grid, opacity: 0.4 }} />
            <Bar dataKey="count" name="Escrows" fill={t.s1} radius={[0, 4, 4, 0]} maxBarSize={16}>
              <LabelList dataKey="count" position="right" fill={t.text} fontSize={12} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <TableView
        columns={[
          ["status", "Status"],
          ["count", "Escrows"],
        ]}
        rows={data}
      />
    </div>
  );
}

/** Daily escrowed volume, one small chart per token (different units never share an axis). */
export function VolumeCharts({ series, symbols }) {
  const t = useChartTheme();
  if (!symbols.length) return <p className="muted">No volume yet.</p>;
  return (
    <div className="small-multiples">
      {symbols.map((sym) => {
        const data = series.map((d) => ({ date: shortDate(d.date), value: d.volume[sym] || 0 }));
        return (
          <figure key={sym} className="multiple">
            <figcaption>Escrowed per day · {sym}</figcaption>
            <div className="chart" style={{ height: 150 }}>
              <ResponsiveContainer>
                <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={t.grid} />
                  <XAxis dataKey="date" {...axisProps(t)} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis {...axisProps(t)} axisLine={false} width={48} tickFormatter={compact} />
                  <Tooltip content={<ChartTooltip unit={sym} />} cursor={{ fill: t.grid, opacity: 0.4 }} />
                  <Bar dataKey="value" name="Escrowed" fill={t.s1} radius={[4, 4, 0, 0]} maxBarSize={12} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </figure>
        );
      })}
    </div>
  );
}
