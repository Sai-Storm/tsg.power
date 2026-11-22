import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

// In-app replacement for window.confirm / window.prompt / window.alert.
// Mount <AskHost /> once; then from anywhere:
//   if (await confirmDialog('Delete this?', { tone: 'danger', confirmLabel: 'Delete' })) …
//   const reason = await promptDialog('Why?', { required: true });   // null when cancelled
//   await alertDialog('Pop-up blocked');

let listener = null;
const queue = [];

function ask(options) {
  return new Promise(resolve => {
    queue.push({ ...options, resolve });
    listener?.();
  });
}

export const confirmDialog = (message, options = {}) => ask({ title: 'Please confirm', confirmLabel: 'Confirm', ...options, message, kind: 'confirm' });
export const promptDialog = (message, options = {}) => ask({ title: 'Add a note', confirmLabel: 'Save', ...options, message, kind: 'prompt' });
export const alertDialog = (message, options = {}) => ask({ title: 'Notice', confirmLabel: 'OK', ...options, message, kind: 'alert' });

export function AskHost() {
  const [current, setCurrent] = useState(null);
  const [value, setValue] = useState('');
  const inputRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    listener = () => setCurrent(existing => {
      if (existing || !queue.length) return existing;
      const next = queue.shift();
      setValue(next.defaultValue || '');
      return next;
    });
    listener();
    return () => { listener = null; };
  }, []);

  useEffect(() => {
    if (!current) return undefined;
    const focus = window.setTimeout(() => (current.kind === 'prompt' ? inputRef.current : confirmRef.current)?.focus(), 30);
    const onKey = event => { if (event.key === 'Escape') finish(false); };
    window.addEventListener('keydown', onKey);
    return () => { window.clearTimeout(focus); window.removeEventListener('keydown', onKey); };
  }, [current]);

  if (!current) return null;

  function finish(accepted) {
    const item = current;
    if (item.kind === 'prompt') item.resolve(accepted ? value : null);
    else if (item.kind === 'alert') item.resolve(true);
    else item.resolve(Boolean(accepted));
    setCurrent(null);
    window.setTimeout(() => listener?.(), 0);
  }

  const invalid = current.kind === 'prompt' && current.required && !value.trim();
  const lines = String(current.message || '').split('\n');
  return <div className="modal-backdrop ask-backdrop" onMouseDown={event => event.target === event.currentTarget && finish(false)}>
    <section className="modal ask-modal" role="alertdialog" aria-modal="true" aria-labelledby="ask-title">
      <div className="modal-header">
        <h2 id="ask-title">{current.title}</h2>
        <button className="icon-button" onClick={() => finish(false)} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="ask-body">
        {lines.map((line, index) => (line ? <p key={index}>{line}</p> : <span key={index} className="ask-gap" />))}
        {current.kind === 'prompt' && <label className="ask-input">{current.label || 'Your answer'}
          {current.multiline
            ? <textarea ref={inputRef} rows={3} value={value} placeholder={current.placeholder || ''} onChange={event => setValue(event.target.value)} />
            : <input ref={inputRef} value={value} placeholder={current.placeholder || ''} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !invalid) finish(true); }} />}
          {current.required && <small>Required</small>}
        </label>}
      </div>
      <div className="modal-footer">
        {current.kind !== 'alert' && <button className="secondary-button" onClick={() => finish(false)}>{current.cancelLabel || 'Cancel'}</button>}
        <button ref={confirmRef} className={current.tone === 'danger' ? 'danger-button' : 'primary-button'} disabled={invalid} onClick={() => finish(true)}>{current.confirmLabel}</button>
      </div>
    </section>
  </div>;
}
