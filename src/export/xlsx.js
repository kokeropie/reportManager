'use strict';
const ExcelJS = require('exceljs');

// .NET format code -> Excel number format (best effort; unknown codes fall back to General).
function excelNumFmt(fmt, isDate) {
  if (!fmt) return isDate ? null : null;
  let m;
  if ((m = /^[Nn](\d*)$/.exec(fmt))) { const d = m[1] === '' ? 2 : +m[1]; return '#,##0' + (d ? '.' + '0'.repeat(d) : ''); }
  if ((m = /^[Ff](\d*)$/.exec(fmt))) { const d = m[1] === '' ? 2 : +m[1]; return '0' + (d ? '.' + '0'.repeat(d) : ''); }
  if ((m = /^[Pp](\d*)$/.exec(fmt))) { const d = m[1] === '' ? 2 : +m[1]; return '0' + (d ? '.' + '0'.repeat(d) : '') + '%'; }
  if (/^[Cc]\d*$/.test(fmt)) return '#,##0.00';
  if (isDate) {
    const std = { d: 'mm/dd/yyyy', D: 'dddd, mmmm dd, yyyy', t: 'hh:mm AM/PM', T: 'hh:mm:ss AM/PM', g: 'mm/dd/yyyy hh:mm AM/PM', G: 'mm/dd/yyyy hh:mm:ss AM/PM', s: 'yyyy-mm-dd"T"hh:mm:ss' };
    if (std[fmt]) return std[fmt];
    return fmt.replace(/tt/g, 'AM/PM').replace(/M/g, 'm').replace(/H/g, 'h').replace(/\\/g, '');
  }
  return fmt.split(';')[0];
}

const INVALID_SHEET_CHARS = /[\\/?*[\]:]/g;

// Streaming writer: rows are committed as they are added, so memory use does not grow with the result.
async function writeXlsx(res, grid, { sheetName }) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
  const headerCount = grid.rows.filter((r) => r.kind === 'header').length;
  const ws = wb.addWorksheet(String(sheetName || 'Report').replace(INVALID_SHEET_CHARS, ' ').slice(0, 31) || 'Report', {
    views: headerCount ? [{ state: 'frozen', ySplit: headerCount }] : [],
  });
  ws.columns = grid.columns.map((c) => ({ width: Math.min(60, Math.max(8, Math.round((c.width || 1) * 13))) }));

  for (const r of grid.rows) {
    const values = [];
    const fmts = [];
    for (const c of r.cells) {
      let v = c.value;
      if (v === undefined) v = null;
      if (typeof v === 'string' && /^[=+@]/.test(v)) v = "'" + v; // never let text become a formula
      values.push(v);
      let nf = null;
      if (v instanceof Date) nf = excelNumFmt(c.format, true) || (v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds() ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd');
      else if (typeof v === 'number') nf = excelNumFmt(c.format, false);
      fmts.push(nf);
      for (let i = 1; i < (c.span || 1); i++) { values.push(null); fmts.push(null); }
    }
    const row = ws.addRow(values);
    fmts.forEach((nf, i) => { if (nf) row.getCell(i + 1).numFmt = nf; });
    if (r.kind === 'header' || r.kind === 'footer' || r.kind === 'groupHeader' || r.kind === 'groupFooter') row.font = { bold: true };
    row.commit();
  }
  await ws.commit();
  await wb.commit();
}

module.exports = { writeXlsx, excelNumFmt };
