import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { apiRequest } from '../../api/client.js';
import { lookupRecords } from '../../lib/records.js';

// Issue materials to a job, or record unused materials coming back.
// Items come from the real inventory (previously this listed sample items).
export default function StockMovementDialog({ dialog, onClose, onConfirm }) {
  const inventory = useQuery({ queryKey: ['inventory-options'], queryFn: () => apiRequest('/inventory?limit=500'), staleTime: 60_000 });
  const items = lookupRecords('inventory', inventory.data).map(item => ({
    id: item.id, name: item.name || item.item || item.sku, sku: item.sku || '', onHand: Number(item.qty_on_hand ?? item.on_hand ?? 0), unit: item.unit || 'pcs',
  }));
  // Pre-fill from the request text, e.g. "Bearing 6205 × 4".
  const suggested = String(dialog.row?.[3] || '').match(/(.+?)\s*[×x]\s*(\d+(?:\.\d+)?)/i);
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState(suggested?.[2] || '1');
  const [warehouse, setWarehouse] = useState('Main store');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (itemId || !suggested || !items.length) return;
    const match = items.find(item => item.name.toLowerCase().includes(suggested[1].trim().toLowerCase()));
    if (match) setItemId(String(match.id));
  }, [items.length]);
  const selected = items.find(item => String(item.id) === String(itemId));
  const tooMuch = dialog.movement === 'issue' && selected && Number(quantity) > selected.onHand;
  const title = dialog.movement === 'issue' ? 'Issue materials to job' : 'Return unused materials';

  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="modal">
      <div className="modal-header">
        <div><div className="eyebrow">MATERIAL REQUEST · {dialog.row?.[0]}</div><h2>{title}</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
      </div>
      <div className="record-fields special-fields">
        <label className="wide-field">Inventory item
          <select value={itemId} onChange={event => setItemId(event.target.value)}>
            <option value="">{inventory.isLoading ? 'Loading items…' : 'Choose item'}</option>
            {items.map(item => <option key={item.id} value={item.id}>{item.name}{item.sku ? ` · ${item.sku}` : ''} · {item.onHand} {item.unit} on hand</option>)}
          </select>
        </label>
        <label>Quantity<input type="number" min="0.01" step="0.01" value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
        <label>Warehouse<input value={warehouse} onChange={event => setWarehouse(event.target.value)} /></label>
        <label className="wide-field">Movement note<textarea rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder="Optional issue / return note" /></label>
        {inventory.isError && <p className="form-error wide-field">Could not load inventory: {inventory.error?.message}</p>}
        {tooMuch && <p className="form-error wide-field">Only {selected.onHand} {selected.unit} in stock.</p>}
      </div>
      <div className="modal-footer">
        <button className="secondary-button" onClick={onClose}>Cancel</button>
        <button className="primary-button" disabled={!itemId || Number(quantity) <= 0 || tooMuch} onClick={() => onConfirm({ movementPayload: { item_id: itemId, quantity: Number(quantity), requested_quantity: Number(suggested?.[2] || quantity), warehouse, note } })}>
          {dialog.movement === 'issue' ? 'Post stock issue' : 'Post stock return'}
        </button>
      </div>
    </section>
  </div>;
}
