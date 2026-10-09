'use strict';
const { XMLParser } = require('fast-xml-parser');
const { compile, unsupportedFunctions } = require('./expressions');
const { checkQuery, scanParams } = require('./guard');

class RdlError extends Error {}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? '' : String(v));
const first = (v) => arr(v)[0];
const inches = (s) => {
  const m = /^([\d.]+)\s*(in|cm|mm|pt|pc)?$/.exec(String(s || '').trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return { in: n, cm: n / 2.54, mm: n / 25.4, pt: n / 72, pc: n / 6 }[m[2] || 'in'];
};

function findKeys(o, names, out = new Set()) {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) {
      if (names.includes(k)) out.add(k);
      findKeys(o[k], names, out);
    }
  }
  return out;
}

// ---- cells ----
function textboxOf(contents) {
  if (!contents || typeof contents !== 'object') return null;
  return first(contents.Textbox);
}

const NAMED_COLORS = { white: 'FFFFFF', black: '000000', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', silver: 'C0C0C0', orange: 'FFA500', navy: '000080', maroon: '800000', lightgrey: 'D3D3D3', lightgray: 'D3D3D3', whitesmoke: 'F5F5F5' };
function colorOf(v) {
  const t = text(v).trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t.slice(1).toUpperCase();
  return NAMED_COLORS[t.toLowerCase()] || null;
}
// Look and feel the Excel export reuses: fill, text colour, bold, size, alignment. Expressions are ignored.
function styleOf(tb, run, para) {
  const box = (tb && typeof tb.Style === 'object' && tb.Style) || {};
  const r = (run && typeof run.style === 'object' && run.style) || {};
  const pa = (para && typeof para.Style === 'object' && para.Style) || {};
  const bg = colorOf(box.BackgroundColor);
  const color = colorOf(r.Color) || colorOf(box.Color);
  const weight = text(r.FontWeight) || text(box.FontWeight);
  const bold = /^(bold|bolder|[6-9]00)$/i.test(weight);
  const sz = /^([\d.]+)pt$/i.exec(text(r.FontSize) || text(box.FontSize));
  const align = (text(pa.TextAlign) || text(r.TextAlign) || text(box.TextAlign)).toLowerCase();
  const style = {};
  if (bg) style.bg = bg;
  if (color) style.color = color;
  if (bold) style.bold = true;
  if (sz) style.size = parseFloat(sz[1]);
  if (['left', 'right', 'center'].includes(align)) style.align = align;
  return Object.keys(style).length ? style : null;
}

function compileCell(tb, colSpan) {
  if (!tb) return { parts: [], format: null, style: null, colSpan };
  let runs = [];
  const paras = arr(tb.Paragraphs && tb.Paragraphs.Paragraph);
  if (paras.length) {
    paras.forEach((p, pi) => {
      const rs = arr(p.TextRuns && p.TextRuns.TextRun);
      if (pi > 0) runs.push({ value: '\n', style: null });
      rs.forEach((r) => runs.push({ value: text(r.Value), style: r.Style }));
    });
  } else if (tb.Value !== undefined) { // 2005 schema
    runs = [{ value: text(tb.Value), style: tb.Style }];
  }
  const fmtOf = (s) => (s && typeof s === 'object' && s.Format ? text(s.Format) : null);
  const format = runs.map((r) => fmtOf(r.style)).find(Boolean) || fmtOf(tb.Style) || null;
  const firstPara = paras[0];
  const firstRun = runs.find((r) => r.value !== '\n') || runs[0];
  return { parts: runs.map((r) => (r.value === '\n' ? { literal: '\n' } : compile(r.value))), format, style: styleOf(tb, firstRun, firstPara), colSpan };
}

// ---- 2008+ Tablix ----
function buildTablix(tx) {
  const columns = arr(tx.TablixBody.TablixColumns && tx.TablixBody.TablixColumns.TablixColumn).map((c) => ({ width: inches(c.Width) }));
  const rows = arr(tx.TablixBody.TablixRows && tx.TablixBody.TablixRows.TablixRow).map((r) => ({
    cells: arr(r.TablixCells && r.TablixCells.TablixCell).map((c) => {
      const contents = c.CellContents || {};
      return compileCell(textboxOf(contents), parseInt(text(contents.ColSpan) || '1', 10) || 1);
    }),
  }));

  let counter = 0;
  const warnings = [];
  function convert(m) {
    m = m && typeof m === 'object' ? m : {};
    const kids = arr(m.TablixMembers && m.TablixMembers.TablixMember);
    if (m.Group) {
      const g = m.Group;
      const node = {
        type: 'group',
        name: g['@_Name'] || '',
        exprs: arr(g.GroupExpressions && g.GroupExpressions.GroupExpression).map((e) => compile(text(e))),
        sorts: arr(m.SortExpressions && m.SortExpressions.SortExpression).map((s) => ({ c: compile(text(s.Value)), desc: /desc/i.test(text(s.Direction)) })),
        isDetail: text(g.DataElementName) === 'Detail' || /Details?_?Group$/i.test(g['@_Name'] || ''),
        children: [],
      };
      node.children = kids.length ? kids.flatMap(convert) : [{ type: 'row', index: counter++ }];
      return [node];
    }
    if (kids.length) return kids.flatMap(convert);
    return [{ type: 'row', index: counter++ }];
  }
  const plan = arr(tx.TablixRowHierarchy && tx.TablixRowHierarchy.TablixMembers && tx.TablixRowHierarchy.TablixMembers.TablixMember).flatMap(convert);
  if (counter !== rows.length) warnings.push(`Row layout does not match its row hierarchy (${counter} vs ${rows.length}); the table may render incorrectly`);

  return { columns, rows, plan, warnings };
}

// ---- Matrix (a Tablix with column groups) ----
function memberHeader(m) {
  const hd = m.TablixHeader;
  if (!hd || typeof hd !== 'object') return null;
  const tb = textboxOf(hd.CellContents);
  return tb ? compileCell(tb, 1) : null;
}

function buildMatrix(tx) {
  const body = tx.TablixBody || {};
  const columns = arr(body.TablixColumns && body.TablixColumns.TablixColumn).map((c) => ({ width: inches(c.Width) }));
  const rows = arr(body.TablixRows && body.TablixRows.TablixRow).map((r) => ({
    cells: arr(r.TablixCells && r.TablixCells.TablixCell).map((c) => {
      const contents = c.CellContents || {};
      return compileCell(textboxOf(contents), 1);
    }),
  }));
  const warnings = [];

  // Each member becomes { type: 'group'|'static', header, exprs, sorts, children, leaf } where leaf is the index of the
  // body row (row hierarchy) or body column (column hierarchy) that a childless member owns.
  function hierarchy(root) {
    let counter = 0;
    const convert = (m) => {
      m = m && typeof m === 'object' ? m : {};
      const kids = arr(m.TablixMembers && m.TablixMembers.TablixMember);
      const g = m.Group;
      const node = {
        type: g ? 'group' : 'static',
        name: g ? g['@_Name'] || '' : '',
        exprs: g ? arr(g.GroupExpressions && g.GroupExpressions.GroupExpression).map((e) => compile(text(e))) : [],
        sorts: arr(m.SortExpressions && m.SortExpressions.SortExpression).map((s) => ({ c: compile(text(s.Value)), desc: /desc/i.test(text(s.Direction)) })),
        header: memberHeader(m),
        hideIfNoRows: /^true$/i.test(text(m.HideIfNoRows)),
        children: kids.map(convert),
        leaf: null,
      };
      if (!node.children.length) node.leaf = counter++;
      return node;
    };
    const members = arr(root && root.TablixMembers && root.TablixMembers.TablixMember).map(convert);
    return { members, leaves: counter };
  }
  const depthOf = (nodes) => Math.max(0, ...nodes.map((n) => (n.header ? 1 : 0) + depthOf(n.children)));

  const colH = hierarchy(tx.TablixColumnHierarchy);
  const rowH = hierarchy(tx.TablixRowHierarchy);
  if (colH.leaves !== columns.length) warnings.push(`Matrix column layout does not match its column hierarchy (${colH.leaves} vs ${columns.length}); it may render incorrectly`);
  if (rowH.leaves !== rows.length) warnings.push(`Matrix row layout does not match its row hierarchy (${rowH.leaves} vs ${rows.length}); it may render incorrectly`);

  const cornerRows = arr(tx.TablixCorner && tx.TablixCorner.TablixCornerRows && tx.TablixCorner.TablixCornerRows.TablixCornerRow);
  const corner = arr(cornerRows[0] && cornerRows[0].TablixCornerCell)[0];
  const cornerCell = corner && corner.CellContents ? compileCell(textboxOf(corner.CellContents), 1) : null;
  return {
    name: tx['@_Name'] || '', top: inches(tx.Top) || 0,
    columns, rows, colMembers: colH.members, rowMembers: rowH.members,
    colDepth: depthOf(colH.members), rowDepth: depthOf(rowH.members), corner: cornerCell, warnings,
  };
}

const isMatrix = (tx) => !!tx.TablixCorner || JSON.stringify(tx.TablixColumnHierarchy || {}).includes('"Group"');

// ---- 2005 Matrix: nested row/column groupings, each level optionally with a Subtotal ----
function buildMatrix2005(mx) {
  const warnings = [];
  const textOf = (ri) => { const tb = first(ri && ri.Textbox); return tb ? compileCell(tb, 1) : null; };
  const columns = arr(mx.MatrixColumns && mx.MatrixColumns.MatrixColumn).map((c) => ({ width: inches(c.Width) }));
  const rows = arr(mx.MatrixRows && mx.MatrixRows.MatrixRow).map((r) => ({
    cells: arr(r.MatrixCells && r.MatrixCells.MatrixCell).map((c) => compileCell(first(c.ReportItems && c.ReportItems.Textbox), 1)),
  }));

  // A level is { dynamic: { grouping, sorting, header, subtotal } } or { statics: [header, ...] }.
  const levelsOf = (list, dynKey, staticKey, staticItem) => arr(list).map((g) => {
    if (g[dynKey]) {
      const d = g[dynKey];
      const grouping = d.Grouping || {};
      return {
        group: {
          name: grouping['@_Name'] || '',
          exprs: arr(grouping.GroupExpressions && grouping.GroupExpressions.GroupExpression).map((e) => compile(text(e))),
          sorts: arr(d.Sorting && d.Sorting.SortBy).map((x) => ({ c: compile(text(x.SortExpression)), desc: /desc/i.test(text(x.Direction)) })),
        },
        header: textOf(d.ReportItems),
        subtotal: d.Subtotal ? textOf(d.Subtotal.ReportItems) || { parts: [], format: null, style: null, colSpan: 1 } : null,
      };
    }
    const st = g[staticKey] || {};
    return { statics: arr(st[staticItem]).map((x) => textOf(x.ReportItems)) };
  });

  // Turns the levels into the same member tree the 2008 matrix uses. "n" body rows/columns of the matrix are
  // the leaves: every leaf (and every subtotal) points at the body row/column it takes its cells from.
  function members(levels, bodyCount) {
    const leafSet = (header, index) => ({ type: 'static', name: '', exprs: [], sorts: [], header, hideIfNoRows: false, children: [], leaf: index });
    const bodyLeaves = (header) => (bodyCount > 1
      ? Array.from({ length: bodyCount }, (_, i) => leafSet(i === 0 ? header : null, i))
      : [leafSet(header, 0)]);
    const build = (i) => {
      if (i >= levels.length) return bodyLeaves(null);
      const lv = levels[i];
      if (lv.statics) {
        // static entries: one leaf each, in order, taking body rows 0..n-1
        return lv.statics.map((h, k) => leafSet(h, Math.min(k, bodyCount - 1)));
      }
      const g = lv.group;
      const node = { type: 'group', name: g.name, exprs: g.exprs, sorts: g.sorts, header: lv.header, hideIfNoRows: false, children: [], leaf: null };
      if (i + 1 < levels.length) node.children = build(i + 1);
      else if (bodyCount > 1) node.children = bodyLeaves(null).map((k) => Object.assign(k, { detail: true }));
      else node.leaf = 0;
      const out = [node];
      if (lv.subtotal) {
        const sub = bodyCount > 1 ? Object.assign(leafSet(lv.subtotal, null), { leaf: null, children: bodyLeaves(null) }) : leafSet(lv.subtotal, 0);
        out.push(sub);
      }
      return out;
    };
    return build(0);
  }
  const depthOf = (nodes) => Math.max(0, ...nodes.map((n) => (n.header ? 1 : 0) + depthOf(n.children)));

  const colLevels = levelsOf(mx.ColumnGroupings && mx.ColumnGroupings.ColumnGrouping, 'DynamicColumns', 'StaticColumns', 'StaticColumn');
  const rowLevels = levelsOf(mx.RowGroupings && mx.RowGroupings.RowGrouping, 'DynamicRows', 'StaticRows', 'StaticRow');
  const colMembers = members(colLevels, Math.max(1, columns.length));
  const rowMembers = members(rowLevels, Math.max(1, rows.length));
  return {
    name: mx['@_Name'] || '', top: inches(mx.Top) || 0,
    columns, rows, colMembers, rowMembers,
    colDepth: depthOf(colMembers), rowDepth: depthOf(rowMembers), corner: textOf(mx.CornerHeader), warnings,
  };
}

// ---- 2005 Table ----
function buildTable(tb) {
  const columns = arr(tb.TableColumns && tb.TableColumns.TableColumn).map((c) => ({ width: inches(c.Width) }));
  const rows = [];
  const rowsOf = (section) => arr(section && section.TableRows && section.TableRows.TableRow).map((r) => {
    rows.push({
      cells: arr(r.TableCells && r.TableCells.TableCell).map((c) => compileCell(first(c.ReportItems && c.ReportItems.Textbox), parseInt(text(c.ColSpan) || '1', 10) || 1)),
    });
    return { type: 'row', index: rows.length - 1 };
  });
  const header = rowsOf(tb.Header);
  const groups = arr(tb.TableGroups && tb.TableGroups.TableGroup);
  const detailRows = rowsOf(tb.Details);
  let inner = [{ type: 'group', name: 'Details', exprs: [], sorts: [], isDetail: true, children: detailRows }];
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    const grouping = g.Grouping || {};
    const gh = rowsOf(g.Header); // built after inner rows would reorder indexes, so order is fixed up below
    inner = [{
      type: 'group', name: grouping['@_Name'] || `Group${gi + 1}`,
      exprs: arr(grouping.GroupExpressions && grouping.GroupExpressions.GroupExpression).map((e) => compile(text(e))),
      sorts: arr(g.Sorting && g.Sorting.SortBy).map((s) => ({ c: compile(text(s.SortExpression)), desc: /desc/i.test(text(s.Direction)) })),
      isDetail: false,
      children: [...gh, ...inner, ...rowsOf(g.Footer)],
    }];
  }
  const footer = rowsOf(tb.Footer);
  return { columns, rows, plan: [...header, ...inner, ...footer], warnings: [] };
}

