import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, PackageCheck, ShoppingCart, Truck, X } from 'lucide-react';
import { apiRequest } from '../api/client.js';
import { confirmDialog, promptDialog } from '../components/AskDialog.jsx';
import Status from '../components/Status.jsx';
import '../insights.css';

// Low stock -> purchase request -> ordered -> received (adds the stock).

const money = value => `${Math.round(Number(value) || 0).toLocaleString('en-US')} MMK`;
const qty = value => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const shortDate = value => (value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function Purchasing({ notify }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const low = useQuery({ queryKey: ['low-stock'], queryFn: () => apiRequest('/low-stock'), staleTime: 20_000 });
  const requests = useQuery({ queryKey: ['purchase-requests'], queryFn: () => apiRequest('/purchase-requests?page=1&limit=200'), staleTime: 20_000 });
  const lowItems = Array.isArray(low.data) ? low.data : [];
  const allRequests = requests.data?.items || [];
  const shown = allRequests.filter(r => showClosed || ['Pending', 'Ordered'].includes(r.status));

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['low-stock'] }),
    queryClient.invalidateQueries({ queryKey: ['purchase-requests'] }),
    queryClient.invalidateQueries({ queryKey: ['module', 'inventory'] }),
  ]);
  const act = async (key, task, message) => {
    setBusy(key);
    try { await task(); await refresh(); notify?.(message); }
    catch (error) { notify?.(error.message); }
    finally { setBusy(''); }
  };

  const createRequest = async item => {
    const answer = await promptDialog(`How many ${item.unit || 'units'} of ${item.name}? ${qty(item.on_hand)} left, reorder level ${qty(item.reorder_level)}.`, {
      title: 'Create purchase request', label: 'Quantity', defaultValue: String(item.suggested), confirmLabel: 'Create request', required: true,
    });
    if (!answer) return;
    const quantity = Number(String(answer).replace(/[^0-9.]/g, ''));
    if (!(quantity > 0)) { notify?.('Enter a quantity greater than zero.'); return; }
    act(item.id, () => apiRequest('/purchase-requests', { method: 'POST', body: JSON.stringify({ item_id: item.id, quantity }) }), `Purchase request created for ${item.name}.`);
  };

  const setStatus = async (request, status) => {
    const text = status === 'Received'
      ? `Mark ${request.request} as received?\n\n${qty(request.quantity)} ${request.unit || ''} of ${request.item} will be added to stock.`
      : status === 'Cancelled' ? `Cancel ${request.request}?` : `Mark ${request.request} as ordered from ${request.supplier}?`;
    if (!await confirmDialog(text, { title: status === 'Received' ? 'Receive goods' : status === 'Cancelled' ? 'Cancel request' : 'Mark as ordered', confirmLabel: status === 'Received' ? 'Add to stock' : status === 'Cancelled' ? 'Cancel request' : 'Mark ordered', tone: status === 'Cancelled' ? 'danger' : undefined })) return;
    act(request.id, () => apiRequest(`/purchase-requests/${request.id}/status`, { method: 'POST', body: JSON.stringify({ status }) }), `${request.request} ${status.toLowerCase()}.`);
  };

  return <div className="ins-root">
    <div className="page-heading ins-heading">
      <div><div className="eyebrow">FINANCE</div><h1>Purchasing</h1><p>Items running low, and the purchase requests to restock them.</p></div>
    </div>

    <section className="ins-panel">
      <h2 className="ins-title"><AlertTriangle size={18} />Low stock <small>{lowItems.length} item{lowItems.length === 1 ? '' : 's'} at or below reorder level</small></h2>
      {low.isError && <p className="ins-error">{low.error?.message}</p>}
      {!low.isLoading && !lowItems.length && <p className="ins-empty">Every item is above its reorder level.</p>}
      {lowItems.length > 0 && <div className="ins-table-wrap"><table className="ins-table">
        <thead><tr><th>Item</th><th className="num">On hand</th><th className="num">Reorder at</th><th>Supplier</th><th /></tr></thead>
        <tbody>{lowItems.map(item => <tr key={item.id} className={Number(item.on_hand) <= 0 ? 'is-loss' : ''}>
          <td data-label="Item"><b>{item.name}</b><small>{item.sku}</small></td>
          <td data-label="On hand" className="num"><b>{qty(item.on_hand)}</b> {item.unit}</td>
          <td data-label="Reorder at" className="num">{qty(item.reorder_level)}</td>
          <td data-label="Supplier">{item.supplier || '—'}</td>
          <td data-label="">{item.open_request
            ? <span className="ins-tag">{item.open_request} open</span>
            : <button className="ins-btn primary" disabled={busy === item.id} onClick={() => createRequest(item)}><ShoppingCart size={15} />Create purchase request</button>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>

    <section className="ins-panel">
      <h2 className="ins-title"><Truck size={18} />Purchase requests</h2>
      <div className="ins-filters"><label className="ins-check"><input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} />Show received and cancelled</label></div>
      {requests.isError && <p className="ins-error">{requests.error?.message}</p>}
      {!requests.isLoading && !shown.length && <p className="ins-empty" style={{ marginTop: 12 }}>No open purchase requests.</p>}
      {shown.length > 0 && <div className="ins-table-wrap" style={{ marginTop: 12 }}><table className="ins-table">
        <thead><tr><th>Request</th><th>Item</th><th className="num">Quantity</th><th>Supplier</th><th className="num">Estimated cost</th><th>Status</th><th /></tr></thead>
        <tbody>{shown.map(r => <tr key={r.id}>
          <td data-label="Request"><b className="ins-id">{r.request}</b><small>{shortDate(r.requested)}</small></td>
          <td data-label="Item">{r.item}<small>{r.sku}</small></td>
          <td data-label="Quantity" className="num">{qty(r.quantity)} {r.unit}</td>
          <td data-label="Supplier">{r.supplier}</td>
          <td data-label="Estimated cost" className="num">{money(r.estimated_cost)}</td>
          <td data-label="Status"><Status value={r.status} /></td>
          <td data-label=""><div className="ins-actions">
            {r.status === 'Pending' && <button className="ins-btn" disabled={busy === r.id} onClick={() => setStatus(r, 'Ordered')}><Check size={15} />Ordered</button>}
            {['Pending', 'Ordered'].includes(r.status) && <button className="ins-btn primary" disabled={busy === r.id} onClick={() => setStatus(r, 'Received')}><PackageCheck size={15} />Received</button>}
            {['Pending', 'Ordered'].includes(r.status) && <button className="ins-btn" disabled={busy === r.id} onClick={() => setStatus(r, 'Cancelled')} aria-label="Cancel request" title="Cancel"><X size={15} /></button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>}
      <p className="ins-hint">Receiving a request adds the quantity to stock and records a stock movement. Low stock also shows in notifications once a week until a request is open.</p>
    </section>
  </div>;
}
