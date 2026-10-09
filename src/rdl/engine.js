'use strict';
// Turns query rows into the report's table, following the RDL layout: header/footer rows, row groups,
// the detail group, and the cell expressions. The same grid feeds the screen and (later) the exports.
const { compile, run, compare, ExprError, toDate, toNum, wallNow, wallToday } = require('./expressions');
const { formatValue, defaultDisplay } = require('./formats');

// ---- parameters ----
function coerceParam(p, raw) {
  const empty = raw === undefined || raw === null || raw === '';
  if (empty) {
    if (p.nullable) return { value: null };
    if (p.type === 'String' && p.allowBlank) return { value: '' };
    return { error: `"${p.prompt}" is required` };
  }
  switch (p.type) {
    case 'DateTime': {
      if (raw instanceof Date) return { value: raw };
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(raw).trim());
      if (!m) return { error: `"${p.prompt}" must be a date (YYYY-MM-DD)` };
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
      if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== +m[2] - 1) return { error: `"${p.prompt}" is not a valid date` };
      return { value: d };
    }
    case 'Integer': {
      const n = Number(raw);
      return Number.isInteger(n) ? { value: n } : { error: `"${p.prompt}" must be a whole number` };
    }
    case 'Float': {
      const n = Number(raw);
      return Number.isFinite(n) ? { value: n } : { error: `"${p.prompt}" must be a number` };
    }
    case 'Boolean':
      if (typeof raw === 'boolean') return { value: raw };
      if (/^(true|1|on)$/i.test(String(raw))) return { value: true };
      if (/^(false|0|off)$/i.test(String(raw))) return { value: false };
      return { error: `"${p.prompt}" must be true or false` };
    default:
      return { value: String(raw) };
  }
}

// Validates submitted values against the declared parameters (FR-16a: nothing is hard-coded).
function resolveParams(def, submitted) {
  const input = {};
  for (const k of Object.keys(submitted || {})) input[k.toLowerCase()] = submitted[k];
  const values = {};
  const errors = [];
  for (const p of def.parameters) {
    const raw = input[p.name.toLowerCase()];
    const r = coerceParam(p, raw);
    if (r.error) errors.push(r.error);
    else {
      if (p.validValues && r.value !== null && !p.validValues.some((v) => v.value === String(raw))) errors.push(`"${p.prompt}" is not one of the allowed values`);
      values[p.name.toLowerCase()] = r.value;
    }
  }
  return { values, errors };
}

// Default values (FR-17, FR-32): literals pre-fill; expressions such as =DateAdd("d",-1,Today()) are evaluated now.
function defaultValues(def) {
  const out = {};
  const ctx = { params: {}, now: wallNow() };
  for (const p of def.parameters) {
    let v = null;
    if (p.defaultCompiled) {
      try { v = run(p.defaultCompiled, ctx); } catch (e) { v = null; }
    }
    if (v instanceof Date) v = isoDate(v);
    out[p.name] = v === undefined ? null : v;
  }
  fillDateDefaults(def, out);
  return out;
}

// A date parameter the RDL gives no default for: start date = yesterday, end date = today.
// Names decide first (start/from/begin, end/to/until); otherwise the first two unnamed ones are start then end.
// Anything the RDL itself defaults, and anything nullable, is left exactly as the RDL says.
const START_NAME = /start|from|begin|awal|dari/i;
const END_NAME = /end|until|akhir|sampai|(^|[^a-z])to([^a-z]|$)/i;
function fillDateDefaults(def, out) {
  const blank = def.parameters.filter((p) => p.type === 'DateTime' && !p.nullable && (out[p.name] === null || out[p.name] === ''));
  if (!blank.length) return;
  const today = wallToday();
  const yesterday = new Date(today.getTime() - 86400000);
  const rest = [];
  for (const p of blank) {
    const isStart = START_NAME.test(p.name);
    const isEnd = END_NAME.test(p.name);
    if (isStart && !isEnd) out[p.name] = isoDate(yesterday);
    else if (isEnd && !isStart) out[p.name] = isoDate(today);
    else rest.push(p);
  }
  if (rest[0]) out[rest[0].name] = isoDate(yesterday);
  if (rest[1]) out[rest[1].name] = isoDate(today);
}

