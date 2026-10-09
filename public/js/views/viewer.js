import { api, download, h } from '../api.js';
import { scheduleForm } from './subscriptions.js';

const view = document.getElementById('view');

function inputFor(p) {
  const common = { name: p.name, 'aria-label': p.prompt };
  const req = !(p.nullable || (p.type === 'String' && p.allowBlank));
  if (p.validValues) {
    return h('select', { ...common }, p.validValues.map((v) => h('option', { value: v.value, selected: v.value === p.default }, v.label)));
  }
  switch (p.type) {
    case 'DateTime': {
      const hasTime = typeof p.default === 'string' && p.default.includes('T');
      return h('input', { ...common, type: hasTime ? 'datetime-local' : 'date', value: p.default || '', required: req, step: hasTime ? 1 : undefined });
    }
    case 'Integer': return h('input', { ...common, type: 'number', step: 1, value: p.default ?? '', required: req });
    case 'Float': return h('input', { ...common, type: 'number', step: 'any', value: p.default ?? '', required: req });
    case 'Boolean': return h('input', { ...common, type: 'checkbox', checked: p.default === 'true' || p.default === true });
    default: return h('input', { ...common, type: 'text', value: p.default ?? '', required: req });
  }
}

function tableFrom(result) {
  const rowEl = (r, tag) => h('tr', { class: r.kind }, r.cells.map((c) => h(tag, { class: c.num ? 'num' : '', colspan: c.span }, c.text)));
  if (result.multi) {
    // matrix and table on one screen: a new <table> starts wherever a header block starts
    const blocks = [];
    for (const r of result.rows) {
      let b = blocks[blocks.length - 1];
      if (!b || (r.kind === 'header' && b.body.length)) blocks.push(b = { head: [], body: [] });
      (r.kind === 'header' ? b.head : b.body).push(r);
    }
    return h('div', {}, blocks.map((b) => h('div', { class: 'scroll' }, h('table', { class: 'result' },
      b.head.length ? h('thead', {}, b.head.map((r) => rowEl(r, 'th'))) : '',
      h('tbody', {}, b.body.map((r) => rowEl(r, 'td')))))));
  }
  return h('div', { class: 'scroll' }, h('table', { class: 'result' },
    h('thead', {}, result.header.map((r) => rowEl(r, 'th'))),
    h('tbody', {}, result.rows.map((r) => rowEl(r, 'td'))),
    result.footer.length ? h('tfoot', {}, result.footer.map((r) => rowEl(r, 'td'))) : ''));
}

