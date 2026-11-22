import { useState } from 'react';
import { X } from 'lucide-react';

export default function AdvanceIssueDialog({ dialog, onClose, onConfirm }) {
  const requested = Number(String(dialog.row?.[4] || '').replace(/[^0-9.]/g, ''));
  const [amount, setAmount] = useState(String(requested || ''));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('Bank transfer');
  const [purpose, setPurpose] = useState('');
  return (
    <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="modal">
        <div className="modal-header">
          <div>
            <div className="eyebrow">ADVANCE · {dialog.row?.[0]}</div>
            <h2>Release advance money</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        <div className="record-fields special-fields">
          <label>
            Issue date
            <input type="date" value={date} onChange={event => setDate(event.target.value)} />
          </label>
          <label>
            Approved amount
            <input type="number" value={amount} onChange={event => setAmount(event.target.value)} />
          </label>
          <label>
            Payment method
            <select value={method} onChange={event => setMethod(event.target.value)}>
              <option>Bank transfer</option>
              <option>Cash</option>
              <option>Cheque</option>
            </select>
          </label>
          <label className="wide-field">
            Payment voucher reference
            <input value={purpose} onChange={event => setPurpose(event.target.value)} placeholder="Voucher / transfer reference" />
          </label>
          <p className="wide-field">
            Record the actual payment to the staff member. They can then record expenses against this advance and its job order.
          </p>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={!String(amount).trim() || !purpose.trim()}
            onClick={() => onConfirm({ issue: { amount: Number(amount), date, method, reference: purpose, purpose } })}
          >
            Record payment
          </button>
        </div>
      </section>
    </div>
  );
}
