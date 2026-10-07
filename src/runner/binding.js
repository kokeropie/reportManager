'use strict';
// Turns the RDL's query + parameter values into driver-ready SQL and bound values (FR-18, FR-31).
// User input only ever travels as a bound value, never inside the SQL text.
const { run } = require('../rdl/expressions');
const { blank, scanParams } = require('../rdl/guard');

function valueOf(q, paramValues, now) {
  if (q.paramRef) {
    const k = q.paramRef.toLowerCase();
    return k in paramValues ? paramValues[k] : null;
  }
  return run(q.compiled, { params: paramValues, now });
}

function typeOfParam(def, q) {
  const p = q.paramRef && def.parameters.find((x) => x.name.toLowerCase() === q.paramRef.toLowerCase());
  return p ? p.type : 'String';
}

// engine: 'mssql' -> { sql, named: [{ name, type, value }] }
//         'mysql' -> { sql (with ?), values: [] }
function buildBinding(def, paramValues, engine, now) {
  const ds = def.dataset;
  const qps = ds.queryParameters;
  const positional = qps.filter((q) => q.positional);

  if (engine === 'mssql') {
    if (positional.length) throw Object.assign(new Error('This report uses "?" placeholders, which need a MySQL connection'), { status: 409 });
    const spelled = new Map(scanParams(ds.commandText).named.map((n) => [n.toLowerCase(), n]));
    const named = qps.map((q) => {
      const bare = q.name.replace(/^@/, '');
      return { name: spelled.get(bare.toLowerCase()) || bare, type: typeOfParam(def, q), value: valueOf(q, paramValues, now) };
    });
    return { sql: ds.commandText, named };
  }

  // mysql
  if (positional.length) {
    return { sql: ds.commandText, values: positional.map((q) => valueOf(q, paramValues, now)) };
  }
  // named @params -> ? in order of appearance (only the declared names; other @vars are left alone)
  const byName = new Map(qps.map((q) => [q.name.replace(/^@/, '').toLowerCase(), q]));
  const code = blank(ds.commandText);
  const re = /(^|[^@\w$])@([A-Za-z_][A-Za-z0-9_]*)/g;
  const values = [];
  let sql = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    const q = byName.get(m[2].toLowerCase());
    if (!q) continue;
    const start = m.index + m[1].length;
    sql += ds.commandText.slice(last, start) + '?';
    last = start + 1 + m[2].length;
    values.push(valueOf(q, paramValues, now));
  }
  sql += ds.commandText.slice(last);
  return { sql, values };
}

module.exports = { buildBinding };
