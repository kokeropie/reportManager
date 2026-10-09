'use strict';
const { resolveParams, renderGrid, defaultValues, withDefaults, displayOf, availableLayouts } = require('../rdl/engine');
const { buildBinding } = require('../runner/binding');
const { wallNow } = require('../rdl/expressions');

const bad = (msg, status = 400, extra) => Object.assign(new Error(msg), { status }, extra);

// Plain-language error, with the driver message kept for the collapsible detail (FR-21).
function explain(err, cfg) {
  const msg = (err && err.message) || String(err);
  const code = err && err.code;
  let summary = 'The query failed.';
  if (/timeout|timed out|ETIMEDOUT|ETIMEOUT/i.test(msg + code) && !/ECONNREFUSED/.test(msg)) {
    summary = `The query took longer than ${cfg.queryTimeoutSeconds} seconds and was stopped.`;
    if (/connect/i.test(msg)) summary = 'Could not connect to the database (timed out).';
  } else if (/ELOGIN|Login failed|Access denied|ECONNREFUSED|ESOCKET|ENOTFOUND|EHOSTUNREACH|getaddrinfo|ECONNRESET|connect/i.test(msg + code)) {
    summary = 'Could not connect to the database. Check the connection with an administrator.';
  }
  return bad(summary, 502, { detail: msg });
}

