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

  const box = h('details', { class: 'card' },
    h('summary', {}, 'Save to a folder on the server'),
    h('p', { class: 'muted' }, 'Files go into your own area on the server, not to your computer. Current folder:'),
    h('p', {}, where), list,
    h('div', { class: 'row' }, nameIn, mk),
    h('div', { class: 'row' }, csvBtn, xlsxBtn), msg);
  let loaded = false;
  box.addEventListener('toggle', () => { if (box.open && !loaded) { loaded = true; open(''); } });
  return box;
}