// Label every row leaf: header / footer / groupHeader / groupFooter / detail.
function classify(children, inGroup, kinds) {
  const hasGroup = (n) => n.type === 'group';
  const firstData = children.findIndex(hasGroup);
  children.forEach((n, i) => {
    if (n.type === 'row') {
      if (firstData < 0) kinds[n.index] = inGroup ? 'detail' : 'header';
      else kinds[n.index] = i < firstData ? (inGroup ? 'groupHeader' : 'header') : inGroup ? 'groupFooter' : 'footer';
    } else classify(n.children, true, kinds), n.isDetail && markDetail(n, kinds);
  });
}
function markDetail(g, kinds) {
  g.children.forEach((c) => { if (c.type === 'row') kinds[c.index] = 'detail'; });
}

function typeName(t) {
  const s = text(t).replace(/^System\./, '');
  return s || 'String';
}

function parseRdl(xmlText) {
  let doc;
  try {
    doc = xml.parse(String(xmlText).replace(/^﻿/, ''));
  } catch (e) {
    throw new RdlError('The file is not valid XML: ' + e.message);
  }
  const report = doc && doc.Report;
  if (!report || typeof report !== 'object') throw new RdlError('The file is not an RDL report (no <Report> element)');
  const warnings = [];
  const errors = [];

  const schema = (/xmlns="[^"]*reporting\/(\d{4})\//.exec(String(xmlText).slice(0, 2000)) || [])[1] || 'unknown';

  // data source + dataset
  const dataSources = arr(report.DataSources && report.DataSources.DataSource).map((d) => ({
    name: d['@_Name'] || '',
    reference: text(d.DataSourceReference) || d['@_Name'] || '',
  }));
  const dsList = arr(report.DataSets && report.DataSets.DataSet);
  if (!dsList.length) throw new RdlError('The report has no dataset');
  if (dsList.length > 1) warnings.push(`The report has ${dsList.length} datasets; only the first (${dsList[0]['@_Name']}) is used`);
  const ds = dsList[0];
  const query = ds.Query || {};
  const commandText = text(query.CommandText);
  if (!commandText.trim()) throw new RdlError('The dataset has no query text');
  const commandType = text(query.CommandType) || 'Text';
  if (/storedprocedure/i.test(commandType)) errors.push('Stored procedure datasets are not supported');
  const dsName = text(query.DataSourceName);
  const source = dataSources.find((d) => d.name === dsName) || dataSources[0] || { name: dsName, reference: dsName };

  const fields = arr(ds.Fields && ds.Fields.Field).map((f) => ({
    name: f['@_Name'],
    dataField: f.DataField !== undefined ? text(f.DataField) : null,
    expr: f.Value !== undefined ? compile(text(f.Value)) : null,
    type: typeName(f.TypeName),
  }));

  // parameters
  const parameters = arr(report.ReportParameters && report.ReportParameters.ReportParameter).map((p) => {
    const def = p.DefaultValue || {};
    const valid = p.ValidValues || {};
    const staticValues = arr(valid.ParameterValues && valid.ParameterValues.ParameterValue).map((v) => ({
      value: text(v.Value), label: text(v.Label) || text(v.Value),
    }));
    const param = {
      name: p['@_Name'],
      type: text(p.DataType) || 'String',
      prompt: text(p.Prompt) || p['@_Name'],
      nullable: /^true$/i.test(text(p.Nullable)),
      allowBlank: /^true$/i.test(text(p.AllowBlank)),
      multiValue: /^true$/i.test(text(p.MultiValue)),
      hidden: /^true$/i.test(text(p.Hidden)),
      defaultRaw: def.Values ? text(first(def.Values.Value)) : null,
      defaultFromDataset: !!def.DataSetReference,
      validValues: staticValues.length ? staticValues : null,
      validFromDataset: !!valid.DataSetReference,
    };
    param.defaultCompiled = param.defaultRaw !== null && param.defaultRaw !== '' ? compile(param.defaultRaw) : null;
    if (param.multiValue) warnings.push(`Parameter "${param.name}" is multi-value, which is not supported; it is treated as a single value`);
    if (param.validFromDataset) warnings.push(`Parameter "${param.name}" gets its choices from a dataset, which is not supported; a plain input is shown`);
    if (param.defaultFromDataset) warnings.push(`Parameter "${param.name}" gets its default from a dataset, which is not supported`);
    return param;
  });
  const paramByLower = new Map(parameters.map((p) => [p.name.toLowerCase(), p]));

  // query parameters (FR-31: order preserved; FR-16b: literals pass through)
  const queryParameters = arr(query.QueryParameters && query.QueryParameters.QueryParameter).map((q) => {
    const raw = text(q.Value);
    const m = /^=\s*Parameters!([A-Za-z_][A-Za-z0-9_]*)\.Value\s*$/i.exec(raw);
    return {
      name: q['@_Name'],
      positional: q['@_Name'] === '?' || q['@_Name'] === '',
      paramRef: m ? m[1] : null,
      compiled: m ? null : compile(raw),
      raw,
    };
  });
  const scan = scanParams(commandText);
  const guardMsg = checkQuery(commandText);
  if (guardMsg) errors.push(guardMsg);

  const positionalDeclared = queryParameters.filter((q) => q.positional).length;
  if (positionalDeclared || scan.positional) {
    if (scan.positional !== positionalDeclared) {
      errors.push(`The query has ${scan.positional} "?" placeholder(s) but the report declares ${positionalDeclared} unnamed query parameter(s)`);
    }
  }
  const namedDeclared = new Set(queryParameters.filter((q) => !q.positional).map((q) => q.name.replace(/^@/, '').toLowerCase()));
  if (!positionalDeclared) {
    for (const n of scan.named) {
      if (!namedDeclared.has(n.toLowerCase())) errors.push(`The query uses @${n} but it is not listed in the dataset's query parameters`);
    }
  }
  for (const q of queryParameters) {
    if (q.paramRef && !paramByLower.has(q.paramRef.toLowerCase())) {
      errors.push(`Query parameter ${q.name} refers to an unknown report parameter "${q.paramRef}"`);
    }
  }

  // body: every matrix is shown; of the plain tables only the first
  const items = (report.Body && report.Body.ReportItems) || {};
  const allTablix = arr(items.Tablix);
  const matrixTx = allTablix.filter(isMatrix);
  const tablixes = allTablix.filter((t) => !isMatrix(t));
  const tables = arr(items.Table);
  const matrices0 = [...matrixTx, ...arr(items.Matrix)];
  const nTables = tablixes.length + tables.length;
  if (!nTables && !matrices0.length) throw new RdlError('The report has no table or matrix. Only tabular and matrix reports are supported');
  if (nTables > 1) warnings.push('The report has more than one table; only the first is shown');
  const table = nTables ? (tablixes.length ? buildTablix(tablixes[0]) : buildTable(tables[0])) : null;
  const tableTop = nTables ? inches((tablixes.length ? tablixes[0] : tables[0]).Top) || 0 : 0;
  const matrices = [...matrixTx.map(buildMatrix), ...arr(items.Matrix).map(buildMatrix2005)];
  if (table) {
    warnings.push(...table.warnings);
    const kinds = {};
    classify(table.plan, false, kinds);
    table.rows.forEach((r, i) => { r.kind = kinds[i] || 'detail'; });
  }
  matrices.forEach((m) => warnings.push(...m.warnings));
  const sections = [
    ...matrices.map((m) => ({ kind: 'matrix', top: m.top, matrix: m })),
    ...(table ? [{ kind: 'table', top: tableTop }] : []),
  ].sort((a, b) => a.top - b.top);

  const unsupported = [...findKeys(report.Body, ['Chart', 'Subreport', 'GaugePanel', 'Map'])];
  if (unsupported.length) warnings.push(`Unsupported report items were ignored: ${unsupported.join(', ')}`);
  if (tablixes[0] && JSON.stringify(tablixes[0].TablixBody).includes('"Subreport"')) warnings.push('A subreport inside the table was ignored');

  // title and other text boxes (evaluated with parameters when the report runs)
  const textboxes = arr(items.Textbox).map((tb) => ({
    top: inches(tb.Top) || 0,
    cell: compileCell(tb, 1),
    style: tb.Style && tb.Style.TextAlign ? text(tb.Style.TextAlign) : null,
  })).sort((a, b) => a.top - b.top);
  const titleBox = textboxes[0];
  const titleLiteral = titleBox && titleBox.cell.parts.length === 1 && titleBox.cell.parts[0].literal !== undefined ? titleBox.cell.parts[0].literal : null;

  const def = {
    schema,
    title: titleLiteral || null,
    dataSource: source,
    dataset: { name: ds['@_Name'] || 'DataSet1', fields, commandText, commandType, queryParameters },
    parameters,
    table: table ? { columns: table.columns, rows: table.rows, plan: table.plan } : null,
    matrices,
    sections: sections.map((x) => ({ kind: x.kind, matrix: x.matrix || null })),
    textboxes,
    warnings,
    errors,
  };

  // static checks: unknown functions (FR-37), unknown fields/parameters
  const fieldNames = new Set(fields.map((f) => f.name.toLowerCase()));
  const funcs = new Set(); const badFields = new Set(); const badParams = new Set(); const syntax = [];
  const check = (c) => {
    if (!c) return;
    if (c.error) { syntax.push(c.error); return; }
    unsupportedFunctions(c).forEach((f) => funcs.add(f));
    c.fields.forEach((f) => { if (!fieldNames.has(f.toLowerCase())) badFields.add(f); });
    c.params.forEach((p) => { if (!paramByLower.has(p.toLowerCase())) badParams.add(p); });
  };
  const walkPlan = (nodes) => nodes.forEach((n) => { if (n.type === 'group') { n.exprs.forEach(check); n.sorts.forEach((s) => check(s.c)); walkPlan(n.children); } });
  if (table) {
    walkPlan(table.plan);
    table.rows.forEach((r) => r.cells.forEach((c) => c.parts.forEach(check)));
  }
  const walkMembers = (nodes) => nodes.forEach((n) => {
    n.exprs.forEach(check); n.sorts.forEach((x) => check(x.c));
    if (n.header) n.header.parts.forEach(check);
    walkMembers(n.children);
  });
  matrices.forEach((m) => {
    walkMembers(m.colMembers); walkMembers(m.rowMembers);
    m.rows.forEach((r) => r.cells.forEach((c) => c.parts.forEach(check)));
    if (m.corner) m.corner.parts.forEach(check);
  });
  textboxes.forEach((t) => t.cell.parts.forEach(check));
  parameters.forEach((p) => check(p.defaultCompiled));
  fields.forEach((f) => check(f.expr));
  queryParameters.forEach((q) => check(q.compiled));
  if (funcs.size) warnings.push(`Unsupported function(s): ${[...funcs].join(', ')}. Cells using them show the raw field value`);
  if (badFields.size) warnings.push(`Expressions use field(s) that are not in the dataset: ${[...badFields].join(', ')}`);
  if (badParams.size) warnings.push(`Expressions use parameter(s) that are not defined: ${[...badParams].join(', ')}`);
  if (syntax.length) warnings.push(`Expression syntax problem(s): ${[...new Set(syntax)].join('; ')}`);

  return def;
}

module.exports = { parseRdl, RdlError };
