import { useEffect, useState } from 'react';
import {
  Activity,
  CircleHelp,
  Clock3,
  Download,
  FileDown,
  Wrench,
  ReceiptText as ReceiptTextIcon,
  PackageCheck as PackageCheckIcon,
  Boxes as BoxesIcon,
  BriefcaseBusiness as BriefcaseIcon,
  UsersRound as UsersIcon,
  Wallet as WalletIcon,
} from 'lucide-react';
import { apiRequest, exportModule } from '../api/client.js';
import { moduleInfo } from '../data.js';
import Status from '../components/Status.jsx';
import { apiEndpoint, isStatus, normalizeList } from '../lib/records.js';

const reportCatalog = [
  {
    id: 'job-register',
    title: 'Job Register',
    description: 'Jobs by customer, team, dates and lifecycle status.',
    icon: BriefcaseIcon,
    source: 'jobs',
  },
  {
    id: 'quotation-register',
    title: 'Quotation Register',
    description: 'Quotes, expiry dates, totals and conversion status.',
    icon: FileDown,
    source: 'quotations',
  },
  {
    id: 'machine-service-history',
    title: 'Machine Service History',
    description: 'Registered equipment and linked service activity.',
    icon: Wrench,
    source: 'machines',
  },
  {
    id: 'invoice-register',
    title: 'Invoice Register',
    description: 'Invoices, due dates, received amounts and status.',
    icon: ReceiptTextIcon,
    source: 'invoices',
  },
  {
    id: 'receivables-aging',
    title: 'Receivables Aging',
    description: 'Outstanding invoices and due dates for follow-up.',
    icon: Clock3,
    source: 'invoices',
  },
  {
    id: 'cash-book',
    title: 'Cash Book',
    description: 'Receipts, payments and transaction references.',
    icon: WalletIcon,
    source: 'cash-claims',
  },
  {
    id: 'income-expense',
    title: 'Income and Expense',
    description: 'Company expenses and cash movements by period and category.',
    icon: Activity,
    source: 'cash-claims',
  },
  {
    id: 'advance-outstanding',
    title: 'Advance Outstanding',
    description: 'Advances by staff member: amount, spent, to return and to reimburse.',
    icon: CircleHelp,
    source: 'advances',
  },
  {
    id: 'expense-claims',
    title: 'Expense Claim Register',
    description: 'Staff expense claims: claimed, approved and still to pay.',
    icon: ReceiptTextIcon,
    source: 'staff-claims',
  },
  {
    id: 'inventory-stock',
    title: 'Inventory Stock',
    description: 'On-hand quantity, reorder level and stock state.',
    icon: BoxesIcon,
    source: 'inventory',
  },
  {
    id: 'material-usage-job',
    title: 'Material Usage by Job',
    description: 'Material requests and issued quantities by job.',
    icon: PackageCheckIcon,
    source: 'material-requests',
  },
  {
    id: 'supplier-register',
    title: 'Supplier Register',
    description: 'Supplier details, contact and active records.',
    icon: UsersIcon,
    source: 'suppliers',
  },
  {
    id: 'fixed-asset-register',
    title: 'Fixed Asset Register',
    description: 'Asset cost, assignment, location and status.',
    icon: BriefcaseIcon,
    source: 'fixed-assets',
  },
];
export default function ReportsPage({ notify }) {
  const [reportId, setReportId] = useState(reportCatalog[0].id);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [customer, setCustomer] = useState('');
  const [job, setJob] = useState('');
  const [status, setStatus] = useState('');
  const [staff, setStaff] = useState('');
  const [supplier, setSupplier] = useState('');
  const [remoteRows, setRemoteRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const selected = reportCatalog.find(report => report.id === reportId) || reportCatalog[0];
  const sourceInfo = moduleInfo[selected.source];
  const filters = { from, to, customer, job, status, staff, supplier };
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError('');
    const params = new URLSearchParams({ page: '1', limit: '500' });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    apiRequest(`/${apiEndpoint(selected.source)}?${params}`)
      .then(result => {
        if (alive) setRemoteRows(normalizeList(result, sourceInfo.columns));
      })
      .catch(error => {
        if (alive) setLoadError(error.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selected.source, from, to, customer, job, status, staff, supplier]);
  const sourceRows = remoteRows;
  const dateColumn = sourceInfo.columns.findIndex(column => /date|due|issued|delivered|purchased|received/i.test(column));
  const searchFilters = [customer, job, status, staff, supplier].filter(Boolean).map(value => value.toLowerCase());
  const rows = sourceRows.filter(row => {
    const joined = row.join(' ').toLowerCase();
    if (!searchFilters.every(filter => joined.includes(filter))) return false;
    if (dateColumn >= 0 && (from || to)) {
      const raw = String(row[dateColumn] || '');
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.valueOf())) {
        if (from && parsed < new Date(`${from}T00:00:00`)) return false;
        if (to && parsed > new Date(`${to}T23:59:59`)) return false;
      }
    }
    return true;
  });
  const clearFilters = () => {
    setFrom('');
    setTo('');
    setCustomer('');
    setJob('');
    setStatus('');
    setStaff('');
    setSupplier('');
  };
  const doExport = async format => {
    const activeFilters = Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
    try {
      await exportModule(`reports/${selected.id}`, format, activeFilters);
    } catch (error) {
      notify(error.message, 'error');
    }
  };
  return (
    <>
      <div className="page-heading module-heading">
        <div>
          <div className="eyebrow">INSIGHTS & EXPORTS</div>
          <h1>Reports</h1>
          <p>Filter the register, review matching records, then export that result.</p>
        </div>
        <label className="report-picker">
          Report
          <select value={reportId} onChange={event => setReportId(event.target.value)}>
            {reportCatalog.map(report => (
              <option key={report.id} value={report.id}>
                {report.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="panel report-filters">
        <label>
          From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </label>
        <label>
          Customer
          <input value={customer} onChange={e => setCustomer(e.target.value)} placeholder="Search customer" />
        </label>
        <label>
          Job ID
          <input value={job} onChange={e => setJob(e.target.value)} placeholder="Search job" />
        </label>
        <label>
          Status
          <input value={status} onChange={e => setStatus(e.target.value)} placeholder="Any status" />
        </label>
        <label>
          Technician / employee
          <input value={staff} onChange={e => setStaff(e.target.value)} placeholder="Search staff" />
        </label>
        <label>
          Supplier
          <input value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="Search supplier" />
        </label>
        <button className="row-action-button" onClick={clearFilters}>
          Clear filters
        </button>
      </section>
      <div className="report-result-bar">
        <div>
          <span className="report-row-icon">
            <selected.icon size={18} />
          </span>
          <div>
            <b>{selected.title}</b>
            <small>
              {rows.length} matching records · Generated {new Date().toLocaleString()}
            </small>
          </div>
        </div>
        <div>
          <button className="secondary-button" disabled={loading || Boolean(loadError)} onClick={() => doExport('pdf')}>
            <Download size={15} /> Print / Save PDF
          </button>
          <button className="secondary-button" disabled={loading || Boolean(loadError)} onClick={() => doExport('xlsx')}>
            <FileDown size={15} /> Export Excel
          </button>
        </div>
      </div>
      {loadError && (
        <div className="query-error">
          <b>Couldn’t load report records.</b>
          <span>{loadError}</span>
        </div>
      )}
      <section className="panel report-table-panel report-preview">
        <div className="panel-heading">
          <div>
            <h2>{selected.title}</h2>
            <p>{selected.description}</p>
          </div>
          <span className="report-count">{loading ? 'Loading…' : `${rows.length} records`}</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {sourceInfo.columns.map(column => (
                  <th key={column}>{column.toUpperCase()}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row[0]}-${index}`}>
                  {row.map((cell, i) => (
                    <td key={i}>{isStatus(cell) ? <Status value={cell} /> : cell}</td>
                  ))}
                </tr>
              ))}
              {!loading && !rows.length && (
                <tr>
                  <td className="empty-state" colSpan={sourceInfo.columns.length}>
                    No records match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
