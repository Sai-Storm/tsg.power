import { useEffect, useState } from 'react';
import { apiRequest } from '../api/client.js';
import { initials } from '../lib/records.js';
import AlertSettings from '../components/AlertSettings.jsx';

export default function ProfilePage({ user, notify }) {
  const [name, setName] = useState(user.name || '');
  const [username, setUsername] = useState(user.username || '');
  const [phone, setPhone] = useState(user.phone || '');
  const [avatar, setAvatar] = useState(user.avatar || '');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [photoError, setPhotoError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(user.name || '');
    setUsername(user.username || '');
    setPhone(user.phone || '');
    setAvatar(user.avatar || '');
  }, [user.id, user.name, user.username, user.phone, user.avatar]);
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
    name.trim().length < 2 ||
    username.trim().length < 3 ||
    Boolean(photoError) ||
    (password !== '' && (password.length < 10 || password !== passwordConfirm));
  const save = async () => {
    setBusy(true);
    try {
      const payload = { name: name.trim(), username: username.trim(), phone: phone.trim(), avatar };
      if (password) payload.password = password;
      {
        const updated = await apiRequest(`/users/${encodeURIComponent(user.id)}`, { method: 'PUT', body: JSON.stringify(payload) });
        const apiUser = updated?.user ? updated : updated || {};
        const nextUser = {
          ...user,
          name: apiUser.user || apiUser.name || payload.name,
          username: apiUser.username || payload.username,
          phone: payload.phone,
          avatar: apiUser.avatar ?? payload.avatar,
        };
        sessionStorage.setItem('tsg_user', JSON.stringify(nextUser));
        window.dispatchEvent(new Event('tsg-user-updated'));
      }
      setPassword('');
      setPasswordConfirm('');
      notify('Profile updated.');
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading module-heading">
        <div>
          <div className="eyebrow">ACCOUNT</div>
          <h1>My profile</h1>
          <p>Keep your contact details, login name and profile picture up to date.</p>
        </div>
        <button className="primary-button" disabled={busy || invalid} onClick={save}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </div>
      <section className="panel profile-panel">
        <div className="profile-summary">
          <span className="account-photo-preview profile-preview">
            {avatar ? <img src={avatar} alt={`${name || 'Your'} profile`} /> : initials(name || user.name)}
          </span>
          <div>
            <h2>{name || user.name}</h2>
            <p>
              {user.role} account · {user.email}
            </p>
            <span className="profile-meta">
              {username ? `@${username}` : 'No username set'}
              {phone ? ` · ${phone}` : ''}
            </span>
          </div>
        </div>
        <div className="record-fields special-fields profile-fields">
          <label>
            Full name
            <input value={name} onChange={event => setName(event.target.value)} placeholder="Your full name" />
          </label>
          <label>
            Username
            <input autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} placeholder="Login username" />
          </label>
          <label>
            Phone number
            <input type="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="Your phone number" />
          </label>
          <label>
            Email
            <input value={user.email || ''} readOnly aria-readonly="true" />
            <small>Your login email is managed by an administrator.</small>
          </label>
          <label>
            Role
            <input value={user.role} readOnly aria-readonly="true" />
            <small>Contact an administrator to change your role or employment details.</small>
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
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              autoComplete="new-password"
              value={passwordConfirm}
              onChange={event => setPasswordConfirm(event.target.value)}
              placeholder="Repeat new password"
            />
          </label>
          <label className="wide-field">
            Profile picture
            <input type="file" accept="image/*" onChange={event => loadPhoto(event.target.files?.[0])} />
            <small>JPG, PNG or WebP up to 1.5 MB. A square image works best.</small>
          </label>
          {avatar && (
            <div className="account-photo-field wide-field">
              <span className="account-photo-preview">
                <img src={avatar} alt="Profile preview" />
              </span>
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
            </div>
          )}
          {photoError && <p className="form-error wide-field">{photoError}</p>}
          {password && passwordConfirm && password !== passwordConfirm && <p className="form-error wide-field">Passwords do not match.</p>}
          {password && password.length < 10 && <p className="form-error wide-field">Use at least 10 characters for the new password.</p>}
        </div>
        <div className="profile-actions">
          <button className="primary-button" disabled={busy || invalid} onClick={save}>
            {busy ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </section>
      <AlertSettings notify={notify} />
    </>
  );
}
