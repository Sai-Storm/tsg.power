import { useState } from 'react';
import { X } from 'lucide-react';
import { initials } from '../../lib/records.js';

export default function StaffProfileDialog({ dialog, columns = [], onClose, onConfirm }) {
  const profile = dialog.profile || {};
  const record = dialog.row?._record || {};
  const phoneIndex = columns.findIndex(column => /phone/i.test(column));
  const [name, setName] = useState(profile.name || profile.user || record.name || dialog.row?.[0] || '');
  const [phone, setPhone] = useState(profile.phone || record.phone || dialog.row?.[phoneIndex] || '');
  const [email, setEmail] = useState(record.email || profile.email || '');
  const [username, setUsername] = useState(profile.username || '');
  const [password, setPassword] = useState('');
  const [avatar, setAvatar] = useState(profile.avatar || '');
  const [photoError, setPhotoError] = useState('');
  const linked = Boolean(profile.id || record.profile_id);
  const loadPhoto = file => {
    if (!file) {
      setAvatar('');
      setPhotoError('');
      return;
    }
    if (!/^image\//.test(file.type)) {
      setPhotoError('Choose an image file (JPG, PNG or WebP).');
      return;
    }
    if (file.size > 1.5 * 1024 * 1024) {
      setPhotoError('Choose an image smaller than 1.5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAvatar(String(reader.result || ''));
      setPhotoError('');
    };
    reader.readAsDataURL(file);
  };
  const invalid =
    name.trim().length < 2 || Boolean(photoError) || (linked && username.trim().length < 3) || (password !== '' && password.length < 10);
  return (
    <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="modal">
        <div className="modal-header">
          <div>
            <div className="eyebrow">STAFF PROFILE · {dialog.row?.[0]}</div>
            <h2>Update staff profile</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        <div className="record-fields special-fields">
          <div className="account-photo-field wide-field">
            <span className="account-photo-preview">
              {avatar ? <img src={avatar} alt={`${name || 'Staff'} profile`} /> : initials(name || dialog.row?.[0])}
            </span>
            <div className="account-photo-editor">
              <label>
                Profile picture
                <input type="file" accept="image/*" onChange={event => loadPhoto(event.target.files?.[0])} />
                <small>JPG, PNG or WebP up to 1.5 MB. Square images work best.</small>
              </label>
              {avatar && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setAvatar('');
                    setPhotoError('');
                  }}
                >
                  Remove photo
                </button>
              )}
            </div>
          </div>
          <label>
            Full name
            <input value={name} onChange={event => setName(event.target.value)} placeholder="Staff member name" />
          </label>
          <label>
            Phone number
            <input type="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="Phone number" />
          </label>
          <label>
            Contact email
            <input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@company.com" />
            <small>Used as the staff contact email. Login email is managed separately.</small>
          </label>
          {linked && (
            <>
              <label>
                Username
                <input
                  autoComplete="off"
                  value={username}
                  onChange={event => setUsername(event.target.value)}
                  placeholder="Login username"
                />
              </label>
              <label>
                New password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  placeholder="Leave blank to keep current"
                />
                <small>Optional. Use at least 10 characters.</small>
              </label>
            </>
          )}
          {photoError && <p className="form-error wide-field">{photoError}</p>}
          <p className="wide-field">
            {linked
              ? 'These details update the staff record and the linked login profile. Administrators can reset the password here.'
              : 'This staff record is not linked to a login account yet. Name, phone and contact email will be saved on the staff record.'}
          </p>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={invalid}
            onClick={() =>
              onConfirm({
                staffProfile: { name: name.trim(), phone: phone.trim(), email: email.trim(), username: username.trim(), password, avatar },
              })
            }
          >
            Save profile
          </button>
        </div>
      </section>
    </div>
  );
}
