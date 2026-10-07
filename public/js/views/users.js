import { api, h } from '../api.js';

const view = document.getElementById('view');
function msgBox() { return h('div', { class: 'msg', role: 'status' }); }
function say(box, text, ok) { box.textContent = text; box.className = 'msg ' + (ok ? 'ok' : 'error'); }

export async function renderUsers() {
  const [users, settings] = await Promise.all([api('GET', '/users'), api('GET', '/settings')]);
  const box = msgBox();
  const reload = () => { view.replaceChildren(); return renderUsers(); };

  const form = h('form', { class: 'grid', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    try {
      await api('POST', '/users', { username: f.get('username'), password: f.get('password'), role: f.get('role') });
      await reload();
    } catch (err) { say(box, err.message); }
  } },
    h('label', {}, 'Username', h('input', { name: 'username', required: true })),
    h('label', {}, 'Password', h('input', { name: 'password', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' })),
    h('label', {}, 'Role', h('select', { name: 'role' }, h('option', { value: 'viewer' }, 'Viewer'), h('option', { value: 'admin' }, 'Admin'))),
    h('label', {}, ' ', h('button', { class: 'primary', type: 'submit' }, 'Add user')));

  const single = h('input', { type: 'checkbox', checked: settings.singleSession, onchange: async () => {
    try { await api('PUT', '/settings', { singleSession: single.checked }); say(box, 'Saved', true); } catch (err) { say(box, err.message); }
  } });

  const act = (fn) => async () => { try { await fn(); await reload(); } catch (err) { say(box, err.message); } };

  view.append(
    h('div', { class: 'card' }, h('h2', {}, 'Add user'), form, box),
    h('div', { class: 'card' }, h('label', { class: 'check' }, single, 'Single session per user (signing in elsewhere signs the user out)')),
    h('div', { class: 'card' }, h('h2', {}, 'Users'),
      h('table', {}, h('thead', {}, h('tr', {}, ['User', 'Role', 'Status', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, users.map((u) => h('tr', {},
          h('td', {}, u.username), h('td', {}, u.role), h('td', {}, u.disabled ? 'Disabled' : 'Active'),
          h('td', { class: 'actions' },
            h('button', { onclick: act(() => api('PUT', '/users/' + u.id, { disabled: !u.disabled })) }, u.disabled ? 'Enable' : 'Disable'), ' ',
            h('button', { onclick: async () => {
              const pw = prompt(`New password for ${u.username} (min 8 characters)`);
              if (!pw) return;
              try { await api('POST', `/users/${u.id}/password`, { password: pw }); say(box, 'Password reset', true); } catch (err) { say(box, err.message); }
            } }, 'Reset password'))))))));
}

