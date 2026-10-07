import { api, h } from '../api.js';

const view = document.getElementById('view');
function msgBox() { return h('div', { class: 'msg', role: 'status' }); }
function say(box, text, ok) { box.textContent = text; box.className = 'msg ' + (ok ? 'ok' : 'error'); }

export async function renderConnections() {
  const list = await api('GET', '/connections');
  const box = msgBox();
  const reload = () => { view.replaceChildren(); return renderConnections(); };
  let editing = null;

  const field = (label, name, attrs = {}) => h('label', {}, label, h('input', { name, ...attrs }));
  const form = h('form', { class: 'grid', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const body = {
      name: f.get('name'), type: f.get('type'), host: f.get('host'), port: f.get('port'), database: f.get('database'),
      username: f.get('username'), password: f.get('password'), trustServerCert: f.get('trustServerCert') === 'on',
    };
    try {
      if (editing) await api('PUT', '/connections/' + editing, body); else await api('POST', '/connections', body);
      await reload();
    } catch (err) { say(box, err.message); }
  } },
    field('Name', 'name', { required: true }),
    h('label', {}, 'Type', h('select', { name: 'type' }, h('option', { value: 'mssql' }, 'MSSQL'), h('option', { value: 'mysql' }, 'MySQL'))),
    field('Host / IP', 'host', { required: true }),
    field('Port (blank = default)', 'port', { type: 'number', min: 1, max: 65535 }),
    field('Database', 'database', { required: true }),
    field('Username', 'username', { required: true, autocomplete: 'off' }),
    field('Password', 'password', { type: 'password', autocomplete: 'new-password', placeholder: 'blank keeps current' }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'trustServerCert' }), 'Trust server certificate (MSSQL)'),
    h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit', id: 'save' }, 'Save connection'),
      h('button', { type: 'button', onclick: () => { editing = null; form.reset(); form.querySelector('#save').textContent = 'Save connection'; } }, 'Clear')));

  const edit = (c) => {
    editing = c.id;
    for (const [k, v] of Object.entries({ name: c.name, type: c.type, host: c.host, port: c.port, database: c.database, username: c.username, password: '' })) form.elements[k].value = v;
    form.elements.trustServerCert.checked = c.trustServerCert;
    form.querySelector('#save').textContent = 'Update connection';
    form.scrollIntoView({ behavior: 'smooth' });
  };

  const test = async (c, btn) => {
    btn.disabled = true; say(box, `Testing ${c.name}...`, true);
    try { const r = await api('POST', `/connections/${c.id}/test`); say(box, `${c.name}: ${r.message}`, r.ok); }
    catch (err) { say(box, err.message); }
    btn.disabled = false;
  };

  const del = async (c) => {
    if (!confirm(`Delete connection "${c.name}"?`)) return;
    try { await api('DELETE', '/connections/' + c.id); await reload(); }
    catch (err) {
      if (err.status === 409 && err.data && err.data.reportCount && confirm(`${err.message}`)) {
        try { await api('DELETE', `/connections/${c.id}?detach=1`); await reload(); } catch (e2) { say(box, e2.message); }
      } else say(box, err.message);
    }
  };

  view.append(
    h('div', { class: 'card' }, h('h2', {}, 'Connection'), form, box),
    h('div', { class: 'card' }, h('h2', {}, 'Connections'),
      list.length === 0 ? h('p', { class: 'muted' }, 'No connections yet.') :
      h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Type', 'Host', 'Database', 'Reports', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, list.map((c) => h('tr', {},
          h('td', {}, c.name), h('td', {}, c.type), h('td', {}, `${c.host}:${c.port}`), h('td', {}, c.database), h('td', {}, c.reportCount),
          h('td', { class: 'actions' },
            h('button', { onclick: (e) => test(c, e.target) }, 'Test'), ' ',
            h('button', { onclick: () => edit(c) }, 'Edit'), ' ',
            h('button', { class: 'danger', onclick: () => del(c) }, 'Delete'))))))));
}

