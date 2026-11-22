// Building blocks shared by the dashboard panels.
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, ArrowUpRight, BriefcaseBusiness } from 'lucide-react';

export function MetricCard({ stat, value, delta, index }) {
  return (
    <Link to={stat.target} className={`stat-card metric-card ${stat.color}`} style={{ animationDelay: `${index * 55}ms` }}>
      <div className="metric-card-head">
        <div className={`stat-icon ${stat.color}`}><stat.icon size={20} strokeWidth={1.9} /></div>
        <span className="metric-trend"><ArrowUpRight size={15} /></span>
      </div>
      <div className="stat-label">{stat.label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-delta">{delta || 'View details'}</div>
    </Link>
  );
}

export function PanelHeading({ title, subtitle, to, linkLabel }) {
  return (
    <div className="panel-heading">
      <div><h2>{title}</h2><p>{subtitle}</p></div>
      {to && <Link to={to} className="text-link">{linkLabel} <ArrowRight size={14} /></Link>}
    </div>
  );
}

function ChartEmpty({ icon: Icon, title, text }) {
  return (
    <div className="chart-empty">
      <span className="chart-empty-icon"><Icon size={19} /></span>
      <b>{title}</b>
      <span>{text}</span>
    </div>
  );
}

export function MiniBarChart({ series, emptyText, cash = false }) {
  if (!series.length) return <ChartEmpty icon={Activity} title="No chart data yet" text={emptyText} />;
  const first = item => Number(item.revenue ?? item.income ?? item.value ?? 0);
  const second = item => Number(item.expenses ?? item.outflow ?? 0);
  const max = Math.max(1, ...series.flatMap(item => [first(item), second(item)]));
  return (
    <div className={`mini-bar-chart ${cash ? 'cash-chart' : ''}`}>
      <div className="chart-legend">
        <span><i className="legend-revenue" />{cash ? 'Inflow' : 'Revenue'}</span>
        {!cash && <span><i className="legend-expense" />Expenses</span>}
      </div>
      <div className="bar-chart-plot">
        {series.map((item, index) => (
          <div className="bar-chart-group" key={`${item.month || item.label || index}`}>
            <div className="bar-chart-bars">
              <span className="revenue-bar" style={{ height: `${Math.max(3, (first(item) / max) * 100)}%` }} title={`${cash ? 'Inflow' : 'Revenue'}: ${first(item).toLocaleString('en-US')}`} />
              {!cash && <span className="expense-bar" style={{ height: `${Math.max(3, (second(item) / max) * 100)}%` }} title={`Expenses: ${second(item).toLocaleString('en-US')}`} />}
            </div>
            <small>{item.month || item.label || ''}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

const DONUT_PALETTE = ['#2f88f5', '#18b89b', '#f2ad4b', '#8f78f6', '#ec7182', '#82a0b8'];

export function JobStatusDonut({ counts, emptyText }) {
  const entries = (Array.isArray(counts)
    ? counts.map(item => [item.status ?? item.label ?? item.name ?? 'Other', item.count ?? item.total ?? item.value])
    : Object.entries(counts || {}))
    .map(([label, value]) => [label, Number(value?.count ?? value?.total ?? value) || 0])
    .filter(([, value]) => value > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return <ChartEmpty icon={BriefcaseBusiness} title="No status data yet" text={emptyText} />;
  let cursor = 0;
  const stops = entries.map(([, value], i) => {
    const start = cursor;
    cursor += (value / total) * 100;
    return `${DONUT_PALETTE[i % DONUT_PALETTE.length]} ${start}% ${cursor}%`;
  }).join(',');
  return (
    <div className="status-chart-wrap">
      <div className="status-donut" style={{ background: `conic-gradient(${stops})` }}><div><b>{total}</b><span>Job orders</span></div></div>
      <div className="status-legend">
        {entries.map(([label, value], i) => <div key={label}><i style={{ background: DONUT_PALETTE[i % DONUT_PALETTE.length] }} /><span>{label}</span><b>{value}</b></div>)}
      </div>
    </div>
  );
}
