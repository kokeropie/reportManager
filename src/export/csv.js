'use strict';
const { defaultDisplay, formatValue } = require('../rdl/formats');

const BOM = '﻿';

// Text for one cell. Numbers stay plain (no thousands separators) unless the RDL gave a format.
function csvText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return cell.format ? formatValue(v, cell.format) : defaultDisplay(v);
  if (typeof v === 'number') return cell.format ? formatValue(v, cell.format) : String(v);
  if (typeof v === 'boolean') return defaultDisplay(v);
  const s = String(v);
  // Spreadsheet formula injection: a text value that starts like a formula is neutralised with a leading quote.
  return /^[=+@\t\r]/.test(s) || (/^-/.test(s) && Number.isNaN(Number(s))) ? "'" + s : s;
}

function csvField(s) {
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// One output line per grid row; a cell with a column span is followed by empty cells so columns stay aligned.
function csvLine(row, columnCount) {
  const out = [];
  for (const c of row.cells) {
    out.push(csvField(csvText(c)));
    for (let i = 1; i < (c.span || 1); i++) out.push('');
  }
  while (out.length < columnCount) out.push('');
  return out.join(',') + '\r\n';
}

// Streams to a writable (the HTTP response), honouring back-pressure so memory stays flat.
async function writeCsv(res, grid) {
  const write = (chunk) => (res.write(chunk) ? null : new Promise((r) => res.once('drain', r)));
  const n = grid.columns.length;
  let buf = BOM;
  for (const row of grid.rows) {
    buf += csvLine(row, n);
    if (buf.length > 64 * 1024) { await write(buf); buf = ''; }
  }
  if (buf) await write(buf);
  res.end();
}

module.exports = { writeCsv, csvLine, csvText, BOM };
