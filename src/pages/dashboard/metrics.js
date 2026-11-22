// Small helpers for reading the dashboard summary and formatting its numbers.

/** First non-empty value among several possible keys (dot paths allowed). */
export function resolveDashboardMetric(data, aliases = []) {
  for (const key of aliases) {
    const value = key.split('.').reduce((node, part) => node?.[part], data);
    if (value == null) continue;
    const scalar = typeof value === 'object' ? (value.total ?? value.count ?? value.amount ?? value.value) : value;
    if (scalar != null) return scalar;
  }
  return null;
}

export function getDashboardSeries(data, names) {
  for (const name of names) {
    const series = name.split('.').reduce((node, part) => node?.[part], data);
    if (Array.isArray(series)) return series;
  }
  return [];
}

export function sameDisplayName(left, right) {
  const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)));
}

export function moneyText(value, isMoney = true) {
  if (value == null || value === '?') return '—';
  if (typeof value === 'number') return isMoney ? `MMK ${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : value.toLocaleString('en-US');
  return String(value);
}

export function formatDelta(delta) {
  if (delta == null) return 'Change unavailable';
  if (typeof delta === 'object') {
    const change = delta.percent ?? delta.changePercent ?? delta.value;
    const direction = Number(change) < 0 ? 'down' : 'up';
    return Number.isFinite(Number(change)) ? `${Math.abs(Number(change))}% ${direction} vs previous period` : String(delta.label || 'Compared with previous period');
  }
  return String(delta);
}

export const rowsState = (query, rows) =>
  query.isLoading ? 'Loading records…' : query.isError ? 'Could not load records.' : rows.length ? '' : 'No records to show yet.';

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
