'use strict';
// Query guard (FR-27, FR-27a): connection accounts are not read-only, so only plain reads may run.
// Strings, comments and quoted identifiers are blanked out first, so keywords inside them never matter
// and function calls such as dbo.Part(...) are never mistaken for statements.

function blank(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  const fill = (from, to) => ' '.repeat(to - from);
  while (i < n) {
    const c = sql[i];
    const c2 = sql.slice(i, i + 2);
    if (c2 === '--' || (c === '#' && false)) {
      let j = sql.indexOf('\n', i);
      if (j < 0) j = n;
      out += fill(i, j); i = j;
    } else if (c2 === '/*') {
      let j = sql.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      out += fill(i, j); i = j;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= n) break;
        if (sql[j] === '\\' && close !== ']' && c !== '`') { j += 2; continue; } // MySQL backslash escape
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) { j += 2; continue; } // doubled quote
          if (close === ']' && sql[j + 1] === ']') { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      out += fill(i, Math.min(j, n)); i = Math.min(j, n);
    } else {
      out += c; i++;
    }
  }
  return out;
}

const FORBIDDEN = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'MERGE', 'GRANT', 'REVOKE', 'DENY',
  'EXEC', 'EXECUTE', 'CALL', 'INTO', 'SHUTDOWN', 'WAITFOR', 'BACKUP', 'RESTORE', 'KILL', 'DBCC', 'BULK',
  'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'OUTFILE', 'DUMPFILE', 'LOAD_FILE', 'DECLARE', 'PREPARE', 'HANDLER',
];
const FORBIDDEN_RE = new RegExp('\\b(' + FORBIDDEN.join('|') + ')\\b', 'i');

// Returns null when allowed, or a plain-language reason.
function checkQuery(sql) {
  const code = blank(String(sql || ''));
  const trimmed = code.replace(/^[\s(]+/, '');
  if (!trimmed.trim()) return 'The query is empty';
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) return 'Only SELECT or WITH queries are allowed';
  const body = code.replace(/;\s*$/, '');
  if (body.includes(';')) return 'Only a single statement is allowed';
  const kw = FORBIDDEN_RE.exec(body);
  if (kw) return `The keyword ${kw[1].toUpperCase()} is not allowed in report queries`;
  const sys = /\b(xp|sp)_\w+/i.exec(body);
  if (sys) return `System procedure ${sys[0]} is not allowed`;
  return null;
}

// Finds @named and ? placeholders in the code part of the query.
function scanParams(sql) {
  const code = blank(String(sql || ''));
  const named = [];
  const seen = new Set();
  const re = /(^|[^@\w$])@([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(code))) {
    const k = m[2].toLowerCase();
    if (!seen.has(k)) { seen.add(k); named.push(m[2]); }
  }
  const positional = (code.match(/\?/g) || []).length;
  return { named, positional };
}

module.exports = { checkQuery, scanParams, blank };
