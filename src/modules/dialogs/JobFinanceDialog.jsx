import { useState } from 'react';
import { X } from 'lucide-react';

export default function JobFinanceDialog({ dialog, onClose, onConfirm }) {
  const isInvoice = dialog.type === 'job-invoice';
  const isCancel = dialog.type === 'job-cancel';
  const [reason, setReason] = useState('');
  const [subtotal, setSubtotal] = useState('');
  const [charges, setCharges] = useState('0');
  const [discount, setDiscount] = useState('0');
  const [amountPaid, setAmountPaid] = useState('0');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('Due on receipt');
  const [paymentStatus, setPaymentStatus] = useState('Pending Payment');
  const [paymentAmount, setPaymentAmount] = useState('0');
  const total = Math.max(0, Number(subtotal || 0) + Number(charges || 0) - Number(discount || 0));
  const disabled = isCancel ? !reason.trim() : isInvoice ? !dueDate : paymentStatus === 'Pending Payment' && !dueDate;
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <section className="modal job-finance-modal">
        <div className="modal-header">
          <div>
            <div className="eyebrow">JOB ORDER / {dialog.row?.[0]}</div>
            <h2>{isCancel ? 'Cancel job order' : isInvoice ? 'Create job invoice' : 'Close job order'}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        {isCancel ? (
          <div className="record-fields special-fields">
            <label className="wide-field">
              Reason for cancellation
              <textarea
                rows={4}
                required
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Explain why this job is being cancelled"
              />
            </label>
          </div>
        ) : isInvoice ? (
          <div className="record-fields special-fields">
            <label>
              Job value
              <input type="number" value={subtotal} onChange={e => setSubtotal(e.target.value)} placeholder="0.00" />
            </label>
            <label>
              Additional charges
              <input type="number" value={charges} onChange={e => setCharges(e.target.value)} />
            </label>
            <label>
              Discount
              <input type="number" value={discount} onChange={e => setDiscount(e.target.value)} />
            </label>
            <label>
              Invoice date
              <input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} />
            </label>
            <label>
              Due date
              <input type="date" required value={dueDate} onChange={e => setDueDate(e.target.value)} />
            </label>
            <label>
              Payment terms
              <select value={paymentTerms} onChange={e => setPaymentTerms(e.target.value)}>
                <option>Due on receipt</option>
                <option>7 days</option>
                <option>15 days</option>
                <option>30 days</option>
                <option>Custom</option>
              </select>
            </label>
            <label>
              Cash received
              <input type="number" value={amountPaid} onChange={e => setAmountPaid(e.target.value)} />
            </label>
            <div className="job-total-preview">
              <span>Invoice total</span>
              <b>MMK {total.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b>
              <small>
                {Number(amountPaid) >= total
                  ? 'Paid in full'
                  : Number(amountPaid) > 0
                    ? `Balance MMK ${(total - Number(amountPaid)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                    : 'Payment pending'}
              </small>
            </div>
          </div>
        ) : (
          <div className="record-fields special-fields">
            <div className="job-checklist is-ready">
              <b>Ready to close</b>
              <span>[x] Approved completion report</span>
              <span>[x] Invoice generated</span>
            </div>
            <label>
              Payment status
              <select value={paymentStatus} onChange={e => setPaymentStatus(e.target.value)}>
                <option>Pending Payment</option>
                <option>Paid</option>
              </select>
            </label>
            <label>
              {paymentStatus === 'Paid' ? 'Cash received' : 'Payment received so far'}
              <input type="number" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} />
            </label>
            <label>
              Payment due date
              <input
                type="date"
                required={paymentStatus === 'Pending Payment'}
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
              />
            </label>
          </div>
        )}
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={disabled}
            onClick={() =>
              onConfirm(
                isCancel
                  ? { reason }
                  : isInvoice
                    ? {
                        customerId: dialog.row?._record?.customer_id,
                        subtotal: Number(subtotal),
                        charges: Number(charges),
                        discount: Number(discount),
                        total,
                        amountPaid: Number(amountPaid),
                        invoiceDate,
                        dueDate,
                        paymentTerms,
                      }
                    : { paymentStatus, paymentAmount: Number(paymentAmount), dueDate },
              )
            }
          >
            {isCancel ? 'Cancel job' : isInvoice ? 'Generate invoice' : 'Close job'}
          </button>
        </div>
      </section>
    </div>
  );
}