function createRunService({ reports, connections, pools, execute, limiter, runStore, cfg }) {
  async function context(reportId, isAdmin) {
    const row = await reports.getRow(reportId);
    if (!row) throw bad('Not found', 404);
    const def = await reports.loadDef(row);
    return { row, def };
  }

  const cell = (c) => ({ text: displayOf(c), num: typeof c.value === 'number' || undefined, span: c.span });
  const line = (r) => ({ kind: r.kind, sec: r.sec, cells: r.cells.map(cell) });

  function pageOf(entry, page, pageSize) {
    const body = entry.body;
    const totalPages = Math.max(1, Math.ceil(body.length / pageSize));
    const p = Math.min(Math.max(1, page), totalPages);
    const picked = body.slice((p - 1) * pageSize, p * pageSize);
    let slice;
    if (entry.sectionHeaders) {
      // several tables on one screen: each block on this page gets its own header rows
      slice = [];
      let cur = -1;
      for (const r of picked) {
        if (r.sec !== cur) { cur = r.sec; slice.push(...(entry.sectionHeaders[cur] || [])); }
        slice.push(r);
      }
      slice = slice.map(line);
    } else slice = picked.map(line);
    return {
      page: p, pageSize, totalPages, totalRows: body.length,
      truncated: entry.truncated, maxRows: entry.cap || cfg.maxRows, canLoadAll: !!entry.truncated && !entry.loadedAll && (cfg.exportMaxRows || 0) > cfg.maxRows,
      heading: entry.heading,
      columns: entry.columns,
      layout: entry.layout,
      multi: !!entry.sectionHeaders,
      header: entry.header.map(line),
      rows: slice,
      footer: p === totalPages ? entry.footer.map(line) : [],
      warnings: entry.warnings,
    };
  }

  return {
    // Metadata the parameter form needs. Connection details are never included.
    async describe(reportId, isAdmin) {
      const { row, def } = await context(reportId, isAdmin);
      const defaults = defaultValues(def);
      const head = renderGrid(def, [], resolveParams(def, defaults).values, { reportName: row.name });
      return {
        ...reports.publicReport(row),
        connectionId: isAdmin ? row.connection_id : undefined,
        dataSourceName: isAdmin ? row.datasource_name : undefined,
        configured: !!row.connection_id,
        schema: def.schema,
        parameters: def.parameters.map((p) => ({
          name: p.name, prompt: p.prompt, type: p.type, hidden: p.hidden, nullable: p.nullable, allowBlank: p.allowBlank,
          validValues: p.validValues, default: defaults[p.name],
        })),
        columns: head.columns.map((c) => c.name),
        layouts: availableLayouts(def),
        warnings: JSON.parse(row.warnings || '[]'),
      };
    },

    // Shared by the screen run and the exports: validate, bind, query, render.
    // fillBlanks: unattended runs fill missing values from the defaults (yesterday / today for blank dates).
    async fetchGrid(reportId, submitted, maxRows, { fillBlanks = false, layout } = {}) {
      const { row, def } = await context(reportId);
      if (!row.connection_id) throw bad('Not configured, contact an administrator', 409);
      const { values, errors } = resolveParams(def, fillBlanks ? withDefaults(def, submitted) : submitted);
      if (errors.length) throw bad(errors.join('. '), 400, { details: errors });

      const conn = await connections.getWithSecret(row.connection_id);
      if (!conn) throw bad('Not configured, contact an administrator', 409);
      let binding;
      try { binding = buildBinding(def, values, conn.type, wallNow()); } catch (e) {
        throw e.status ? e : bad(e.message, 400);
      }

      let result;
      try {
        result = await limiter.run(async () => {
          const entry = await pools.get(conn);
          return execute(entry, binding, { maxRows, timeoutMs: cfg.queryTimeoutSeconds * 1000 });
        });
      } catch (e) {
        throw explain(e, cfg);
      }
      const grid = renderGrid(def, result.rows, values, { reportName: row.name, layout });
      return { row, def, grid, truncated: result.truncated, values };
    },

    // loadAll: the user confirmed they want past the screen cap; the larger export cap applies instead.
    async run(reportId, submitted, { userId, page = 1, pageSize, layout, loadAll = false }) {
      const cap = loadAll ? Math.max(cfg.maxRows, cfg.exportMaxRows || 0) : cfg.maxRows;
      const { row, grid, truncated } = await this.fetchGrid(reportId, submitted, cap, { layout });
      const warnings = grid.warnings.slice();
      if (truncated) warnings.push(`Only the first ${cap.toLocaleString('en-US')} rows were loaded. Narrow the parameters to see everything`);
      const entry = grid.multi ? {
        // stacked tables: headers travel with their block, footers are plain rows of the block
        userId, reportId, layout: layout || 'all', cap, loadedAll: loadAll,
        columns: grid.columns, heading: grid.heading, warnings, truncated,
        header: [], footer: [],
        sectionHeaders: grid.rows.reduce((acc, r) => { if (r.kind === 'header') (acc[r.sec] = acc[r.sec] || []).push(r); return acc; }, {}),
        body: grid.rows.filter((r) => r.kind !== 'header' && r.kind !== 'spacer'),
      } : {
        userId, reportId, layout: layout || 'all', cap, loadedAll: loadAll,
        columns: grid.columns, heading: grid.heading, warnings, truncated,
        header: grid.rows.filter((r) => r.kind === 'header'),
        footer: grid.rows.filter((r) => r.kind === 'footer'),
        body: grid.rows.filter((r) => r.kind !== 'header' && r.kind !== 'footer'),
      };
      const runId = runStore.put(entry);
      return { runId, reportName: row.name, dataRows: grid.rowCount, ...pageOf(entry, page, pageSize || cfg.pageSize) };
    },

    // FR-24: runs the query again with its own, larger cap. Over the cap is an error, never a silent cut.
    async exportData(reportId, submitted, opts) {
      const cap = cfg.exportMaxRows || 500000;
      const out = await this.fetchGrid(reportId, submitted, cap, opts);
      if (out.truncated) throw bad(`The result has more than ${cap.toLocaleString('en-US')} rows, which is the export limit. Narrow the parameters and try again`, 413);
      return { reportName: out.row.name, grid: out.grid };
    },

    page(runId, userId, page, pageSize) {
      const entry = runStore.get(runId, userId);
      if (!entry) throw bad('This result has expired. Run the report again', 404);
      return { runId, ...pageOf(entry, page, pageSize || cfg.pageSize) };
    },
  };
}

module.exports = { createRunService, explain };
