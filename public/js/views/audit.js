import { api, h } from '../api.js';

const view = document.getElementById('view');

export async function renderAudit() {
  const state = { page: 1, user: '', report: '', action: '', from: '', to: '' };
  const results = h('div', {});

  const input = (label, key, attrs = {}) => {
    const el = h('input', { ...attrs, value: state[key] });
    el.addEventListener('input', () => { state[key] = el.value; });
    return h('label', {}, label, el);
  };
  const action = h('select', {}, [['', 'All'], ['run', 'Run'], ['export-csv', 'Export CSV'], ['export-xlsx', 'Export Excel'], ['login', 'Login'], ['logout', 'Logout']]
    .map(([v, t]) => h('option', { value: v }, t)));
  action.addEventListener('change', () => { state.action = action.value; });

  const form = h('form', { class: 'grid', onsubmit: (e) => { e.preventDefault(); state.page = 1; load(); } },
    input('User', 'user'), input('Report', 'report'), h('label', {}, 'Action', action),
    input('From', 'from', { type: 'date' }), input('To', 'to', { type: 'date' }),
    h('label', {}, ' ', h('button', { class: 'primary', type: 'submit' }, 'Filter')));

  async function load() {
    const qs = Object.entries(state).filter(([, v]) => v !== '' && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    let data;
    try { data = await api('GET', '/audit?' + qs); } catch (e) { results.replaceChildren(h('p', { class: 'msg error' }, e.message)); return; }
    const pager = () => h('div', { class: 'row pager' },
      h('button', { disabled: data.page <= 1, onclick: () => { state.page = data.page - 1; load(); } }, 'Previous'),
      h('span', {}, `Page ${data.page} of ${data.totalPages} · ${data.total.toLocaleString()} entries`),
      h('button', { disabled: data.page >= data.totalPages, onclick: () => { state.page = data.page + 1; load(); } }, 'Next'));
    results.replaceChildren(pager(), h('div', { class: 'scroll' }, h('table', { class: 'result' },
      h('thead', {}, h('tr', {}, ['When', 'User', 'Action', 'Report', 'Parameters', 'Rows', 'Result', 'IP', 'Browser'].map((t) => h('th', {}, t)))),
      h('tbody', {}, data.rows.map((r) => h('tr', {},
        h('td', {}, new Date(r.at).toLocaleString()), h('td', {}, r.username || ''), h('td', {}, r.action), h('td', {}, r.reportName || ''),
        h('td', {}, r.params || ''), h('td', { class: 'num' }, r.rowCount === null ? '' : r.rowCount),
        h('td', { class: r.status === 'ok' ? '' : 'warn', title: r.error || '' }, r.status === 'ok' ? 'OK' : 'Error: ' + (r.error || '')),
        h('td', {}, r.ip || ''), h('td', { title: r.userAgent || '' }, (r.userAgent || '').slice(0, 40))))))));
  }

  view.append(h('div', { class: 'card' }, h('h2', {}, 'Audit log'),
    h('p', { class: 'muted' }, 'Who ran or exported which report, with which parameters, from which computer. Connection passwords are never recorded.'), form), h('div', { class: 'card' }, results));
  await load();
}
