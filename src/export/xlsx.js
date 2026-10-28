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

// Excel reports the whole file as corrupt for NaN/Infinity/invalid dates (written as <v>NaN</v>), for text over
// 32767 characters, and for lone surrogates. Turn those into blanks or safe text.
function safeValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) {
    const t = v.getTime();
    if (Number.isNaN(t)) return null;
    return v.getUTCFullYear() < 1900 ? v.toISOString().slice(0, 19).replace('T', ' ') : v; // Excel has no dates before 1900
  }
  if (typeof v === 'string') {
    const s = v.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
    return s.length > 32767 ? s.slice(0, 32767) : s;
  }
  return v;
}

const INVALID_SHEET_CHARS = /[\\/?*[\]:]/g;

const argb = (hex) => 'FF' + hex;

// Look taken from the RDL (font, fill, text colour, bold, size, alignment, border colour), like the SSRS Excel render:
// thin borders (DarkGray unless the RDL says otherwise), wrapped text, top-aligned. Bold comes from the RDL only;
// a cell with no RDL style falls back to bold for header/total rows.
function applyStyle(cell, style, { bold, numeric }) {
  const st = style || {};
  const side = { style: 'thin', color: { argb: argb(st.border || 'A9A9A9') } };
  cell.border = { top: side, left: side, bottom: side, right: side };
  const font = { size: st.size || 10 };
  if (st.font) font.name = st.font;
  if (style ? st.bold : bold) font.bold = true;
  if (st.color) font.color = { argb: argb(st.color) };
  cell.font = font;
  if (st.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(st.bg) } };
  cell.alignment = { horizontal: st.align || (numeric ? 'right' : 'left'), vertical: 'top', wrapText: true };
}

function titleFont(grid) {
  const hs = grid.headingStyle;
  const f = { size: (hs && hs.size) || 18, bold: hs ? !!hs.bold : true, color: { argb: argb((hs && hs.color) || '365838') } };
  if (hs && hs.font) f.name = hs.font;
  return f;
}

// Streaming writer: rows are committed as they are added, so memory use does not grow with the result.
// Layout follows the SSRS Excel export: title row, a blank row, then each matrix/table block, two blank rows apart,
// with merged cells for column spans and for group labels that run down several rows.
async function writeXlsx(res, grid, { sheetName }) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
  const title = grid.heading && grid.heading[0];
  const subtitle = title && grid.subtitle;
  const info = title ? grid.info || [] : [];
  const ws = wb.addWorksheet(String(sheetName || 'Report').replace(INVALID_SHEET_CHARS, ' ').slice(0, 31) || 'Report', {
    views: [{ showGridLines: false }], // the SSRS render has no gridlines and no frozen header
  });
  ws.columns = grid.columns.map((c) => ({ width: Math.min(60, Math.max(8, Math.round((c.width || 1) * 96 / 7 * 100) / 100)) })); // 1in = 96px = 13.71 characters

  let rowNo = 0;
  if (title) {
    const row = ws.addRow([title]);
    rowNo++;
    const cell = row.getCell(1);
    cell.font = titleFont(grid);
    if (grid.columns.length > 1) merge(ws, rowNo, 1, rowNo, grid.columns.length);
    row.commit();
    if (subtitle) {
      const sub = ws.addRow([subtitle]);
      rowNo++;
      sub.getCell(1).font = titleFont(grid);
      if (grid.columns.length > 1) merge(ws, rowNo, 1, rowNo, grid.columns.length);
      sub.commit();
    }
    for (const line of info) {
      ws.addRow(line.map((v) => safeValue(/^[=+@]/.test(v) ? "'" + v : v))).commit();
      rowNo++;
    }
    if (grid.titleGap !== 0) {
      ws.addRow([]).commit();
      rowNo++;
    }
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
      v = safeValue(v === undefined ? null : v);
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