// Fills blank submitted values from the defaults (used by unattended runs, where nobody is there to type).
function withDefaults(def, submitted) {
  const defaults = defaultValues(def);
  const out = { ...(submitted || {}) };
  const have = new Set(Object.keys(out).filter((k) => out[k] !== undefined && out[k] !== null && out[k] !== '').map((k) => k.toLowerCase()));
  for (const p of def.parameters) {
    if (!have.has(p.name.toLowerCase())) {
      for (const k of Object.keys(out)) if (k.toLowerCase() === p.name.toLowerCase()) delete out[k];
      if (defaults[p.name] !== null && defaults[p.name] !== undefined) out[p.name] = defaults[p.name];
    }
  }
  return out;
}

function isoDate(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const midnight = !d.getUTCHours() && !d.getUTCMinutes() && !d.getUTCSeconds();
  return midnight ? date : `${date}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

// ---- rows ----
// Map driver rows to dataset fields. Column lookup is case-insensitive.
function mapRows(def, dbRows, params, now) {
  const fields = def.dataset.fields;
  const keyMap = new Map();
  if (dbRows.length) for (const k of Object.keys(dbRows[0])) keyMap.set(k.toLowerCase(), k);
  const plain = fields.filter((f) => f.dataField !== null).map((f) => ({ name: f.name.toLowerCase(), key: keyMap.get(f.dataField.toLowerCase()) }));
  const calc = fields.filter((f) => f.dataField === null && f.expr);
  const out = new Array(dbRows.length);
  for (let i = 0; i < dbRows.length; i++) {
    const src = dbRows[i];
    const f = {};
    for (const p of plain) f[p.name] = p.key === undefined ? null : src[p.key];
    const row = { i, f };
    for (const c of calc) {
      try { f[c.name.toLowerCase()] = run(c.expr, { row, params, now }); } catch (e) { f[c.name.toLowerCase()] = null; }
    }
    out[i] = row;
  }
  return out;
}

// ---- rendering ----
function keyOf(values) {
  return values.map((v) => (v instanceof Date ? 'd' + v.getTime() : v === null || v === undefined ? 'n' : typeof v + ':' + v)).join('\u0001');
}

// Which report items a layout shows: 'all' (as designed), 'matrix' (matrices only) or 'tabular' (the table only).
const LAYOUTS = ['all', 'matrix', 'tabular'];
function availableLayouts(def) {
  const hasMatrix = def.sections.some((x) => x.kind === 'matrix');
  const hasTable = def.sections.some((x) => x.kind === 'table');
  return hasMatrix && hasTable ? LAYOUTS : [];
}
function pickSections(def, layout) {
  if (layout === 'matrix') { const m = def.sections.filter((x) => x.kind === 'matrix'); if (m.length) return m; }
  if (layout === 'tabular') { const t = def.sections.filter((x) => x.kind === 'table'); if (t.length) return t; }
  return def.sections;
}

function renderGrid(def, dbRows, paramValues, opts = {}) {
  const now = wallNow();
  const warnings = new Set();
  const rows = mapRows(def, dbRows, paramValues, now);
  const baseCtx = { params: paramValues, allRows: rows, scopeRows: rows, scopes: {}, now, reportName: opts.reportName };
  const out = [];
  const sections = pickSections(def, opts.layout);
  let spec = null;
  let sec = 0;

  function evalCell(cell, ctx) {
    let acc = null;
    const pieces = [];
    for (const part of cell.parts) {
      try {
        pieces.push(run(part, ctx));
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
        warnings.add(e.message);
        // FR-15: fall back to the raw value of the first field the expression mentions
        let raw = null;
        const fieldRef = part.fields && part.fields[0];
        if (fieldRef && ctx.row && ctx.row.f[fieldRef.toLowerCase()] !== undefined) raw = ctx.row.f[fieldRef.toLowerCase()];
        pieces.push(raw);
      }
    }
    acc = pieces.length === 1 ? pieces[0] : pieces.map((v) => (v === null || v === undefined ? '' : v instanceof Date ? defaultDisplay(v) : String(v))).join('');
    return acc === undefined ? null : acc;
  }

  function emitRow(index, ctx) {
    const r = spec[index];
    const cells = [];
    for (const c of r.cells) {
      const value = evalCell(c, ctx);
      cells.push({ value, format: c.format, style: c.style, span: c.colSpan > 1 ? c.colSpan : undefined });
    }
    out.push({ kind: r.kind, cells, sec });
  }

  function partition(node, scope, ctx) {
    const exprCtx = (row) => Object.assign({}, ctx, { row, scopeRows: scope });
    let parts;
    if (!node.exprs.length) {
      parts = scope.map((r) => [r]);
    } else {
      const map = new Map();
      for (const r of scope) {
        let vals;
        try { vals = node.exprs.map((e) => run(e, exprCtx(r))); } catch (e) { warnings.add(e.message); vals = [null]; }
        const k = keyOf(vals);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(r);
      }
      parts = [...map.values()];
    }
    if (node.sorts.length) {
      const keyed = parts.map((p) => ({ p, k: node.sorts.map((s) => { try { return run(s.c, exprCtx(p[0])); } catch (e) { warnings.add(e.message); return null; } }) }));
      keyed.sort((a, b) => {
        for (let i = 0; i < node.sorts.length; i++) {
          const c = compare(a.k[i], b.k[i]);
          if (c) return node.sorts[i].desc ? -c : c;
        }
        return 0;
      });
      parts = keyed.map((x) => x.p);
    }
    return parts;
  }

  function render(nodes, scope, ctx) {
    for (const n of nodes) {
      if (n.type === 'row') {
        emitRow(n.index, Object.assign({}, ctx, { row: scope[0] || null, scopeRows: scope }));
      } else {
        for (const part of partition(n, scope, ctx)) {
          const scopes = Object.assign({}, ctx.scopes);
          if (n.name) scopes[n.name.toLowerCase()] = part;
          render(n.children, part, Object.assign({}, ctx, { scopes }));
        }
      }
    }
  }

  // ---- matrix: row groups down the side, column groups across the top, cells scoped to where the two cross ----
  function instantiate(members, scope, ctx, scopes) {
    const nodes = [];
    for (const m of members) {
      if (m.type === 'group') {
        for (const part of partition(m, scope, ctx)) {
          const sc = Object.assign({}, scopes);
          if (m.name) sc[m.name.toLowerCase()] = part;
          nodes.push({ def: m, scope: part, scopes: sc, children: instantiate(m.children, part, ctx, sc) });
        }
      } else if (!(m.hideIfNoRows && !scope.length)) {
        nodes.push({ def: m, scope, scopes, children: instantiate(m.children, scope, ctx, scopes) });
      }
    }
    return nodes;
  }
  const leafCount = (n) => (n.children.length ? n.children.reduce((a, c) => a + leafCount(c), 0) : 1);
  const leavesOf = (nodes) => nodes.flatMap((n) => (n.children.length ? leavesOf(n.children) : [n]));
  const nodeCtx = (n, ctx) => Object.assign({}, ctx, { row: n.scope[0] || null, scopeRows: n.scope, scopes: n.scopes });
  const blank = (style) => ({ value: null, format: null, style });

  function renderMatrix(m, ctx) {
    const colRoots = instantiate(m.colMembers, rows, ctx, {});
    const rowRoots = instantiate(m.rowMembers, rows, ctx, {});
    const colLeaves = leavesOf(colRoots);
    const rc = m.rowDepth;

    // column headers: one output row per level of the column hierarchy
    const hdr = Array.from({ length: m.colDepth }, () => []);
    const put = (d, cell) => { if (hdr[d]) hdr[d].push(cell); };
    (function fill(nodes, d) {
      for (const n of nodes) {
        const h = n.def.header;
        if (h) {
          const span = leafCount(n);
          put(d, { value: evalCell(h, nodeCtx(n, ctx)), format: h.format, style: h.style, span: span > 1 ? span : undefined });
          if (n.children.length) fill(n.children, d + 1);
          else for (let k = d + 1; k < m.colDepth; k++) put(k, blank());
        } else if (n.children.length) fill(n.children, d);
        else for (let k = d; k < m.colDepth; k++) put(k, blank());
      }
    })(colRoots, 0);
    hdr.forEach((cells, d) => {
      if (rc) cells.unshift({ value: d === 0 && m.corner ? evalCell(m.corner, ctx) : null, format: null, style: m.corner ? m.corner.style : null, span: rc > 1 ? rc : undefined });
      out.push({ kind: 'header', cells, sec });
    });

    // body rows: depth-first through the row hierarchy; a header shows on the first row of its group, then stays blank
    const colSets = colLeaves.map((cl) => new Set(cl.scope));
    const pending = new Array(rc).fill(null);
    const active = new Array(rc).fill(null); // header cell still repeating down the side: counts the rows it covers
    function emit(leaf) {
      const cells = [];
      for (let k = 0; k < rc; k++) {
        const p = pending[k];
        if (p) {
          pending[k] = null;
          const isLeaf = p.node === leaf;
          const hc = p.node.def.header;
          const cell = { value: evalCell(hc, nodeCtx(p.node, ctx)), format: hc.format, style: hc.style, span: isLeaf && rc - k > 1 ? rc - k : undefined };
          cells.push(cell);
          active[k] = cell;
          cell.vspan = 1;
          if (isLeaf) { for (let j = k + 1; j < rc; j++) { pending[j] = null; active[j] = null; } break; }
        } else {
          if (active[k]) active[k].vspan++;
          cells.push(blank(active[k] ? active[k].style : undefined));
        }
      }
      const bodyRow = m.rows[leaf.def.leaf];
      colLeaves.forEach((cl, ci) => {
        const spec = bodyRow && bodyRow.cells[cl.def.leaf];
        if (!spec) { cells.push(blank()); return; }
        const inter = leaf.scope.filter((r) => colSets[ci].has(r));
        if (!inter.length) { cells.push(blank()); return; }
        const c2 = Object.assign({}, ctx, { row: inter[0], scopeRows: inter, scopes: Object.assign({}, cl.scopes, leaf.scopes) });
        cells.push({ value: evalCell(spec, c2), format: spec.format, style: spec.style });
      });
      out.push({ kind: leaf.def.type === 'group' ? 'detail' : 'groupFooter', cells, sec });
    }
    (function walk(nodes, d) {
      for (const n of nodes) {
        const h = n.def.header;
        if (h) { pending[d] = { node: n }; for (let j = d; j < rc; j++) active[j] = null; }
        if (n.children.length) walk(n.children, h ? d + 1 : d);
        else emit(n);
      }
    })(rowRoots, 0);
  }

  sections.forEach((x, i) => {
    sec = i;
    if (i > 0) out.push({ kind: 'spacer', cells: [], sec });
    if (x.kind === 'matrix') renderMatrix(x.matrix, baseCtx);
    else { spec = def.table.rows; render(def.table.plan, rows, baseCtx); }
  });

  // header text for each column (first header row of the first section)
  const headerRow = out.find((r) => r.kind === 'header');
  const widest = out.reduce((n, r) => Math.max(n, r.cells.reduce((a, c) => a + (c.span || 1), 0)), 0);
  const baseWidths = sections[0].kind === 'table' ? def.table.columns : [];
  const columns = Array.from({ length: Math.max(widest, baseWidths.length) }, (_, i) => ({
    width: baseWidths[i] ? baseWidths[i].width : null,
    name: sections.length === 1 && headerRow && headerRow.cells[i] ? displayOf(headerRow.cells[i]) : `Column ${i + 1}`,
  }));
  const heading = def.textboxes.map((t) => {
    try { return displayOf({ value: evalCell(t.cell, Object.assign({}, baseCtx, { row: rows[0] || null })), format: t.cell.format }); } catch (e) { return ''; }
  }).filter((s) => s !== '');

  const headingStyle = def.textboxes[0] ? def.textboxes[0].cell.style : null;
  return { columns, rows: out, heading, headingStyle, warnings: [...warnings], rowCount: rows.length, multi: sections.length > 1 };
}

function displayOf(cell) {
  return cell.format ? formatValue(cell.value, cell.format) : defaultDisplay(cell.value);
}

module.exports = { availableLayouts, renderGrid, resolveParams, defaultValues, withDefaults, displayOf, isoDate, coerceParam };
