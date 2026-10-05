import { useEffect, useState } from 'react';
import { api } from '../api';
import Section from './ui/Section';
import DataTable from './ui/DataTable';
import '../styles/views/reports.css';

const EMPTY = { name: '', username: '', password: '', role: 'sales', ownerEmail: '', email: '' };

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);

  async function loadUsers() {
    try {
      const { users } = await api('/api/users');
      setUsers(users);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const body = { ...form, email: form.email.trim() };
      if (!body.email) delete body.email;
      await api('/api/users', { method: 'POST', body });
      setNotice(`User "${form.username}" created.`);
      setForm(EMPTY);
      loadUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(u) {
    setEditingId(u.id);
    setEditValue(u.email || '');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue('');
  }

  async function saveEmail(u) {
    setError('');
    setNotice('');
    setSavingEmail(true);
    try {
      const { user } = await api(`/api/users/${u.id}`, {
        method: 'PATCH',
        body: { email: editValue.trim() },
      });
      setUsers((list) => list.map((x) => (x.id === user.id ? user : x)));
      setNotice(`Login email for "${user.username}" updated.`);
      cancelEdit();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingEmail(false);
    }
  }

  async function handleDelete(id, username) {
    if (!window.confirm(`Delete user "${username}"?`)) return;
    setError('');
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' });
      loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="admin-users">
      <Section title="Create user">
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}

        <form className="admin-user-form" onSubmit={handleCreate}>
          <label>
            Full name
            <input value={form.name} onChange={(e) => update('name', e.target.value)} required />
          </label>
          <label>
            Username
            <input
              value={form.username}
              onChange={(e) => update('username', e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="text"
              value={form.password}
              onChange={(e) => update('password', e.target.value)}
              required
            />
          </label>
          <label>
            Role
            <select value={form.role} onChange={(e) => update('role', e.target.value)}>
              <option value="sales">Sales</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label>
            Owner email (Zoho)
            <input
              type="email"
              value={form.ownerEmail}
              placeholder="matches Owner.email in the webhook"
              onChange={(e) => update('ownerEmail', e.target.value)}
              disabled={form.role === 'admin'}
              required={form.role === 'sales'}
            />
          </label>
          <label>
            Login email (Google)
            <input
              type="email"
              value={form.email}
              placeholder="blank = same as Zoho owner email"
              title="Optional. If left blank, defaults to the Zoho owner email."
              onChange={(e) => update('email', e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </form>
      </Section>

      <Section title={`Users (${users.length})`} flush>
        <DataTable>
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Role</th>
              <th>Owner email</th>
              <th>Email</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.username}</td>
                <td>
                  <span className={`badge ${u.role === 'admin' ? 'badge-high' : 'badge-normal'}`}>
                    {u.role}
                  </span>
                </td>
                <td className="subtle">{u.ownerEmail || '—'}</td>
                <td className="subtle">
                  {editingId === u.id ? (
                    <div className="email-edit">
                      <input
                        type="email"
                        value={editValue}
                        autoFocus
                        disabled={savingEmail}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            saveEmail(u);
                          } else if (e.key === 'Escape') {
                            cancelEdit();
                          }
                        }}
                      />
                      <button
                        className="link-accent"
                        onClick={() => saveEmail(u)}
                        disabled={savingEmail}
                      >
                        {savingEmail ? 'Saving…' : 'Save'}
                      </button>
                      <button className="link-accent" onClick={cancelEdit} disabled={savingEmail}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      {u.email || '—'}{' '}
                      <button className="link-accent" onClick={() => startEdit(u)}>
                        Edit
                      </button>
                    </>
                  )}
                </td>
                <td>
                  {u.role !== 'admin' && (
                    <button className="link-danger" onClick={() => handleDelete(u.id, u.username)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Section>
    </div>
  );
}
