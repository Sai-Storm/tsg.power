import { Camera, Plus } from 'lucide-react';
import { emptyItems, emptyMaterials, emptyRequestItems } from '../formSchemas.js';

export function readFormValues(fields, row, columns) {
  const columnFor = {
    name: 'Customer',
    supplier_name: 'Supplier',
    contact_person: 'Contact',
    phone: 'Phone',
    email: 'Email',
    address: 'Location',
    tax_number: 'GST number',
    category: 'Category',
    job_id: 'Job order',
    customer_id: 'Customer',
    machine_id: 'Machine',
    quotation_id: 'Quotation',
    assigned_to: 'Assigned to',
    due_date: 'Due date',
    date: 'Date',
    status: 'Status',
    amount: 'Amount',
    description: 'Description',
    purpose: 'Purpose',
    work_done: 'Work done',
    findings: 'Findings',
    parts_used: 'Parts used',
  };
  return Object.fromEntries(
    fields.map(field => {
      let value = row?._record?.[field.key] ?? row?._record?.[field.key.replace(/_([a-z])/g, (_, char) => char.toUpperCase())];
      if (value == null && row) {
        const index = columns.findIndex(label => label.toLowerCase() === String(columnFor[field.key] || field.label).toLowerCase());
        if (index >= 0) value = row[index];
      }
      if (field.type === 'number' && typeof value === 'string') value = value.replace(/[^0-9.-]/g, '');
      if (field.key === 'type' && typeof value === 'string') value = value.replace(/^cash\s+/i, '');
      if (field.type === 'items') value = Array.isArray(value) ? value : emptyItems();
      if (field.type === 'request-items') value = Array.isArray(value) ? value : emptyRequestItems();
      if (field.type === 'materials') value = Array.isArray(value) ? value : emptyMaterials();
      if (field.type === 'lookup-multiple') value = Array.isArray(value) ? value : [];
      if (field.type === 'file') value = '';
      if ((field.type === 'date' || field.type === 'datetime-local') && value)
        value = String(value).slice(0, field.type === 'date' ? 10 : 16);
      return [field.key, value ?? field.defaultValue ?? ''];
    }),
  );
}

