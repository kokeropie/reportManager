'use strict';
const ExcelJS = require('exceljs');
const Range = require('exceljs/lib/doc/range');

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

// The streaming writer cannot merge across rows it has already committed, but it writes the merge list only at the end,
// so ranges are recorded straight into that list.
function merge(ws, top, left, bottom, right) {
  ws._merges.push(new Range(top, left, bottom, right));
}

const INVALID_SHEET_CHARS = /[\\/?*[\]:]/g;

const THIN = { style: 'thin', color: { argb: 'FF808080' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const argb = (hex) => 'FF' + hex;

// Look taken from the RDL (fill, text colour, bold, size, alignment) plus thin borders, like the SSRS Excel render.
function applyStyle(cell, style, { bold, numeric }) {
  const st = style || {};
  cell.border = BORDER;
  const font = { size: st.size || 10 };
  if (bold || st.bold) font.bold = true;
  if (st.color) font.color = { argb: argb(st.color) };
  cell.font = font;
  if (st.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(st.bg) } };
  cell.alignment = { horizontal: st.align || (numeric ? 'right' : 'left'), vertical: 'top' };
}

// Streaming writer: rows are committed as they are added, so memory use does not grow with the result.
// Layout follows the SSRS Excel export: title row, a blank row, then each matrix/table block, two blank rows apart,
// with merged cells for column spans and for group labels that run down several rows.
async function writeXlsx(res, grid, { sheetName }) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
  const title = grid.heading && grid.heading[0];
  const offset = title ? 2 : 0;
  const headerCount = grid.multi ? 0 : grid.rows.filter((r) => r.kind === 'header').length;
  const ws = wb.addWorksheet(String(sheetName || 'Report').replace(INVALID_SHEET_CHARS, ' ').slice(0, 31) || 'Report', {
    views: headerCount ? [{ state: 'frozen', ySplit: offset + headerCount }] : [],
  });
  ws.columns = grid.columns.map((c) => ({ width: Math.min(60, Math.max(8, Math.round((c.width || 1) * 13))) }));

  let rowNo = 0;
  if (title) {
    const row = ws.addRow([title]);
    rowNo++;
    const cell = row.getCell(1);
    cell.font = { size: (grid.headingStyle && grid.headingStyle.size) || 18, bold: true, color: { argb: argb((grid.headingStyle && grid.headingStyle.color) || '365838') } };
    if (grid.columns.length > 1) merge(ws, rowNo, 1, rowNo, grid.columns.length);
    row.commit();
    ws.addRow([]).commit();
    rowNo++;
  }

  const carry = {}; // column -> { left, style } for a label that is merged down over later rows
  for (const r of grid.rows) {
    if (r.kind === 'spacer') {
      ws.addRow([]).commit(); ws.addRow([]).commit();
      rowNo += 2;
      continue;
    }
    const values = [];
    const fmts = [];
    const styles = []; // per output column: [style, numeric]
    const spans = [];
    const emptyRow = !r.cells.length;
    let col = 0;
    for (const c of r.cells) {
      col++;
      let v = c.value;
      if (v === undefined) v = null;
      if (typeof v === 'string' && /^[=+@]/.test(v)) v = "'" + v; // never let text become a formula
      values.push(v);
      let nf = null;
      if (v instanceof Date) nf = excelNumFmt(c.format, true) || (v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds() ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd');
      else if (typeof v === 'number') nf = excelNumFmt(c.format, false);
      fmts.push(nf);
      let st = c.style;
      if (c.vspan > 1) carry[col] = { left: c.vspan - 1, style: c.style };
      else if (v === null && carry[col] && carry[col].left > 0) { carry[col].left--; st = carry[col].style; }
      styles.push([st, typeof v === 'number']);
      const span = c.span || 1;
      if (span > 1) spans.push([col, col + span - 1]);
      for (let i = 1; i < span; i++) { values.push(null); fmts.push(null); styles.push([st, false]); }
      col += span - 1;
    }
    const row = ws.addRow(values);
    rowNo++;
    if (!emptyRow) {
      const bold = r.kind === 'header' || r.kind === 'footer' || r.kind === 'groupHeader' || r.kind === 'groupFooter';
      styles.forEach(([st, numeric], i) => {
        const cell = row.getCell(i + 1);
        applyStyle(cell, st, { bold, numeric });
        if (fmts[i]) cell.numFmt = fmts[i];
      });
      for (const [a, b] of spans) merge(ws, rowNo, a, rowNo, b);
      r.cells.reduce((c0, c) => {
        if (c.vspan > 1) merge(ws, rowNo, c0, rowNo + c.vspan - 1, c0 + (c.span || 1) - 1);
        return c0 + (c.span || 1);
      }, 1);
    }
    row.commit();
  }
  await ws.commit();
  await wb.commit();
}

module.exports = { writeXlsx, excelNumFmt };
