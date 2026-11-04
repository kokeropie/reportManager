import { api, h } from '../api.js';

const view = document.getElementById('view');
const say = (box, text, ok) => { box.textContent = text; box.className = 'msg ' + (ok ? 'ok' : 'error'); };
const when = (v) => (v ? new Date(v).toLocaleString() : '-');
let poll = null;

export async function renderDbSync() {
  clearTimeout(poll);
  const { config: c, running, platform } = await api('GET', '/db-sync');
  const box = h('div', { class: 'msg', role: 'status' });
  const history = h('div', { class: 'card' });

  const field = (label, name, attrs = {}) => h('label', {}, label, h('input', { name, ...attrs }));
  const pw = (has) => ({ type: 'password', autocomplete: 'new-password', placeholder: has ? 'blank keeps the saved password' : '' });
  const testBtn = (which) => h('button', { type: 'button', onclick: async (e) => {
    e.target.disabled = true; say(box, 'Testing...', true);
    try { const r = await api('POST', '/db-sync/test/' + which); say(box, r.message, r.ok); } catch (err) { say(box, err.message); }
    e.target.disabled = false;
  } }, 'Test connection');

  const rows = h('div', {});
  const addRow = (prefix = '', database = '') => {
    const row = h('div', { class: 'row' },
      h('input', { 'aria-label': 'File name starts with', placeholder: 'dev_arjuna', value: prefix, 'data-k': 'prefix' }), ' restores into ',
      h('input', { 'aria-label': 'Database', placeholder: 'dev_arjuna', value: database, 'data-k': 'database' }),
      h('button', { type: 'button', onclick: () => row.remove() }, 'Remove'));
    rows.append(row);
  };
  (c.items.length ? c.items : [{ prefix: '', database: '' }]).forEach((i) => addRow(i.prefix, i.database));

  const form = h('form', { class: 'grid', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const g = (k) => f.get(k);
    const body = {
      enabled: g('enabled') === 'on',
      source: { host: g('sHost'), port: g('sPort'), username: g('sUser'), password: g('sPass'), dir: g('sDir') },
      dest: { host: g('dHost'), port: g('dPort'), username: g('dUser'), password: g('dPass'), dir: g('dDir') },
      mysql: { host: g('mHost'), port: g('mPort'), username: g('mUser'), password: g('mPass') },
      items: [...rows.children].map((r) => ({ prefix: r.querySelector('[data-k=prefix]').value, database: r.querySelector('[data-k=database]').value })),
      syncSchedule: { type: 'daily', time: g('syncTime') },
      cleanupSchedule: { type: 'daily', time: g('cleanTime') },
    };
    try { await api('PUT', '/db-sync', body); view.replaceChildren(); await renderDbSync(); }
    catch (err) { say(box, err.message); }
  } },
    h('h3', {}, '1. Backup server (where the .sql.gz files are)'),
    field('Server IP / name', 'sHost', { required: true, value: c.source.host }),
    field('SSH port', 'sPort', { type: 'number', min: 1, max: 65535, value: c.source.port }),
    field('User', 'sUser', { required: true, autocomplete: 'off', value: c.source.username }),
    field('Password', 'sPass', pw(c.source.hasPassword)),
    field('Folder', 'sDir', { required: true, value: c.source.dir }),
    h('div', { class: 'row' }, testBtn('source'), c.source.hostKey ? h('span', { class: 'muted' }, 'Host key trusted') : h('span', { class: 'muted' }, 'Host key not trusted yet: press Test')),

    h('h3', {}, '2. Ubuntu server (where files are copied, extracted and restored)'),
    h('p', { class: 'muted' }, platform === 'win32'
      ? 'This app runs on Windows, so the Ubuntu server address is required.'
      : 'Leave the address empty if this app already runs on that Ubuntu server.'),
    field('Server IP / name', 'dHost', { value: c.dest.host }),
    field('SSH port', 'dPort', { type: 'number', min: 1, max: 65535, value: c.dest.port }),
    field('User', 'dUser', { autocomplete: 'off', value: c.dest.username }),
    field('Password', 'dPass', pw(c.dest.hasPassword)),
    field('Target folder (created if missing)', 'dDir', { required: true, value: c.dest.dir }),
    h('div', { class: 'row' }, testBtn('dest'), c.dest.host ? (c.dest.hostKey ? h('span', { class: 'muted' }, 'Host key trusted') : h('span', { class: 'muted' }, 'Host key not trusted yet: press Test')) : ''),

    h('h3', {}, '3. MySQL login (as seen from the Ubuntu server)'),
    field('MySQL host', 'mHost', { required: true, value: c.mysql.host }),
    field('Port', 'mPort', { type: 'number', min: 1, max: 65535, value: c.mysql.port }),
    field('User', 'mUser', { required: true, autocomplete: 'off', value: c.mysql.username }),
    field('Password', 'mPass', pw(c.mysql.hasPassword)),
    h('div', { class: 'row' }, testBtn('mysql'), h('span', { class: 'muted' }, 'Save first: Test uses the saved settings.')),

    h('h3', {}, '4. Databases'),
    h('p', { class: 'muted' }, 'Only the newest file per name is copied, picked by the date in the file name (name_YYYYMMDD_HHMMSS.sql.gz).'),
    rows, h('div', {}, h('button', { type: 'button', onclick: () => addRow() }, 'Add database')),

    h('h3', {}, '5. Schedule (server time)'),
    field('Copy, extract and restore every day at', 'syncTime', { type: 'time', required: true, value: (c.syncSchedule || {}).time || '02:00' }),
    field('Delete the copied files every day at', 'cleanTime', { type: 'time', required: true, value: (c.cleanupSchedule || {}).time || '18:00' }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'enabled', checked: c.enabled }), 'Run on schedule'),
    h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save settings')));

  const start = (kind, label) => h('button', { disabled: !!running, onclick: async () => {
    if (!confirm(kind === 'sync' ? 'Copy the latest files and restore them into the databases now? This overwrites the data in those databases.' : 'Delete the copied files now?')) return;
    try { await api('POST', '/db-sync/run/' + kind); view.replaceChildren(); await renderDbSync(); } catch (err) { say(box, err.message); }
  } }, label);

  async function drawHistory() {
    const { runs, running: now } = await api('GET', '/db-sync/runs');
    history.replaceChildren(h('h3', {}, 'History'),
      runs.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Started', 'Job', 'By', 'Result', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, runs.map((r) => h('tr', {}, h('td', {}, when(r.startedAt)), h('td', {}, r.kind === 'sync' ? 'Copy + restore' : 'Cleanup'), h('td', {}, r.by),
          h('td', {}, r.status === 'running' ? 'Running...' : r.status === 'ok' ? 'OK: ' + (r.summary || '') : r.status === 'warning' ? 'Done with errors: ' + (r.summary || '') : 'Failed: ' + (r.summary || '')),
          h('td', {}, r.log ? h('details', {}, h('summary', {}, 'Log'), h('pre', {}, r.log)) : ''))))) : h('p', { class: 'muted' }, 'Nothing has run yet.'));
    if (now && location.hash === '#/db-sync') poll = setTimeout(drawHistory, 3000);
    else if (running && !now && location.hash === '#/db-sync') { view.replaceChildren(); renderDbSync(); }
  }

  view.append(
    h('div', { class: 'card' }, h('h2', {}, 'DB Sync'),
      h('p', { class: 'muted' }, 'Copies the newest backup files from the backup server to the Ubuntu server, extracts them, restores them into MySQL, and deletes the files again later in the day. Passwords are stored encrypted.'),
      c.enabled ? h('p', {}, `Next copy: ${when(c.nextSyncAt)}. Next cleanup: ${when(c.nextCleanupAt)}.`) : h('p', { class: 'badge warn' }, 'Not running on schedule'),
      form, box,
      h('div', { class: 'row' }, start('sync', 'Run copy + restore now'), start('cleanup', 'Delete files now'), running ? h('span', { class: 'muted' }, `A ${running} is running...`) : '')),
    history);
  await drawHistory();
}
