import { useEffect, useState } from 'react';
import { api } from '../api';

const EMPTY = { name: '', username: '', password: '', role: 'sales', ownerEmail: '' };

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

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
      await api('/api/users', { method: 'POST', body: form });
      setNotice(`User "${form.username}" created.`);
      setForm(EMPTY);
      loadUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
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
      <section className="panel">
        <h2>Create user</h2>
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}

        <form className="user-form" onSubmit={handleCreate}>
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
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>Users ({users.length})</h2>
        <table className="tasks">
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Role</th>
              <th>Owner email</th>
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
        </table>
      </section>
    </div>
  );
}