export async function renderReport(me, id) {
  const rep = await api('GET', '/reports/' + id);
  const out = h('div', {});
  const err = h('div', { class: 'msg error', role: 'alert' });
  let current = null;
  let lastParams = null;
  let layout = 'all';

  view.append(h('p', {}, h('a', { href: '#/folder/' + rep.folderId }, '← ' + rep.folderName)));
  view.append(h('div', { class: 'card' }, h('h2', {}, rep.name)));
  const top = view.lastChild;

  if (rep.warnings.length) {
    top.append(h('details', { class: 'warnbox' }, h('summary', {}, `${rep.warnings.length} warning(s) about this report`),
      h('ul', {}, rep.warnings.map((w) => h('li', {}, w)))));
  }

  if (!rep.configured) {
    top.append(h('p', { class: 'badge warn' }, 'Not configured, contact an administrator'));
    if (me.role === 'admin') {
      const connections = await api('GET', '/connections');
      const sel = h('select', {}, h('option', { value: '' }, 'Choose a connection...'), connections.map((c) => h('option', { value: c.id }, c.name)));
      top.append(h('div', { class: 'row' }, sel, h('button', { class: 'primary', onclick: async () => {
        if (!sel.value) return;
        await api('PUT', '/reports/' + id, { connectionId: parseInt(sel.value, 10) });
        view.replaceChildren(); await renderReport(me, id);
      } }, 'Assign'), rep.dataSourceName ? h('span', { class: 'muted' }, `Data source in the RDL: ${rep.dataSourceName}`) : ''));
    }
    return;
  }

  const fields = rep.parameters.filter((p) => !p.hidden).map((p) => ({ p, el: inputFor(p) }));
  const hidden = rep.parameters.filter((p) => p.hidden);
  const form = h('form', { class: 'grid', onsubmit: (e) => { e.preventDefault(); run(false); } },
    fields.map(({ p, el }) => h('label', { class: p.type === 'Boolean' ? 'check' : '' }, p.type === 'Boolean' ? [el, p.prompt] : [p.prompt, el])),
    h('label', {}, ' ', h('button', { class: 'primary', type: 'submit', id: 'run' }, 'View report')));
  top.append(form, err);
  top.append(subscribePanel());
  view.append(out);

  // Reports that hold both a matrix and a table can be viewed as either one, or both together.
  function layoutPicker() {
    if (!rep.layouts || !rep.layouts.length) return '';
    const names = { all: 'Matrix and tabular', matrix: 'Matrix only', tabular: 'Tabular only' };
    return h('label', {}, 'View as', h('select', { 'aria-label': 'View as', onchange: (e) => { layout = e.target.value; } },
      rep.layouts.map((l) => h('option', { value: l }, names[l]))));
  }

  // Subscribe: same parameters as the form above. Anything left at its default (like yesterday/today) is not
  // frozen: it follows the default every time the report runs.
  function subscribePanel() {
    const sf = scheduleForm();
    sf.setName(rep.name);
    const msg = h('div', { class: 'msg', role: 'status' });
    const panel = h('form', { class: 'grid', hidden: true, onsubmit: async (e) => {
      e.preventDefault();
      const all = collect();
      const params = {};
      for (const p of rep.parameters) {
        const v = all[p.name];
        const isDefault = p.default !== null && p.default !== undefined && String(v) === String(p.default);
        if (!isDefault && v !== '' && v !== null && v !== undefined) params[p.name] = v;
      }
      try {
        await api('POST', '/subscriptions', { reportId: id, params, ...sf.read() });
        msg.textContent = 'Subscribed. See My subscriptions.'; msg.className = 'msg ok'; panel.hidden = true;
      } catch (e2) { msg.textContent = e2.message + (e2.data && e2.data.details ? ' ' + e2.data.details.join('. ') : ''); msg.className = 'msg error'; }
    } }, sf.el, h('label', {}, ' ', h('button', { class: 'primary', type: 'submit' }, 'Save subscription')));
    return h('div', {}, h('button', { type: 'button', onclick: () => { panel.hidden = !panel.hidden; } }, 'Subscribe (run on a schedule)'), msg, panel);
  }

  function collect() {
    const params = {};
    for (const { p, el } of fields) params[p.name] = p.type === 'Boolean' ? el.checked : el.value;
    for (const p of hidden) params[p.name] = p.default;
    return params;
  }

  function showError(e) {
    err.replaceChildren(e.message);
    if (e.data && e.data.detail) err.append(h('details', {}, h('summary', {}, 'Technical detail'), h('pre', {}, e.data.detail)));
    if (e.data && e.data.details && e.data.details.length > 1) err.append(h('ul', {}, e.data.details.map((d) => h('li', {}, d))));
  }

  function draw(result) {
    current = result;
    out.replaceChildren();
    const pager = () => h('div', { class: 'row pager' },
      h('button', { disabled: result.page <= 1, onclick: () => go(result.page - 1) }, 'Previous'),
      h('span', {}, `Page ${result.page} of ${result.totalPages} \u00b7 ${result.totalRows.toLocaleString()} row(s)`),
      h('button', { disabled: result.page >= result.totalPages, onclick: () => go(result.page + 1) }, 'Next'));
    out.append(h('div', { class: 'card' },
      result.heading.map((t, i) => h(i === 0 ? 'h3' : 'p', {}, t)),
      result.truncated || result.warnings.length ? h('details', { class: 'warnbox', open: result.truncated }, h('summary', {}, `${result.warnings.length} warning(s)`), h('ul', {}, result.warnings.map((w) => h('li', {}, w)))) : '',
      result.totalRows === 0 ? h('p', { class: 'muted' }, 'No rows for these parameters.') : '',
      h('div', { class: 'row' },
        h('button', { onclick: (e) => exportAs('csv', e.target) }, 'Export CSV'),
        h('button', { onclick: (e) => exportAs('xlsx', e.target) }, 'Export Excel'),
        h('span', { class: 'muted' }, 'Exports run the report again with the same parameters.')),
      result.canLoadAll ? h('div', { class: 'row' },
        h('button', { onclick: () => {
          if (confirm(`Only the first ${result.maxRows.toLocaleString()} rows are shown. Loading all rows can take a while and use a lot of memory. Continue?`)) run(true);
        } }, 'Load all rows'),
        h('span', { class: 'muted' }, 'There are more rows than the screen limit.')) : '',
      pager(), tableFrom(result), result.totalPages > 1 ? pager() : ''));
  }

  async function exportAs(format, btn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Preparing...';
    err.replaceChildren();
    try { await download(`/reports/${id}/export?format=${format}`, { params: lastParams, layout }); }
    catch (e) { showError(e); }
    btn.disabled = false; btn.textContent = label;
  }

  async function go(page) {
    err.replaceChildren();
    try { draw(await api('GET', `/reports/${id}/runs/${current.runId}?page=${page}`)); window.scrollTo(0, 0); }
    catch (e) { showError(e); }
  }

  async function run(all = false) {
    const btn = form.querySelector('#run');
    btn.disabled = true; btn.textContent = 'Running...';
    err.replaceChildren(); out.replaceChildren();
    try { if (!(all === true && lastParams)) lastParams = collect(); draw(await api('POST', `/reports/${id}/run`, { params: lastParams, layout, loadAll: all === true })); }
    catch (e) { showError(e); }
    btn.disabled = false; btn.textContent = 'View report';
  }
}
