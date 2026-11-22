import { useEffect, useMemo, useRef, useState } from 'react';
import { TrendingUp } from 'lucide-react';

// Spending trend for one advance (plain SVG, no chart library).
//   1. Cumulative spending over time against the advance amount (reference line)
//   2. Spending by category (one hue, sorted, direct labels)
//   3. Insights computed from the data: spend rate, how long the rest lasts at
//      that pace, the biggest category and the biggest single expense.
// Rejected expenses are left out: they do not use the advance.

const DAY = 86400000;
const num = value => { const n = Number(String(value ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const money = value => `${Math.round(num(value)).toLocaleString('en-US')} MMK`;
const compact = value => { const v = Math.abs(value); if (v >= 1e6) return `${+(value / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`; if (v >= 1e3) return `${+(value / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K`; return String(Math.round(value)); };
const dayKey = value => String(value || '').slice(0, 10);
const toTime = key => new Date(`${key}T00:00:00`).getTime();
const fmtDay = time => new Date(time).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
const niceMax = value => { if (value <= 0) return 1; const p = 10 ** Math.floor(Math.log10(value)); const f = value / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export default function AdvanceTrend({ entries, amount, issuedOn }) {
  const used = useMemo(() => (entries || []).filter(e => String(e.status || '').toLowerCase() !== 'rejected' && num(e.amount) > 0 && dayKey(e.date)), [entries]);

  const series = useMemo(() => {
    const byDay = new Map();
    used.forEach(e => { const k = dayKey(e.date); const d = byDay.get(k) || { key: k, total: 0, count: 0 }; d.total += num(e.amount); d.count += 1; byDay.set(k, d); });
    let cum = 0;
    const points = [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)).map(d => { cum += d.total; return { ...d, time: toTime(d.key), cum }; });
    const start = issuedOn && dayKey(issuedOn) < (points[0]?.key || '9999') ? { key: dayKey(issuedOn), time: toTime(dayKey(issuedOn)), total: 0, count: 0, cum: 0, isStart: true } : null;
    return start ? [start, ...points] : points;
  }, [used, issuedOn]);

  const categories = useMemo(() => {
    const map = new Map();
    used.forEach(e => { const k = e.category || 'Other'; const c = map.get(k) || { name: k, total: 0, count: 0 }; c.total += num(e.amount); c.count += 1; map.set(k, c); });
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [used]);

  if (!used.length) return null;

  const spent = series[series.length - 1].cum;
  const insights = buildInsights({ used, series, categories, amount, spent, issuedOn });

  return <section className="advx-section advx-trend">
    <h3><TrendingUp size={18} />Spending trend <small>excludes rejected expenses</small></h3>
    <ul className="advx-insights">{insights.map(item => <li key={item.label} className={item.tone || ''}><span>{item.label}</span><b>{item.value}</b>{item.note && <small>{item.note}</small>}</li>)}</ul>
    <div className="advx-chart-grid">
      <CumulativeChart series={series} amount={amount} />
      <CategoryBars categories={categories} spent={spent} />
    </div>
    <details className="advx-table-view"><summary>Show as table</summary>
      <table><thead><tr><th>Date</th><th className="num">Expenses</th><th className="num">Spent that day</th><th className="num">Total so far</th><th className="num">% of advance</th></tr></thead>
        <tbody>{series.filter(p => !p.isStart).map(p => <tr key={p.key}><td>{fmtDay(p.time)}</td><td className="num">{p.count}</td><td className="num">{money(p.total)}</td><td className="num">{money(p.cum)}</td><td className="num">{amount ? `${Math.round((p.cum / amount) * 100)}%` : '—'}</td></tr>)}</tbody>
      </table>
    </details>
  </section>;
}

function buildInsights({ used, series, categories, amount, spent, issuedOn }) {
  const firstTime = issuedOn ? toTime(dayKey(issuedOn)) : series[0].time;
  const lastTime = series[series.length - 1].time;
  const today = toTime(new Date().toISOString().slice(0, 10));
  const days = Math.max(1, Math.round((Math.max(lastTime, Math.min(today, lastTime + 30 * DAY)) - firstTime) / DAY) + 1);
  const rate = spent / days;
  const left = amount - spent;
  const out = [{ label: 'Average spend', value: `${money(rate)} / day`, note: `over ${days} day${days === 1 ? '' : 's'}` }];

  if (amount > 0 && left > 0 && rate > 0) {
    const daysLeft = Math.ceil(left / rate);
    out.push({ label: 'At this pace', value: `${daysLeft} more day${daysLeft === 1 ? '' : 's'}`, note: `${money(left)} left · used up around ${fmtDay(today + daysLeft * DAY)}` });
  } else if (amount > 0 && left < 0) {
    out.push({ label: 'Over the advance', value: money(-left), note: 'reimbursed after approval', tone: 'warn' });
  } else if (amount > 0) {
    out.push({ label: 'Advance', value: 'Fully used', note: money(amount) });
  }

  const top = categories[0];
  if (top) out.push({ label: 'Biggest category', value: top.name, note: `${money(top.total)} · ${Math.round((top.total / spent) * 100)}% of spending` });
  const biggest = used.reduce((a, b) => (num(b.amount) > num(a.amount) ? b : a));
  out.push({ label: 'Largest expense', value: money(biggest.amount), note: biggest.description || biggest.category || '' });
  return out;
}

function CumulativeChart({ series, amount }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const height = 240;
  const m = { top: 18, right: 16, bottom: 30, left: 52 };
  const w = width - m.left - m.right; const h = height - m.top - m.bottom;
  const t0 = series[0].time; let t1 = series[series.length - 1].time;
  const single = t1 === t0; if (single) t1 = t0 + DAY;
  const yMax = niceMax(Math.max(amount, series[series.length - 1].cum) * 1.08);
  const x = t => m.left + (single ? w / 2 : ((t - t0) / (t1 - t0)) * w);
  const y = v => m.top + h - (v / yMax) * h;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * yMax);

  // Step line: total jumps on the day money is spent.
  let path = `M${x(series[0].time)},${y(series[0].cum)}`;
  series.slice(1).forEach(p => { path += ` H${x(p.time)} V${y(p.cum)}`; });
  const area = `${path} V${y(0)} H${x(series[0].time)} Z`;
  const last = series[series.length - 1];
  const xTicks = series.length <= 6 ? series : [series[0], series[Math.floor(series.length / 2)], last];

  const onMove = event => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    let best = series[0];
    series.forEach(p => { if (Math.abs(x(p.time) - px) < Math.abs(x(best.time) - px)) best = p; });
    setHover(best);
  };

  return <figure className="advx-chart" ref={ref}>
    <figcaption>Total spent over time <small>dashed line = advance amount</small></figcaption>
    <div className="advx-chart-box">
      <svg width={width} height={height} role="img" aria-label={`Total spent rose to ${money(last.cum)} against an advance of ${money(amount)}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map(v => <g key={v}><line className="grid" x1={m.left} x2={m.left + w} y1={y(v)} y2={y(v)} /><text className="axis" x={m.left - 8} y={y(v) + 4} textAnchor="end">{compact(v)}</text></g>)}
        {xTicks.map(p => <text key={p.key} className="axis" x={x(p.time)} y={height - 8} textAnchor={p === series[0] && !single ? 'start' : p === last && !single ? 'end' : 'middle'}>{fmtDay(p.time)}</text>)}
        {amount > 0 && <g><line className="ref" x1={m.left} x2={m.left + w} y1={y(amount)} y2={y(amount)} /><text className="ref-label" x={m.left + 6} y={y(amount) - 6}>Advance {compact(amount)}</text></g>}
        <path className="area" d={area} />
        <path className="line" d={path} />
        {series.filter(p => !p.isStart).map(p => <circle key={p.key} className="dot" cx={x(p.time)} cy={y(p.cum)} r={4.5} />)}
        <text className="end-label" x={Math.min(x(last.time), m.left + w) - 6} y={y(last.cum) - 10} textAnchor="end">{compact(last.cum)}</text>
        {hover && <g><line className="cross" x1={x(hover.time)} x2={x(hover.time)} y1={m.top} y2={m.top + h} /><circle className="dot hover" cx={x(hover.time)} cy={y(hover.cum)} r={6} /></g>}
        <rect x={m.left} y={m.top} width={w} height={h} fill="transparent" />
      </svg>
      {hover && <div className="advx-tip" style={{ left: Math.min(Math.max(x(hover.time), 90), width - 90), top: Math.max(y(hover.cum) - 12, 0) }}>
        <b>{fmtDay(hover.time)}</b>
        {hover.isStart ? <span>Advance released</span> : <><span>Spent that day: {money(hover.total)} ({hover.count} item{hover.count === 1 ? '' : 's'})</span><span>Total so far: {money(hover.cum)}</span>{amount > 0 && <span>{Math.round((hover.cum / amount) * 100)}% of advance</span>}</>}
      </div>}
    </div>
  </figure>;
}

function CategoryBars({ categories, spent }) {
  const [hover, setHover] = useState(null);
  const max = categories[0]?.total || 1;
  return <figure className="advx-chart">
    <figcaption>Spending by category</figcaption>
    <ul className="advx-bars">
      {categories.map(c => <li key={c.name} onMouseEnter={() => setHover(c.name)} onMouseLeave={() => setHover(null)} className={hover === c.name ? 'hover' : ''}>
        <span className="name">{c.name}</span>
        <span className="track"><i style={{ width: `${Math.max(2, (c.total / max) * 100)}%` }} /></span>
        <span className="value">{money(c.total)} <small>{Math.round((c.total / spent) * 100)}%</small></span>
        {hover === c.name && <span className="advx-tip inline">{c.count} expense{c.count === 1 ? '' : 's'} · {money(c.total)} · {Math.round((c.total / spent) * 100)}% of spending</span>}
      </li>)}
    </ul>
  </figure>;
}
