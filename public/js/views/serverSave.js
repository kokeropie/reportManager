import { api, h } from '../api.js';

// "Save to a server folder": browse the user's own area on the server, then export straight into it.
// onSave(folder, format) must resolve with the server's { location, fileName, rowCount }.
export function serverSavePanel(onSave) {
  let path = '';
  const where = h('code', {});
  const list = h('div', { class: 'row' });
  const msg = h('div', { class: 'muted' });
  const nameIn = h('input', { maxlength: 60, placeholder: 'New folder name', 'aria-label': 'New folder name' });

  async function open(p) {
    msg.textContent = '';
    try {
      const d = await api('GET', '/server-folders?path=' + encodeURIComponent(p));
      path = d.path;
      where.textContent = d.location;
      list.replaceChildren(
        d.parent !== null ? h('button', { onclick: () => open(d.parent) }, '⬆ Up') : '',
        ...d.folders.map((n) => h('button', { onclick: () => open([path, n].filter(Boolean).join('/')) }, '📁 ' + n)),
        d.folders.length || d.parent !== null ? '' : h('span', { class: 'muted' }, 'No subfolders yet.'));
    } catch (e) { msg.textContent = e.message; }
  }

  async function save(format, btn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving...'; msg.textContent = '';
    try {
      const r = await onSave(path, format);
      msg.textContent = `Saved ${r.rowCount.toLocaleString()} rows to ${r.location}`;
    } catch (e) { msg.textContent = e.message; }
    btn.disabled = false; btn.textContent = label;
  }

  const csvBtn = h('button', { onclick: (e) => save('csv', e.target) }, 'Save CSV here');
  const xlsxBtn = h('button', { onclick: (e) => save('xlsx', e.target) }, 'Save Excel here');
  const mk = h('button', { onclick: async () => {
    try { await api('POST', '/server-folders', { path, name: nameIn.value }); nameIn.value = ''; await open(path); }
    catch (e) { msg.textContent = e.message; }
  } }, 'Create folder');

  const del = h('button', { onclick: async () => {
    if (!path) { msg.textContent = 'Open the folder you want to delete first.'; return; }
    if (!confirm(`Delete folder "${path}"? It must be empty.`)) return;
    const url = '/server-folders?path=' + encodeURIComponent(path);
    try {
      let d;
      try { d = await api('DELETE', url); }
      catch (e) {
        if (!(e.data && e.data.needsConfirm)) throw e;
        const names = e.data.subscriptions.map((n) => `- ${n}`).join('\n');
        if (!confirm(`These subscriptions save into this folder:\n${names}\n\nIf you delete it they are put on hold and cannot run until you choose another folder (Subscriptions > Edit). Delete anyway?`)) return;
        d = await api('DELETE', url + '&confirm=1');
      }
      await open(d.parent);
      if (d.held && d.held.length) msg.textContent = `Folder deleted. On hold until you choose a new folder: ${d.held.join(', ')}`;
    } catch (e) { msg.textContent = e.message; }
  } }, 'Delete this folder');

  const box = h('details', { class: 'card' },
    h('summary', {}, 'Save to a folder on the server'),
    h('p', { class: 'muted' }, 'Files go into your own area on the server, not to your computer. Current folder:'),
    h('p', {}, where), list,
    h('div', { class: 'row' }, nameIn, mk, del),
    h('div', { class: 'row' }, csvBtn, xlsxBtn), msg);
  let loaded = false;
  box.addEventListener('toggle', () => { if (box.open && !loaded) { loaded = true; open(''); } });
  return box;
}
