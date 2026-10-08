import { api, h } from '../api.js';

const view = document.getElementById('view');
const say = (box, text, ok) => { box.textContent = text; box.className = 'msg ' + (ok ? 'ok' : 'error'); };
const when = (v) => (v ? new Date(v).toLocaleString() : '-');
const size = (n) => (n === null || n === undefined ? '' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The schedule fields, shared by the "Subscribe" panel in the report viewer. read() returns { schedule, folder, format, name }.
export function scheduleForm() {
  const type = h('select', { name: 'type', 'aria-label': 'Repeat' },
    h('option', { value: 'daily' }, 'Every day'), h('option', { value: 'weekly' }, 'Certain weekdays'),
    h('option', { value: 'monthly' }, 'Once a month'), h('option', { value: 'interval' }, 'Every few hours'));
  const time = h('input', { type: 'time', value: '06:00', required: true, 'aria-label': 'Time' });
  const days = DAYS.map((d, i) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: i, checked: i >= 1 && i <= 5 }), d));
  const daysBox = h('div', { class: 'row' }, days);
  const dom = h('input', { type: 'number', min: 1, max: 31, value: 1, 'aria-label': 'Day of month' });
  const hours = h('input', { type: 'number', min: 0.25, max: 168, step: 0.25, value: 6, 'aria-label': 'Hours' });
  const f = {
    time: h('label', {}, 'At (server time)', time),
    days: h('label', {}, 'On', daysBox),
    dom: h('label', {}, 'Day of month (31 = last day if the month is shorter)', dom),
    hours: h('label', {}, 'Every how many hours', hours),
  };
  const sync = () => {
    f.time.hidden = type.value === 'interval';
    f.days.hidden = type.value !== 'weekly';
    f.dom.hidden = type.value !== 'monthly';
    f.hours.hidden = type.value !== 'interval';
  };
  type.addEventListener('change', sync);
  sync();
  const name = h('input', { maxlength: 200, 'aria-label': 'Name' });
  const format = h('select', { 'aria-label': 'Format' }, h('option', { value: 'xlsx' }, 'Excel (.xlsx)'), h('option', { value: 'csv' }, 'CSV'));
  const folder = h('input', { maxlength: 200, placeholder: 'e.g. Finance/Daily (optional)', 'aria-label': 'Folder' });
  return {
    el: [h('label', {}, 'Name', name), h('label', {}, 'Repeat', type), f.time, f.days, f.dom, f.hours,
      h('label', {}, 'File type', format), h('label', {}, 'Save in my folder', folder)],
    setName: (v) => { name.value = v; },
    // Fill every field from a saved subscription (for the edit screen).
    set(sub) {
      name.value = sub.name;
      format.value = sub.format;
      folder.value = sub.folder || '';
      const sc = sub.schedule;
      type.value = sc.type;
      if (sc.time) time.value = sc.time;
      if (sc.type === 'weekly') for (const l of days) l.firstChild.checked = sc.days.includes(+l.firstChild.value);
      if (sc.type === 'monthly') dom.value = sc.day;
      if (sc.type === 'interval') hours.value = sc.everyMinutes / 60;
      sync();
    },
    read() {
      const t = type.value;
      const schedule = t === 'interval' ? { type: t, everyMinutes: Math.round(Number(hours.value) * 60) }
        : { type: t, time: time.value, days: days.map((l) => l.firstChild).filter((c) => c.checked).map((c) => +c.value), day: Number(dom.value) };
      return { name: name.value, schedule, format: format.value, folder: folder.value };
    },
  };
}

// One input per visible report parameter. Blank means "use the report's default each run" (so dates keep moving).
function paramFields(rep, saved) {
  const fields = rep.parameters.filter((p) => !p.hidden).map((p) => {
    const cur = saved[p.name] ?? saved[Object.keys(saved).find((k) => k.toLowerCase() === p.name.toLowerCase())];
    const ph = p.default !== null && p.default !== undefined && p.default !== '' ? `default: ${p.default}` : 'no default';
    let el;
    if (p.validValues) {
      el = h('select', {}, h('option', { value: '' }, `(${ph})`), p.validValues.map((v) => h('option', { value: v.value, selected: String(cur) === v.value }, v.label)));
    } else if (p.type === 'Boolean') {
      el = h('select', {}, h('option', { value: '' }, `(${ph})`), h('option', { value: 'true', selected: cur === true }, 'Yes'), h('option', { value: 'false', selected: cur === false }, 'No'));
    } else {
      const type = p.type === 'DateTime' ? 'date' : p.type === 'Integer' || p.type === 'Float' ? 'number' : 'text';
      el = h('input', { type, step: p.type === 'Float' ? 'any' : undefined, value: cur === undefined ? '' : String(cur).slice(0, type === 'date' ? 10 : 200), placeholder: ph });
    }
    return { p, el };
  });
  return {
    el: fields.map(({ p, el }) => h('label', {}, p.prompt, el)),
    read() {
      const out = {};
      for (const { p, el } of fields) {
        if (el.value === '') continue;
        out[p.name] = p.type === 'Boolean' ? el.value === 'true' : el.value;
      }
      return out;
    },
  };
}

