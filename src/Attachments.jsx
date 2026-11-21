import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, ImageOff, X } from 'lucide-react';
import { attachmentPath, resolveAttachmentUrl } from './api/client.js';
import './attachments.css';

// Fields that hold uploaded files (receipts, photos, evidence, signatures…).
const FILE_KEY = /receipt|attachment|photo|image|picture|evidence|document|signature|proof|file/i;
const LABELS = { receipt_file: 'Receipt', attachment: 'Attachment', attachments: 'Attachments', acceptance_evidence: 'Acceptance evidence', customer_signature: 'Customer signature', technician_signature: 'Technician signature', photos: 'Photos', documents: 'Documents' };
const label = key => LABELS[key] || key.replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());

export const looksLikeFile = value => {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^data:(image|application\/pdf)/i.test(text)) return true;
  if (attachmentPath(text)) return true;
  return /^https?:\/\/\S+\.(png|jpe?g|gif|webp|heic|bmp|pdf)(\?|#|$)/i.test(text);
};
const isPdf = url => /^data:application\/pdf/i.test(url) || /\.pdf$/i.test(String(url).split(/[?#]/)[0]);

const flatten = value => {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (typeof value === 'object') return flatten(value.url ?? value.path ?? value.file ?? value.src ?? null);
  if (typeof value === 'string' && /^\s*\[/.test(value)) { try { return flatten(JSON.parse(value)); } catch { /* plain text */ } }
  return looksLikeFile(value) ? [String(value).trim()] : [];
};

// Every uploaded file found on a record, grouped by field.
export function collectAttachments(record) {
  if (!record || typeof record !== 'object') return [];
  const groups = [];
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('_') || key === 'avatar' || key === 'profile_picture') continue;
    const files = flatten(value);
    if (files.length && (FILE_KEY.test(key) || files.every(looksLikeFile))) groups.push({ key, label: label(key), files: [...new Set(files)] });
  }
  return groups;
}

function useResolved(url) {
  const [state, setState] = useState({ url: /^(data:|blob:)/i.test(url) ? url : '', failed: false });
  useEffect(() => {
    let alive = true;
    if (/^(data:|blob:)/i.test(url)) { setState({ url, failed: false }); return undefined; }
    resolveAttachmentUrl(url).then(resolved => alive && setState({ url: resolved || url, failed: false })).catch(() => alive && setState({ url, failed: false }));
    return () => { alive = false; };
  }, [url]);
  return [state, () => setState(old => ({ ...old, failed: true }))];
}

function Thumb({ url, name, onOpen }) {
  const [{ url: src, failed }, markFailed] = useResolved(url);
  if (isPdf(url)) return <a className="att-file" href={src || undefined} target="_blank" rel="noreferrer"><FileText size={22} /><span>{name}</span><small>PDF · open</small></a>;
  if (!src) return <span className="att-thumb att-loading" aria-label="Loading picture" />;
  if (failed) return <a className="att-file att-broken" href={src} target="_blank" rel="noreferrer"><ImageOff size={22} /><span>{name}</span><small>Could not preview · open</small></a>;
  return <button type="button" className="att-thumb" onClick={() => onOpen(src, name)} title={`View ${name}`}><img src={src} alt={name} loading="lazy" onError={markFailed} /></button>;
}

export function AttachmentGallery({ groups, title = 'Uploaded files', emptyText }) {
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = event => event.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!groups?.length) return emptyText ? <p className="att-empty">{emptyText}</p> : null;
  return <div className="att-gallery">
    {title && <h4>{title}</h4>}
    {groups.map(group => <div className="att-group" key={group.key}>
      <span className="att-label">{group.label}{group.files.length > 1 ? ` (${group.files.length})` : ''}</span>
      <div className="att-row">{group.files.map((url, index) => <Thumb key={url} url={url} name={`${group.label}${group.files.length > 1 ? ` ${index + 1}` : ''}`} onOpen={(src, name) => setOpen({ src, name })} />)}</div>
    </div>)}
    {open && createPortal(<div className="att-lightbox" role="dialog" aria-label={open.name} onMouseDown={event => event.target === event.currentTarget && setOpen(null)}>
      <div className="att-lightbox-bar"><b>{open.name}</b><a href={open.src} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open full size</a><button type="button" onClick={() => setOpen(null)} aria-label="Close picture"><X size={18} /></button></div>
      <img src={open.src} alt={open.name} />
    </div>, document.body)}
  </div>;
}

// Small inline "receipt" cell used in tables.
export function ReceiptLink({ url, name = 'Receipt' }) {
  return <AttachmentGallery title="" groups={url ? [{ key: 'receipt', label: name, files: [url] }] : []} />;
}
