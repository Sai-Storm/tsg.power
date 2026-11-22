import { useState } from 'react';
import { X } from 'lucide-react';

export default function SalaryPaymentDialog({ dialog, onClose, onConfirm }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('Bank transfer');
  const [notes, setNotes] = useState('');
  return (
    <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="modal">
        <div className="modal-header">
          <div>
            <div className="eyebrow">SALARY · {dialog.row?.[0]}</div>
            <h2>Mark salary as paid</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        <div className="record-fields special-fields">
          <div className="job-total-preview wide-field">
            <span>Net pay</span>
            <b>{dialog.row?.[3] || '—'}</b>
            <small>
              {dialog.row?.[1]} · {dialog.row?.[2]}
            </small>
          </div>
          <label>
            Payment date
            <input type="date" value={date} onChange={event => setDate(event.target.value)} />
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
            Notes
            <textarea
              rows={2}
              value={notes}
              onChange={event => setNotes(event.target.value)}
              placeholder="Optional payment reference or remarks"
            />
          </label>
          <p className="wide-field">
            Confirming payment marks this salary paid and automatically generates a salary voucher in Expenses & cash.
          </p>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={!date} onClick={() => onConfirm({ salaryPayment: { date, method, notes } })}>
            Confirm payment
          </button>
        </div>
      </section>
    </div>
  );
}