export default function FormField({ field, value, onChange, options = [] }) {
  const required = field.required || false;
  if (field.type === 'section') return <div className="form-section-heading">{field.label}</div>;
  if (field.type === 'readonly')
    return (
      <label className="form-field autofilled-field">
        {field.label}
        <input value={value || ''} readOnly aria-readonly="true" placeholder={field.placeholder || 'Filled automatically'} />
        <small>Auto-filled from the selected record or calculated for you.</small>
      </label>
    );
  if (field.type === 'items')
    return (
      <div className="line-items-field">
        <div className="line-items-title">
          <span className="field-label">{field.label}{required && <b aria-hidden="true">*</b>}</span>
        </div>
        {(Array.isArray(value) ? value : []).map((item, index) => (
          <div className="line-item-row priced-line" key={index}>
            <input
              aria-label={`${field.label} item ${index + 1}`}
              required={required && index === 0}
              value={item.description || ''}
              placeholder="Service or material"
              onChange={e => onChange(value.map((entry, i) => (i === index ? { ...entry, description: e.target.value } : entry)))}
            />
            <input
              aria-label="Quantity"
              type="number"
              min="0.01"
              step="0.01"
              value={item.qty ?? 1}
              onChange={e => onChange(value.map((entry, i) => (i === index ? { ...entry, qty: Number(e.target.value) } : entry)))}
            />
            <input
              aria-label="Unit"
              value={item.unit || ''}
              placeholder="Unit"
              onChange={e => onChange(value.map((entry, i) => (i === index ? { ...entry, unit: e.target.value } : entry)))}
            />
            <input
              aria-label="Unit price"
              type="number"
              value={item.unit_price ?? ''}
              placeholder="Unit price"
              onChange={e => onChange(value.map((entry, i) => (i === index ? { ...entry, unit_price: Number(e.target.value) } : entry)))}
            />
            <input
              aria-label="Line discount"
              type="number"
              value={item.discount ?? 0}
              placeholder="Discount"
              onChange={e => onChange(value.map((entry, i) => (i === index ? { ...entry, discount: Number(e.target.value) } : entry)))}
            />
            <button
              type="button"
              className="row-action-danger"
              onClick={() =>
                onChange(
                  value.length > 1
                    ? value.filter((_, i) => i !== index)
                    : [{ description: '', qty: 1, unit: 'pcs', unit_price: '', discount: 0 }],
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary-button add-line-item"
          onClick={() => onChange([...value, { description: '', qty: 1, unit: 'pcs', unit_price: '', discount: 0 }])}
        >
          <Plus size={13} />
          Add line
        </button>
      </div>
    );
  if (field.type === 'request-items')
    return (
      <div className="line-items-field">
        <div className="line-items-title">
          <span className="field-label">{field.label}{required && <b aria-hidden="true">*</b>}</span>
        </div>
        {(Array.isArray(value) ? value : []).map((item, index) => (
          <div className="line-item-row request-line" key={index}>
            <select
              aria-label="Inventory item"
              value={item.item_id || ''}
              onChange={e => {
                const picked = options.find(option => option.value === e.target.value);
                onChange(
                  value.map((entry, i) => (i === index ? { ...entry, item_id: e.target.value, description: picked?.label || '' } : entry)),
                );
              }}
            >
              <option value="">Select inventory item</option>
              {options.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              aria-label="Description"
              value={item.description || ''}
              placeholder="Specification"
              onChange={e => onChange(value.map((entry, i) => (i === index ? { ...entry, description: e.target.value } : entry)))}
            />
            <input
              aria-label="Requested quantity"
              type="number"
              min="0.01"
              step="0.01"
              value={item.qty ?? 1}
              onChange={e => onChange(value.map((entry, i) => (i === index ? { ...entry, qty: Number(e.target.value) } : entry)))}
            />
            <input
              aria-label="Unit"
              value={item.unit || ''}
              onChange={e => onChange(value.map((entry, i) => (i === index ? { ...entry, unit: e.target.value } : entry)))}
            />
            <button
              type="button"
              className="row-action-danger"
              onClick={() =>
                onChange(value.length > 1 ? value.filter((_, i) => i !== index) : [{ item_id: '', description: '', qty: 1, unit: 'pcs' }])
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary-button add-line-item"
          onClick={() => onChange([...value, { item_id: '', description: '', qty: 1, unit: 'pcs' }])}
        >
          <Plus size={13} />
          Add requested item
        </button>
      </div>
    );
  if (field.type === 'lookup-multiple')
    return (
      <label className="form-field">
        <span className="field-label">{field.label}{required && <b aria-hidden="true">*</b>}</span>
        <select
          multiple
          required={required}
          value={Array.isArray(value) ? value : []}
          onChange={e => onChange(Array.from(e.target.selectedOptions, option => option.value))}
        >
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  if (field.type === 'materials')
    return (
      <div className="line-items-field materials-field">
        <div className="line-items-title">{field.label}</div>
        {(Array.isArray(value) ? value : []).map((item, index) => (
          <div className="materials-row" key={index}>
            <select
              aria-label="Inventory item"
              value={item.item_id || ''}
              onChange={e => onChange(value.map((entry, i) => (i === index ? { ...entry, item_id: e.target.value } : entry)))}
            >
              <option value="">Choose inventory item</option>
              {options.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {[
              ['required_qty', 'Required'],
              ['issued_qty', 'Issued'],
              ['used_qty', 'Used'],
              ['returned_qty', 'Returned'],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={item[key] ?? 0}
                  onChange={e => onChange(value.map((entry, i) => (i === index ? { ...entry, [key]: Number(e.target.value) } : entry)))}
                />
              </label>
            ))}
            <button
              type="button"
              className="row-action-danger"
              onClick={() => onChange(value.length > 1 ? value.filter((_, i) => i !== index) : emptyMaterials())}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary-button add-line-item"
          onClick={() => onChange([...value, { item_id: '', required_qty: 1, issued_qty: 0, used_qty: 0, returned_qty: 0 }])}
        >
          <Plus size={13} />
          Add material
        </button>
      </div>
    );
  if (field.type === 'textarea')
    return (
      <label className="form-field wide-field">
        <span className="field-label">{field.label}{required && <b aria-hidden="true">*</b>}</span>
        <textarea
          required={required}
          rows={3}
          value={value || ''}
          placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
          onChange={e => onChange(e.target.value)}
        />
      </label>
    );
  if (field.type === 'file') {
    const files = Array.isArray(value) ? value : value ? [value] : [];
    const add = list => onChange(field.multiple ? [...files, ...list] : list[0] || '');
    return (
      <div className="form-field file-field">
        <span className="file-field-label">
          <span className="field-label">{field.label}{required && <b aria-hidden="true">*</b>}</span>
        </span>
        <div className="file-field-buttons">
          <label className="secondary-button file-pick">
            Choose file{field.multiple ? 's' : ''}
            <input
              type="file"
              multiple={field.multiple}
              accept={field.accept}
              onChange={e => {
                add(Array.from(e.target.files || []));
                e.target.value = '';
              }}
            />
          </label>
          {field.camera && (
            <label className="secondary-button file-pick">
              <Camera size={15} />
              Take photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={e => {
                  add(Array.from(e.target.files || []));
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
        {files.length > 0 ? (
          <ul className="file-field-list">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`}>
                <span>{file.name || 'File'}</span>
                <button type="button" onClick={() => onChange(field.multiple ? files.filter((_, i) => i !== index) : '')}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <small>{field.multiple ? 'Add one or more files' : 'Choose a file to attach'}</small>
        )}
      </div>
    );
  }
  if (field.type === 'select' || field.type === 'lookup')
    return (
      <label className="form-field">
        <span className="field-label">{field.label}{required && <b aria-hidden="true">*</b>}</span>
        <select required={required} value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">Choose {field.label.toLowerCase()}</option>
          {(field.options || options).map(option => {
            const entry = typeof option === 'string' ? { value: option, label: option } : option;
            return (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            );
          })}
        </select>
      </label>
    );
  return (
    <label className="form-field">
      <span className="field-label">{field.label}{required && <b aria-hidden="true">*</b>}</span>
      <input
        type={field.type || 'text'}
        required={required}
        min={field.money ? undefined : field.min}
        max={field.money ? undefined : field.max}
        step={field.money ? undefined : field.step}
        value={value || ''}
        placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
        onChange={e => onChange(e.target.value)}
      />
    </label>
  );
}
