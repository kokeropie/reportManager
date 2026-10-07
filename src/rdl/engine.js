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

function renderGrid(def, dbRows, paramValues, opts = {}) {
  const now = wallNow();
  const warnings = new Set();
  const rows = mapRows(def, dbRows, paramValues, now);
  const baseCtx = { params: paramValues, allRows: rows, scopeRows: rows, scopes: {}, now, reportName: opts.reportName };
  const out = [];
  const spec = def.table.rows;

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
      cells.push({ value, format: c.format, span: c.colSpan > 1 ? c.colSpan : undefined });
    }
    out.push({ kind: r.kind, cells });
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
  render(def.table.plan, rows, baseCtx);

  // header text for each column (first header row) and body text boxes (title, subtitle, ...)
  const headerRow = out.find((r) => r.kind === 'header');
  const columns = def.table.columns.map((c, i) => ({
    width: c.width,
    name: headerRow && headerRow.cells[i] ? displayOf(headerRow.cells[i]) : `Column ${i + 1}`,
  }));
  const heading = def.textboxes.map((t) => {
    try { return displayOf({ value: evalCell(t.cell, Object.assign({}, baseCtx, { row: rows[0] || null })), format: t.cell.format }); } catch (e) { return ''; }
  }).filter((s) => s !== '');

  return { columns, rows: out, heading, warnings: [...warnings], rowCount: rows.length };
}

function displayOf(cell) {
  return cell.format ? formatValue(cell.value, cell.format) : defaultDisplay(cell.value);
}

module.exports = { renderGrid, resolveParams, defaultValues, displayOf, isoDate, coerceParam };
