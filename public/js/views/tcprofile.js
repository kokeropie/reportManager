import { api, h } from '../api.js';

const view = document.getElementById('view');
const say = (box, text, ok) => { box.textContent = text; box.className = 'msg ' + (ok ? 'ok' : 'error'); };
const when = (v) => (v ? new Date(v).toLocaleString() : '-');
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
let poll = null;
let tick = null;

export async function renderTcProfile() {
  clearTimeout(poll); clearInterval(tick);
  const { config: c, file, running } = await api('GET', '/tcprofile');
  const box = h('div', { class: 'msg', role: 'status' });
  const live = h('div', { class: 'card', style: 'display:none' });
  const history = h('div', { class: 'card' });

  // Schedule: daily at a time, or monthly on chosen dates at a time.
  const sc = c.schedule;
  const type = h('select', { 'aria-label': 'Repeat' }, h('option', { value: 'daily', selected: sc.type === 'daily' }, 'Every day'), h('option', { value: 'monthly', selected: sc.type === 'monthly' }, 'Once a month'));
  const time = h('input', { type: 'time', value: sc.time || '06:00', required: true, 'aria-label': 'Time' });
  const dom = h('input', { value: (sc.days || [1]).join(', '), placeholder: 'e.g. 1, 15, 31', 'aria-label': 'Dates of the month' });
  const enabled = h('input', { type: 'checkbox', checked: c.enabled });
  const domLabel = h('label', {}, 'Dates of the month, comma separated (31 = last day if the month is shorter)', dom);
  const sync = () => { domLabel.hidden = type.value !== 'monthly'; };
  type.addEventListener('change', sync); sync();

  const form = h('form', { class: 'grid', onsubmit: async (e) => {
    e.preventDefault();
    const schedule = type.value === 'daily' ? { type: 'daily', time: time.value }
      : { type: 'monthly', time: time.value, days: dom.value.split(/[\s,;]+/).filter(Boolean).map(Number) };
    try { await api('PUT', '/tcprofile', { enabled: enabled.checked, schedule }); view.replaceChildren(); await renderTcProfile(); }
    catch (err) { say(box, err.message); }
  } },
    h('label', { class: 'check' }, enabled, ' Run on schedule'),
    h('label', {}, 'Repeat', type), h('label', {}, 'At (server time)', time), domLabel,
    h('label', {}, ' ', h('button', { class: 'primary', type: 'submit' }, 'Save schedule')));

  const runBtn = h('button', { type: 'button', class: 'primary', onclick: async (e) => {
    e.target.disabled = true;
    try { await api('POST', '/tcprofile/run'); say(box, 'Started.', true); await drawHistory(); }
    catch (err) { say(box, err.message); e.target.disabled = false; }
  } }, 'Run now');

  async function drawHistory() {
    clearTimeout(poll); clearInterval(tick);
    const { runs, running: now, progress, file: f } = await api('GET', '/tcprofile/runs');
    if (progress) {
      const skew = Date.now() - progress.now; // server and browser clocks may differ
      const line = h('p', { class: 'muted' });
      const paint = () => { line.textContent = `Running for ${dur(Date.now() - skew - progress.startedAt)}${progress.bytes ? `, ${mb(progress.bytes)} received` : ''}.`; };
      paint(); tick = setInterval(paint, 1000);
      live.style.display = '';
      live.replaceChildren(h('h3', {}, 'Downloading from Alvis...'), line);
    } else { live.style.display = 'none'; live.replaceChildren(); }
    fileLine.textContent = f ? `${f.folder}/${f.name}: ${mb(f.size)}, last replaced ${when(f.modifiedAt)}` : 'No file yet.';
    runBtn.disabled = !!now;
    history.replaceChildren(h('h3', {}, 'History'),
      runs.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Started', 'By', 'Took', 'Result'].map((t) => h('th', {}, t)))),
        h('tbody', {}, runs.map((r) => h('tr', {}, h('td', {}, when(r.startedAt)), h('td', {}, r.by),
          h('td', {}, r.finishedAt ? dur(new Date(r.finishedAt) - new Date(r.startedAt)) : ''),
          h('td', {}, r.status === 'running' ? 'Running (see the box above)' : r.status === 'ok' ? 'OK: ' + (r.summary || '') : 'Failed: ' + (r.summary || '')))))) : h('p', { class: 'muted' }, 'Nothing has run yet.'));
    if (now && location.hash === '#/tcprofile') poll = setTimeout(drawHistory, 3000);
    else if (running && !now && location.hash === '#/tcprofile') { view.replaceChildren(); renderTcProfile(); }
  }

  const fileLine = h('p', { class: 'muted' });
  view.append(
    h('div', { class: 'card' }, h('h2', {}, 'tcProfile'),
      h('p', { class: 'muted' }, 'Downloads the TC Profile Excel file from Alvis for the current year and saves it as tcprofile/tcProfile_new.xlsx on the server. Each run replaces the old file and keeps the name. The folder is copied to SharePoint automatically when SharePoint push is on.'),
      c.enabled ? h('p', {}, `Schedule: ${c.scheduleText}. Next run: ${when(c.nextRunAt)}.`) : h('p', { class: 'badge warn' }, 'Not running on schedule'),
      fileLine, form, box, h('div', { class: 'row' }, runBtn)),
    live, history);
  await drawHistory();
}
