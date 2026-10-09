import { api, h } from '../api.js';

const view = document.getElementById('view');
const say = (box, text, ok) => { box.textContent = text; box.className = 'msg ' + (ok ? 'ok' : 'error'); };

export function searchBar(initial) {
  const input = h('input', { type: 'search', placeholder: 'Search reports...', value: initial || '', 'aria-label': 'Search reports' });
  return h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); const q = input.value.trim(); location.hash = q ? '#/search/' + encodeURIComponent(q) : '#/'; } },
    input, h('button', { type: 'submit' }, 'Search'));
}

export async function renderFolders(me) {
  const folders = await api('GET', '/folders');
  const box = h('div', { class: 'msg', role: 'status' });
  const reload = () => { view.replaceChildren(); return renderFolders(me); };

  view.append(h('div', { class: 'card' }, searchBar()));

  const rows = folders.map((f) => h('tr', {},
    h('td', {}, h('a', { href: f.isSystem ? '#/connections' : '#/folder/' + f.id }, f.name), f.isSystem ? h('span', { class: 'muted' }, '  (admin only, holds connections)') : ''),
    h('td', {}, f.isSystem ? '' : f.reportCount),
    me.role === 'admin' && !f.isSystem ? h('td', { class: 'actions' },
      h('button', { onclick: async () => {
        const name = prompt('New folder name', f.name);
        if (!name || name === f.name) return;
        try { await api('PUT', '/folders/' + f.id, { name }); await reload(); } catch (e) { say(box, e.message); }
      } }, 'Rename'), ' ',
      h('button', { class: 'danger', onclick: async () => {
        if (!confirm(`Delete folder "${f.name}"?`)) return;
        try { await api('DELETE', '/folders/' + f.id); await reload(); } catch (e) { say(box, e.message); }
      } }, 'Delete')) : h('td', {})));

  view.append(h('div', { class: 'card' }, h('h2', {}, 'Folders'),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Reports'), h('th', {}, ''))), h('tbody', {}, rows)), box));

  if (me.role === 'admin') {
    const input = h('input', { placeholder: 'New folder name', required: true, maxlength: 100 });
    view.append(h('div', { class: 'card' }, h('form', { class: 'row', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', '/folders', { name: input.value }); await reload(); } catch (err) { say(box, err.message); }
    } }, input, h('button', { class: 'primary', type: 'submit' }, 'Add folder'))));
  }
}

function reportRow(r, me, connections, afterChange, box, showFolder) {
  const cells = [
    h('td', {}, h('a', { href: '#/report/' + r.id }, r.name), showFolder ? h('span', { class: 'muted' }, '  in ' + r.folderName) : ''),
    h('td', {}, r.connectionId ? '' : h('span', { class: 'badge warn' }, 'Not configured')),
  ];
  if (me.role === 'admin' && connections) {
    const sel = h('select', { 'aria-label': 'Connection for ' + r.name },
      h('option', { value: '' }, '(none)'),
      connections.map((c) => h('option', { value: c.id, selected: c.id === r.connectionId }, c.name)));
    sel.addEventListener('change', async () => {
      try { await api('PUT', '/reports/' + r.id, { connectionId: sel.value === '' ? null : parseInt(sel.value, 10) }); await afterChange(); }
      catch (e) { say(box, e.message); }
    });
    const replace = h('input', { type: 'file', accept: '.rdl', hidden: true });
    replace.addEventListener('change', async () => {
      const file = replace.files[0];
      if (!file) return;
      try {
        const out = await api('PUT', `/reports/${r.id}/rdl`, { content: await file.text() });
        say(box, `Replaced "${r.name}".` + (out.warnings.length ? ' Warnings: ' + out.warnings.join('; ') : ''), true);
        await afterChange();
      } catch (e) { say(box, e.message); }
    });
    cells.push(h('td', {}, h('span', { class: 'muted' }, r.dataSourceName ? r.dataSourceName + ' → ' : ''), sel));
    cells.push(h('td', { class: 'actions' },
      h('button', { onclick: () => replace.click() }, 'Replace'), replace, ' ',
      h('button', { class: 'danger', onclick: async () => {
        if (!confirm(`Delete report "${r.name}"?`)) return;
        try { await api('DELETE', '/reports/' + r.id); await afterChange(); } catch (e) { say(box, e.message); }
      } }, 'Delete')));
  }
  return h('tr', {}, cells);
}

export async function renderFolder(me, id) {
  const [data, connections] = await Promise.all([
    api('GET', `/folders/${id}/reports`),
    me.role === 'admin' ? api('GET', '/connections') : Promise.resolve(null),
  ]);
  const box = h('div', { class: 'msg', role: 'status' });
  const reload = () => { view.replaceChildren(); return renderFolder(me, id); };

  view.append(h('p', {}, h('a', { href: '#/' }, '← Folders')));
  view.append(h('div', { class: 'card' }, h('h2', {}, data.folder.name),
    data.reports.length === 0 ? h('p', { class: 'muted' }, 'No reports in this folder yet.') :
      h('table', {}, h('thead', {}, h('tr', {}, ['Report', '', ...(me.role === 'admin' ? ['Data source → connection', ''] : [])].map((t) => h('th', {}, t)))),
        h('tbody', {}, data.reports.map((r) => reportRow(r, me, connections, reload, box)))), box));

  if (me.role === 'admin') view.append(uploadCard(id, connections, reload));
}

function uploadCard(folderId, connections, reload) {
  const files = h('input', { type: 'file', accept: '.rdl', multiple: true });
  const sel = h('select', {}, h('option', { value: '' }, 'Auto: match by data source name'),
    connections.map((c) => h('option', { value: c.id }, c.name)));
  const log = h('ul', { class: 'log' });
  const btn = h('button', { class: 'primary', type: 'button', onclick: async () => {
    if (!files.files.length) return;
    btn.disabled = true;
    log.replaceChildren();
    let ok = 0;
    for (const f of files.files) { // one request per file, so one bad file never blocks the rest
      const li = h('li', {}, `${f.name}: uploading...`);
      log.append(li);
      try {
        const out = await api('POST', `/folders/${folderId}/reports`, { fileName: f.name, content: await f.text(), connectionId: sel.value || null });
        ok++;
        li.className = 'ok';
        li.textContent = `${f.name}: ${out.replaced ? 'replaced the existing report (subscriptions keep running with the new file). ' : 'uploaded. '}` + (out.replaced ? '' : out.connectionId ? (out.autoMatched ? 'Connection matched by data source name. ' : '') : `No connection assigned (data source "${out.dataSourceName}"). `);
        if (out.warnings.length) li.append(h('ul', {}, out.warnings.map((w) => h('li', { class: 'warn' }, w))));
      } catch (e) {
        li.className = 'error';
        li.textContent = `${f.name}: ${e.message}`;
      }
    }
    btn.disabled = false;
    if (ok) setTimeout(reload, 1500);
  } }, 'Upload');
  return h('div', { class: 'card' }, h('h2', {}, 'Upload reports'),
    h('p', { class: 'muted' }, 'Only .rdl files. Choose a connection for all selected files, or let the app match each by its data source name.'),
    h('div', { class: 'row' }, files, sel, btn), log);
}

export async function renderSearch(me, q) {
  const results = await api('GET', '/reports?q=' + encodeURIComponent(q));
  const box = h('div', { class: 'msg', role: 'status' });
  view.append(h('div', { class: 'card' }, searchBar(q)));
  view.append(h('div', { class: 'card' }, h('h2', {}, `Results for "${q}"`),
    results.length === 0 ? h('p', { class: 'muted' }, 'Nothing found.') :
      h('table', {}, h('tbody', {}, results.map((r) => reportRow(r, me, null, () => {}, box, true)))), box));
}
