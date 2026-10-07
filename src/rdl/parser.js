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

function compileCell(tb, colSpan) {
  if (!tb) return { parts: [], format: null, colSpan };
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
  return { parts: runs.map((r) => (r.value === '\n' ? { literal: '\n' } : compile(r.value))), format, colSpan };
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

  const colGroups = JSON.stringify(tx.TablixColumnHierarchy || {}).includes('"Group"');
  if (colGroups) warnings.push('Column groups (matrix) are not supported; the table may render incorrectly');
  return { columns, rows, plan, warnings };
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

  // body
  const items = (report.Body && report.Body.ReportItems) || {};
  const tablixes = arr(items.Tablix);
  const tables = arr(items.Table);
  const nTables = tablixes.length + tables.length;
  if (!nTables) throw new RdlError('The report has no table. Only tabular reports are supported');
  if (nTables > 1) warnings.push('The report has more than one table; only the first is shown');
  const table = tablixes.length ? buildTablix(tablixes[0]) : buildTable(tables[0]);
  warnings.push(...table.warnings);
  const kinds = {};
  classify(table.plan, false, kinds);
  table.rows.forEach((r, i) => { r.kind = kinds[i] || 'detail'; });

  const unsupported = [...findKeys(report.Body, ['Chart', 'Subreport', 'GaugePanel', 'Map', 'Matrix'])];
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
    table: { columns: table.columns, rows: table.rows, plan: table.plan },
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
  walkPlan(table.plan);
  table.rows.forEach((r) => r.cells.forEach((c) => c.parts.forEach(check)));
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
