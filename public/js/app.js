import { api, setCsrf, h } from './api.js';
import { renderFolders, renderFolder, renderSearch } from './views/folders.js';
import { renderReport } from './views/viewer.js';
import { renderConnections } from './views/connections.js';
import { renderUsers } from './views/users.js';
import { renderAudit } from './views/audit.js';
import { renderSubscriptions, renderFiles, renderPassword } from './views/subscriptions.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
let me;

const tabs = [
  { id: 'folders', label: 'Folders', href: '#/' },
  { id: 'subscriptions', label: 'My subscriptions', href: '#/subscriptions' },
  { id: 'files', label: 'My files', href: '#/files' },
  { id: 'connections', label: 'Connections', href: '#/connections', admin: true },
  { id: 'users', label: 'Users', href: '#/users', admin: true },
  { id: 'audit', label: 'Audit log', href: '#/audit', admin: true },
];

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: parts[0] || '', arg: parts[1] ? decodeURIComponent(parts[1]) : '' };
}

async function route() {
  const { name, arg } = parseHash();
  const active = ['subscriptions', 'files'].includes(name) ? name : name === 'connections' ? 'connections' : name === 'users' ? 'users' : name === 'audit' ? 'audit' : 'folders';
  for (const b of nav.children) b.classList.toggle('active', b.dataset.id === active);
  view.replaceChildren();
  try {
    if (name === 'subscriptions') await renderSubscriptions();
    else if (name === 'files') await renderFiles();
    else if (name === 'password') renderPassword(me);
    else if (name === 'connections' && me.role === 'admin') await renderConnections();
    else if (name === 'users' && me.role === 'admin') await renderUsers();
    else if (name === 'audit' && me.role === 'admin') await renderAudit();
    else if (name === 'folder' && /^\d+$/.test(arg)) await renderFolder(me, parseInt(arg, 10));
    else if (name === 'report' && /^\d+$/.test(arg)) await renderReport(me, parseInt(arg, 10));
    else if (name === 'search') await renderSearch(me, arg);
    else await renderFolders(me);
  } catch (e) {
    if (e.message === 'Signed out') return;
    view.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'msg error' }, e.status === 404 ? 'Not found.' : e.message), h('a', { href: '#/' }, 'Back to folders')));
  }
}

(async function init() {
  try { me = await api('GET', '/auth/me'); } catch (e) { return; }
  setCsrf(me.csrfToken);
  document.getElementById('who').textContent = `${me.username} (${me.role})`;
  document.getElementById('logout').addEventListener('click', async () => {
    try { await api('POST', '/auth/logout'); } finally { location.href = '/login.html'; }
  });
  if (me.mustChange) { // temporary password: nothing else works until the person picks their own
    renderPassword(me, () => { location.hash = '#/'; location.reload(); });
    return;
  }
  document.getElementById('who').after(h('a', { href: '#/password', class: 'muted' }, 'Change password'));
  for (const t of tabs.filter((t) => !t.admin || me.role === 'admin')) {
    nav.append(h('a', { class: 'btn', 'data-id': t.id, href: t.href }, t.label));
  }
  window.addEventListener('hashchange', route);
  route();
})();
