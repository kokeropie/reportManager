'use strict';
// Display formatting for RDL Format codes and the Format() function.
// All Dates in this app are "naive" wall-clock values stored as UTC, so only UTC getters are used.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n, w = 2) => String(n).padStart(w, '0');

const STANDARD_DATE = {
  d: 'MM/dd/yyyy', D: 'dddd, MMMM dd, yyyy', t: 'hh:mm tt', T: 'hh:mm:ss tt', g: 'MM/dd/yyyy hh:mm tt',
  G: 'MM/dd/yyyy hh:mm:ss tt', s: 'yyyy-MM-ddTHH:mm:ss', f: 'dddd, MMMM dd, yyyy hh:mm tt', F: 'dddd, MMMM dd, yyyy hh:mm:ss tt',
  M: 'MMMM dd', m: 'MMMM dd', Y: 'yyyy MMMM', y: 'yyyy MMMM',
};

function formatDate(d, fmt) {
  if (STANDARD_DATE[fmt]) fmt = STANDARD_DATE[fmt];
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  let out = '';
  for (let i = 0; i < fmt.length; ) {
    const rest = fmt.slice(i);
    let m;
    if (fmt[i] === '"' || fmt[i] === "'") {
      const end = fmt.indexOf(fmt[i], i + 1);
      out += fmt.slice(i + 1, end < 0 ? fmt.length : end);
      i = end < 0 ? fmt.length : end + 1;
    } else if (fmt[i] === '\\') {
      out += fmt[i + 1] || '';
      i += 2;
    } else if ((m = /^(yyyy|yy)/.exec(rest))) {
      out += m[1] === 'yyyy' ? pad(d.getUTCFullYear(), 4) : pad(d.getUTCFullYear() % 100);
      i += m[1].length;
    } else if ((m = /^M{1,4}/.exec(rest))) {
      const n = m[0].length;
      out += n === 1 ? d.getUTCMonth() + 1 : n === 2 ? pad(d.getUTCMonth() + 1) : n === 3 ? MONTHS[d.getUTCMonth()].slice(0, 3) : MONTHS[d.getUTCMonth()];
      i += n;
    } else if ((m = /^d{1,4}/.exec(rest))) {
      const n = m[0].length;
      out += n === 1 ? d.getUTCDate() : n === 2 ? pad(d.getUTCDate()) : n === 3 ? DAYS[d.getUTCDay()].slice(0, 3) : DAYS[d.getUTCDay()];
      i += n;
    } else if ((m = /^H{1,2}/.exec(rest))) {
      out += m[0].length === 1 ? h24 : pad(h24);
      i += m[0].length;
    } else if ((m = /^h{1,2}/.exec(rest))) {
      out += m[0].length === 1 ? h12 : pad(h12);
      i += m[0].length;
    } else if ((m = /^m{1,2}/.exec(rest))) {
      out += m[0].length === 1 ? d.getUTCMinutes() : pad(d.getUTCMinutes());
      i += m[0].length;
    } else if ((m = /^s{1,2}/.exec(rest))) {
      out += m[0].length === 1 ? d.getUTCSeconds() : pad(d.getUTCSeconds());
      i += m[0].length;
    } else if (/^tt/.test(rest)) {
      out += h24 < 12 ? 'AM' : 'PM';
      i += 2;
    } else {
      out += fmt[i];
      i += 1;
    }
  }
  return out;
}

function groupThousands(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function toFixedRound(n, decimals) {
  // Round half away from zero, like .NET, avoiding binary float surprises.
  const f = Math.pow(10, decimals);
  const r = Math.round(Math.abs(n) * f + 1e-9) / f;
  return (n < 0 && r !== 0 ? '-' : '') + r.toFixed(decimals);
}

function formatNumber(n, fmt) {
  let m;
  if ((m = /^([NnFfPpCc])(\d*)$/.exec(fmt))) {
    const type = m[1].toUpperCase();
    const dec = m[2] === '' ? 2 : parseInt(m[2], 10);
    if (type === 'P') return toFixedRound(n * 100, dec) + '%';
    const s = toFixedRound(n, dec);
    if (type === 'F') return s;
    const neg = s[0] === '-';
    const [i, f] = s.replace('-', '').split('.');
    return (neg ? '-' : '') + groupThousands(i) + (f ? '.' + f : '');
  }
  // Custom pattern: 0 # , . %  (first section only)
  const pattern = fmt.split(';')[0];
  const percent = pattern.includes('%');
  const value = percent ? n * 100 : n;
  const dot = pattern.indexOf('.');
  const intPart = dot < 0 ? pattern : pattern.slice(0, dot);
  const fracPart = dot < 0 ? '' : pattern.slice(dot + 1);
  const minDec = (fracPart.match(/0/g) || []).length;
  const maxDec = (fracPart.match(/[0#]/g) || []).length;
  let s = toFixedRound(value, maxDec);
  const neg = s[0] === '-';
  let [i, f = ''] = s.replace('-', '').split('.');
  while (f.length > minDec && f.endsWith('0')) f = f.slice(0, -1);
  const minInt = (intPart.match(/0/g) || []).length;
  i = i.replace(/^0+/, '').padStart(minInt, '0');
  if (intPart.includes(',')) i = groupThousands(i);
  const prefix = pattern.match(/^[^0#,.]*/)[0].replace(/[%]/g, '');
  const suffix = percent ? '%' : (pattern.match(/[^0#,.]*$/) || [''])[0];
  return (neg ? '-' : '') + prefix + i + (f ? '.' + f : '') + suffix;
}

function formatValue(v, fmt) {
  if (v === null || v === undefined) return '';
  if (!fmt) return defaultDisplay(v);
  if (v instanceof Date) return formatDate(v, fmt);
  if (typeof v === 'number') return formatNumber(v, fmt);
  return String(v);
}

function defaultDisplay(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const midnight = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0;
    return formatDate(v, midnight ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(10)));
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (Buffer.isBuffer(v)) return '(binary)';
  return String(v);
}

module.exports = { formatValue, defaultDisplay, formatDate, MONTHS, DAYS };