async function editPanel(s, onSaved) {
  const rep = await api('GET', '/reports/' + s.reportId);
  const sf = scheduleForm();
  sf.set(s);
  const pf = paramFields(rep, s.params);
  const msg = h('div', { class: 'msg', role: 'alert' });
  const form = h('form', { class: 'grid', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/subscriptions/' + s.id, { ...sf.read(), params: pf.read() });
      onSaved();
    } catch (err) { msg.textContent = err.message + (err.data && err.data.details ? ' ' + err.data.details.join('. ') : ''); msg.className = 'msg error'; }
  } }, sf.el, pf.el.length ? h('div', { class: 'muted' }, 'Parameters: leave blank to use the report\'s default each time it runs.') : '', pf.el,
    h('label', {}, ' ', h('span', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save changes'), h('button', { type: 'button', onclick: onSaved }, 'Cancel'))));
  return h('div', { class: 'card' }, h('h3', {}, 'Edit: ' + s.name), form, msg);
}

export async function renderSubscriptions() {
  const list = await api('GET', '/subscriptions');
  const box = h('div', { class: 'msg', role: 'status' });
  const reload = () => { view.replaceChildren(); return renderSubscriptions(); };
  const act = (fn) => async () => { try { await fn(); await reload(); } catch (e) { say(box, e.message); } };
  const history = h('div', {});
  const editor = h('div', {});
  const edit = async (s) => {
    try { editor.replaceChildren(await editPanel(s, reload)); editor.scrollIntoView({ behavior: 'smooth' }); } catch (e) { say(box, e.message); }
  };

  async function showHistory(s) {
    const runs = await api('GET', `/subscriptions/${s.id}/runs`);
    history.replaceChildren(h('div', { class: 'card' }, h('h3', {}, 'History: ' + s.name),
      runs.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Started', 'Result', 'Rows', 'File', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, runs.map((r) => h('tr', {}, h('td', {}, when(r.startedAt)),
          h('td', {}, r.status === 'ok' ? 'OK' : r.error || 'Failed'), h('td', {}, r.rowCount ?? ''),
          h('td', {}, r.fileName ? `${r.fileName} (${size(r.fileSize)})` : ''),
          h('td', {}, r.fileName ? h('a', { href: `/api/subscriptions/files/${r.id}/download` }, 'Download') : ''))))) : h('p', { class: 'muted' }, 'Nothing has run yet.')));
  }

  view.append(
    h('div', { class: 'card' }, h('h2', {}, 'My subscriptions'),
      h('p', { class: 'muted' }, 'Open a report and press Subscribe to schedule it. Results are saved to your own files and are visible only to you.'),
      list.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Report', 'Schedule', 'Next run', 'Last run', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, list.map((s) => h('tr', {},
          h('td', {}, s.name, s.folder ? h('div', { class: 'muted' }, 'Folder: ' + s.folder) : ''),
          h('td', {}, h('a', { href: '#/report/' + s.reportId }, s.reportName)),
          h('td', {}, s.scheduleText, h('div', { class: 'muted' }, s.format.toUpperCase())),
          h('td', {}, s.enabled ? when(s.nextRunAt) : h('span', { class: 'badge warn' }, 'Paused')),
          h('td', {}, s.lastStatus ? (s.lastStatus === 'ok' ? 'OK ' : 'Failed ') + when(s.lastRunAt) : '-',
            s.lastError ? h('div', { class: 'muted' }, s.lastError) : ''),
          h('td', { class: 'actions' },
            h('button', { onclick: act(() => api('POST', `/subscriptions/${s.id}/run`)) }, 'Run now'), ' ',
            h('button', { onclick: act(() => api('PUT', `/subscriptions/${s.id}`, { enabled: !s.enabled })) }, s.enabled ? 'Pause' : 'Resume'), ' ',
            h('button', { onclick: () => edit(s) }, 'Edit'), ' ',
            h('button', { onclick: () => showHistory(s) }, 'History'), ' ',
            h('button', { onclick: () => { if (confirm(`Delete "${s.name}" and its saved files?`)) act(() => api('DELETE', '/subscriptions/' + s.id))(); } }, 'Delete')))))
      ) : h('p', {}, 'No subscriptions yet.'), box),
    editor, history);
}

export async function renderFiles() {
  const files = await api('GET', '/subscriptions/files');
  view.append(h('div', { class: 'card' }, h('h2', {}, 'My saved files'),
    h('p', { class: 'muted' }, 'Results from your scheduled reports. Old files are removed automatically.'),
    files.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Saved', 'File', 'Subscription', 'Rows', 'Size', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, files.map((f) => h('tr', {}, h('td', {}, when(f.finishedAt || f.startedAt)), h('td', {}, f.fileName), h('td', {}, f.subscriptionName),
        h('td', {}, f.rowCount ?? ''), h('td', {}, size(f.fileSize)), h('td', {}, h('a', { href: `/api/subscriptions/files/${f.id}/download` }, 'Download')))))) : h('p', {}, 'Nothing saved yet.')));
}

// Everyone has their own login; this screen is also what a new or reset user is sent to first.
export function renderPassword(me, onDone) {
  const box = h('div', { class: 'msg', role: 'status' });
  const form = h('form', { class: 'grid', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    if (f.get('password') !== f.get('again')) return say(box, 'The two new passwords are different');
    try {
      await api('POST', '/auth/password', { current: f.get('current'), password: f.get('password') });
      say(box, 'Password changed', true);
      if (onDone) onDone();
    } catch (err) { say(box, err.message); }
  } },
    h('label', {}, 'Current password', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label', {}, 'New password (min 8 characters)', h('input', { name: 'password', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' })),
    h('label', {}, 'New password again', h('input', { name: 'again', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' })),
    h('label', {}, ' ', h('button', { class: 'primary', type: 'submit' }, 'Change password')));
  view.append(h('div', { class: 'card' }, h('h2', {}, me.mustChange ? 'Choose your own password' : 'Change password'),
    me.mustChange ? h('p', {}, 'Your account was set up with a temporary password. Pick one only you know before you continue.') : '', form, box));
}
