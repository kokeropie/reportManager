'use strict';
// Evaluator for the Visual Basic expression subset used in RDL. It parses to an AST and walks it.
// It never uses eval/Function, so an uploaded RDL cannot run code (FR-36).
const { formatValue, MONTHS, DAYS } = require('./formats');

class ExprError extends Error {}

// ---------- tokenizer ----------
const KEYWORDS = new Set(['and', 'or', 'not', 'andalso', 'orelse', 'xor', 'mod', 'true', 'false', 'nothing', 'is', 'like']);

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new ExprError('Unterminated string');
        if (src[i] === '"') {
          if (src[i + 1] === '"') { s += '"'; i += 2; continue; }
          i++;
          break;
        }
        s += src[i++];
      }
      toks.push({ t: 'str', v: s });
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      toks.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      toks.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else if (c === '[') { // Fields!["odd name"] / [bracketed identifier]
      const end = src.indexOf(']', i);
      if (end < 0) throw new ExprError('Unterminated [');
      toks.push({ t: 'id', v: src.slice(i + 1, end) });
      i = end + 1;
    } else {
      const two = src.slice(i, i + 2);
      if (['<>', '<=', '>='].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
      if ('&+-*/\\^=<>(),!.'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
      throw new ExprError(`Unexpected character "${c}"`);
    }
  }
  return toks;
}

// ---------- parser ----------
function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  const isKw = (v) => peek() && peek().t === 'id' && peek().v.toLowerCase() === v;
  const eatOp = (v) => { if (!isOp(v)) throw new ExprError(`Expected "${v}"`); p++; };

  function parseOr() {
    let l = parseAnd();
    while (isKw('or') || isKw('orelse') || isKw('xor')) {
      const op = toks[p++].v.toLowerCase();
      l = { t: 'bin', op: op === 'xor' ? 'xor' : 'or', l, r: parseAnd() };
    }
    return l;
  }
  function parseAnd() {
    let l = parseNot();
    while (isKw('and') || isKw('andalso')) { p++; l = { t: 'bin', op: 'and', l, r: parseNot() }; }
    return l;
  }
  function parseNot() {
    if (isKw('not')) { p++; return { t: 'not', e: parseNot() }; }
    return parseCmp();
  }
  function parseCmp() {
    let l = parseConcat();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
        p++;
        l = { t: 'bin', op: t.v, l, r: parseConcat() };
      } else if (isKw('is')) {
        p++;
        const neg = isKw('not');
        if (neg) p++;
        const r = parseConcat();
        l = { t: 'is', l, r, neg };
      } else return l;
    }
  }
  function parseConcat() {
    let l = parseAdd();
    while (isOp('&')) { p++; l = { t: 'bin', op: '&', l, r: parseAdd() }; }
    return l;
  }
  function parseAdd() {
    let l = parseMod();
    while (isOp('+') || isOp('-')) { const op = toks[p++].v; l = { t: 'bin', op, l, r: parseMod() }; }
    return l;
  }
  function parseMod() {
    let l = parseIntDiv();
    while (isKw('mod')) { p++; l = { t: 'bin', op: 'mod', l, r: parseIntDiv() }; }
    return l;
  }
  function parseIntDiv() {
    let l = parseMul();
    while (isOp('\\')) { p++; l = { t: 'bin', op: '\\', l, r: parseMul() }; }
    return l;
  }
  function parseMul() {
    let l = parseUnary();
    while (isOp('*') || isOp('/')) { const op = toks[p++].v; l = { t: 'bin', op, l, r: parseUnary() }; }
    return l;
  }
  function parseUnary() {
    if (isOp('-')) { p++; return { t: 'neg', e: parseUnary() }; }
    if (isOp('+')) { p++; return parseUnary(); }
    return parsePow();
  }
  function parsePow() {
    let l = parsePrimary();
    while (isOp('^')) { // left-associative in VB: 2^3^2 = 64
      p++;
      const r = isOp('-') ? (p++, { t: 'neg', e: parsePrimary() }) : parsePrimary();
      l = { t: 'bin', op: '^', l, r };
    }
    return l;
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw new ExprError('Unexpected end of expression');
    if (t.t === 'num') { p++; return { t: 'lit', v: t.v }; }
    if (t.t === 'str') { p++; return { t: 'lit', v: t.v }; }
    if (t.t === 'op' && t.v === '(') {
      p++;
      const e = parseOr();
      eatOp(')');
      return e;
    }
    if (t.t === 'id') {
      const lower = t.v.toLowerCase();
      if (lower === 'true') { p++; return { t: 'lit', v: true }; }
      if (lower === 'false') { p++; return { t: 'lit', v: false }; }
      if (lower === 'nothing') { p++; return { t: 'lit', v: null }; }
      if (KEYWORDS.has(lower)) throw new ExprError(`Unexpected keyword ${t.v}`);
      p++;
      // collection reference: Fields!Name.Value
      if (isOp('!')) {
        p++;
        const n = peek();
        if (!n || n.t !== 'id') throw new ExprError('Expected a name after "!"');
        p++;
        let prop = 'Value';
        if (isOp('.')) { p++; const pr = peek(); if (!pr || pr.t !== 'id') throw new ExprError('Expected property'); p++; prop = pr.v; }
        return { t: 'ref', coll: t.v, name: n.v, prop };
      }
      // dotted name: DateInterval.Day, Math.Round, ...
      const parts = [t.v];
      while (isOp('.') && toks[p + 1] && toks[p + 1].t === 'id') { p++; parts.push(toks[p++].v); }
      if (isOp('(')) {
        p++;
        const args = [];
        if (!isOp(')')) {
          for (;;) {
            args.push(parseOr());
            if (isOp(',')) { p++; continue; }
            break;
          }
        }
        eatOp(')');
        return { t: 'call', name: parts.join('.'), args };
      }
      return parts.length === 1 ? { t: 'call', name: parts[0], args: [], bare: true } : { t: 'name', parts };
    }
    throw new ExprError(`Unexpected "${t.v}"`);
  }

  const ast = parseOr();
  if (p < toks.length) throw new ExprError(`Unexpected "${toks[p].v}"`);
  return ast;
}

// ---------- value helpers ----------
const isNull = (v) => v === null || v === undefined;
const toStr = (v) => {
  if (isNull(v)) return '';
  if (v instanceof Date) return formatValue(v, null);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
};
function toNum(v) {
  if (isNull(v)) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? -1 : 0;
  if (v instanceof Date) return v.getTime();
  const n = Number(String(v).trim());
  if (Number.isNaN(n)) throw new ExprError(`Cannot convert "${v}" to a number`);
  return n;
}
function toDate(v) {
  if (v instanceof Date) return v;
  if (isNull(v)) return null;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  const d = new Date(s + ' UTC');
  if (Number.isNaN(d.getTime())) throw new ExprError(`Cannot convert "${v}" to a date`);
  return d;
}
const truthy = (v) => (typeof v === 'boolean' ? v : !isNull(v) && toNum(v) !== 0);

const collator = new Intl.Collator('en');
function compare(a, b) {
  if (isNull(a) && isNull(b)) return 0;
  if (isNull(a)) return -1;
  if (isNull(b)) return 1;
  if (a instanceof Date || b instanceof Date) return toDate(a).getTime() - toDate(b).getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a), nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  }
  const sa = toStr(a), sb = toStr(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1; // VB Option Compare Binary
}

function looseEquals(a, b) {
  if (isNull(a) && isNull(b)) return true;
  if (isNull(a)) return b === '';
  if (isNull(b)) return a === '';
  return compare(a, b) === 0;
}

// ---------- date helpers (UTC getters only: dates are naive wall-clock) ----------
function dateAdd(unit, n, d) {
  d = toDate(d);
  if (!d) return null;
  n = Math.trunc(toNum(n));
  const r = new Date(d.getTime());
  switch (String(unit).toLowerCase()) {
    case 'yyyy': r.setUTCFullYear(r.getUTCFullYear() + n); break;
    case 'q': r.setUTCMonth(r.getUTCMonth() + 3 * n); break;
    case 'm': r.setUTCMonth(r.getUTCMonth() + n); break;
    case 'y': case 'd': r.setUTCDate(r.getUTCDate() + n); break;
    case 'w': case 'ww': r.setUTCDate(r.getUTCDate() + (String(unit).toLowerCase() === 'ww' ? 7 * n : n)); break;
    case 'h': r.setUTCHours(r.getUTCHours() + n); break;
    case 'n': r.setUTCMinutes(r.getUTCMinutes() + n); break;
    case 's': r.setUTCSeconds(r.getUTCSeconds() + n); break;
    default: throw new ExprError(`Unknown date interval "${unit}"`);
  }
  return r;
}
function dateDiff(unit, a, b) {
  a = toDate(a); b = toDate(b);
  if (!a || !b) return null;
  const ms = b.getTime() - a.getTime();
  switch (String(unit).toLowerCase()) {
    case 'yyyy': return b.getUTCFullYear() - a.getUTCFullYear();
    case 'q': return Math.trunc(((b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth()) / 3);
    case 'm': return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
    case 'y': case 'd': {
      const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
      const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
      return Math.round((db - da) / 86400000); // VB counts day boundaries crossed
    }
    case 'ww': case 'w': return Math.trunc(ms / (7 * 86400000));
    case 'h': return Math.trunc(ms / 3600000);
    case 'n': return Math.trunc(ms / 60000);
    case 's': return Math.trunc(ms / 1000);
    default: throw new ExprError(`Unknown date interval "${unit}"`);
  }
}

const INTERVALS = { year: 'yyyy', quarter: 'q', month: 'm', dayofyear: 'y', day: 'd', weekday: 'w', weekofyear: 'ww', hour: 'h', minute: 'n', second: 's' };
const wallNow = () => { const n = new Date(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds())); };
const wallToday = () => { const n = new Date(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())); };

// ---------- functions ----------
const needDate = (v) => { const d = toDate(v); return d; };
const FUNCS = {
  // logic
  iif: (a) => (truthy(a[0]) ? a[1] : a[2]),
  isnothing: (a) => isNull(a[0]),
  isnumeric: (a) => !isNull(a[0]) && a[0] !== '' && !Number.isNaN(Number(a[0])),
  isdate: (a) => { try { return !!toDate(a[0]); } catch (e) { return false; } },
  choose: (a) => { const i = Math.trunc(toNum(a[0])); return i >= 1 && i < a.length ? a[i] : null; },
  // text
  len: (a) => (isNull(a[0]) ? 0 : toStr(a[0]).length),
  left: (a) => (isNull(a[0]) ? null : toStr(a[0]).slice(0, Math.max(0, Math.trunc(toNum(a[1]))))),
  right: (a) => { if (isNull(a[0])) return null; const s = toStr(a[0]); const n = Math.max(0, Math.trunc(toNum(a[1]))); return n === 0 ? '' : s.slice(-n); },
  mid: (a) => {
    if (isNull(a[0])) return null;
    const s = toStr(a[0]); const start = Math.max(1, Math.trunc(toNum(a[1])));
    return a.length > 2 && !isNull(a[2]) ? s.substr(start - 1, Math.max(0, Math.trunc(toNum(a[2])))) : s.slice(start - 1);
  },
  ltrim: (a) => (isNull(a[0]) ? null : toStr(a[0]).replace(/^ +/, '')),
  rtrim: (a) => (isNull(a[0]) ? null : toStr(a[0]).replace(/ +$/, '')),
  trim: (a) => (isNull(a[0]) ? null : toStr(a[0]).replace(/^ +| +$/g, '')),
  ucase: (a) => (isNull(a[0]) ? null : toStr(a[0]).toUpperCase()),
  lcase: (a) => (isNull(a[0]) ? null : toStr(a[0]).toLowerCase()),
  space: (a) => ' '.repeat(Math.max(0, Math.trunc(toNum(a[0])))),
  replace: (a) => (isNull(a[0]) ? null : toStr(a[0]).split(toStr(a[1])).join(toStr(a[2]))),
  instr: (a) => {
    const hasStart = typeof a[0] === 'number' && a.length > 2;
    const start = hasStart ? Math.max(1, Math.trunc(a[0])) : 1;
    const s = toStr(a[hasStart ? 1 : 0]); const f = toStr(a[hasStart ? 2 : 1]);
    return s.indexOf(f, start - 1) + 1;
  },
  cstr: (a) => (isNull(a[0]) ? '' : toStr(a[0])),
  format: (a) => (isNull(a[0]) ? '' : formatValue(a[0] instanceof Date || typeof a[0] === 'number' ? a[0] : (Number.isNaN(Number(a[0])) ? a[0] : Number(a[0])), a.length > 1 ? toStr(a[1]) : null)),
  formatnumber: (a) => formatValue(toNum(a[0]), 'N' + (a.length > 1 ? Math.trunc(toNum(a[1])) : 2)),
  // numbers
  cint: (a) => Math.round(toNum(a[0])),
  clng: (a) => Math.round(toNum(a[0])),
  cdbl: (a) => toNum(a[0]),
  cdec: (a) => toNum(a[0]),
  csng: (a) => toNum(a[0]),
  cbool: (a) => truthy(a[0]),
  int: (a) => Math.floor(toNum(a[0])),
  fix: (a) => Math.trunc(toNum(a[0])),
  abs: (a) => Math.abs(toNum(a[0])),
  round: (a) => { const d = a.length > 1 ? Math.trunc(toNum(a[1])) : 0; const f = Math.pow(10, d); return Math.round(toNum(a[0]) * f) / f; },
  // dates
  today: () => wallToday(),
  now: () => wallNow(),
  cdate: (a) => toDate(a[0]),
  datevalue: (a) => { const d = toDate(a[0]); return d && new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); },
  dateserial: (a) => new Date(Date.UTC(toNum(a[0]), toNum(a[1]) - 1, toNum(a[2]))),
  day: (a) => { const d = needDate(a[0]); return d ? d.getUTCDate() : null; },
  month: (a) => { const d = needDate(a[0]); return d ? d.getUTCMonth() + 1 : null; },
  year: (a) => { const d = needDate(a[0]); return d ? d.getUTCFullYear() : null; },
  hour: (a) => { const d = needDate(a[0]); return d ? d.getUTCHours() : null; },
  minute: (a) => { const d = needDate(a[0]); return d ? d.getUTCMinutes() : null; },
  second: (a) => { const d = needDate(a[0]); return d ? d.getUTCSeconds() : null; },
  weekday: (a) => { const d = needDate(a[0]); return d ? d.getUTCDay() + 1 : null; },
  monthname: (a) => {
    const n = Math.trunc(toNum(a[0]));
    if (n < 1 || n > 12) throw new ExprError('MonthName: month must be 1-12');
    return a.length > 1 && truthy(a[1]) ? MONTHS[n - 1].slice(0, 3) : MONTHS[n - 1];
  },
  weekdayname: (a) => {
    const n = Math.trunc(toNum(a[0]));
    if (n < 1 || n > 7) throw new ExprError('WeekdayName: day must be 1-7');
    return a.length > 2 && truthy(a[1]) ? DAYS[n - 1].slice(0, 3) : DAYS[n - 1];
  },
  dateadd: (a) => dateAdd(a[0], a[1], a[2]),
  datediff: (a) => dateDiff(a[0], a[1], a[2]),
};

// Aggregates take unevaluated args because they evaluate the first argument once per row in scope.
const AGGREGATES = new Set(['sum', 'count', 'countdistinct', 'avg', 'min', 'max', 'first', 'last', 'rownumber']);

function knownFunctions() { return new Set([...Object.keys(FUNCS), ...AGGREGATES, 'switch']); }

// ---------- compile / evaluate ----------
function walk(node, fn) {
  fn(node);
  if (node.l) walk(node.l, fn);
  if (node.r) walk(node.r, fn);
  if (node.e) walk(node.e, fn);
  if (node.args) node.args.forEach((x) => walk(x, fn));
}

// Returns { ast, functions:[names], fields:[names], error }. Never throws.
function compile(src) {
  const raw = String(src);
  const text = raw.startsWith('=') ? raw.slice(1) : null;
  if (text === null) return { literal: raw, functions: [], fields: [], params: [] };
  try {
    const ast = parse(text);
    const functions = new Set(); const fields = new Set(); const params = new Set();
    walk(ast, (n) => {
      if (n.t === 'call') functions.add(n.name);
      if (n.t === 'ref' && n.coll.toLowerCase() === 'fields') fields.add(n.name);
      if (n.t === 'ref' && n.coll.toLowerCase() === 'parameters') params.add(n.name);
    });
    return { ast, functions: [...functions], fields: [...fields], params: [...params] };
  } catch (e) {
    return { error: e.message, functions: [], fields: [], params: [], source: raw };
  }
}

function unsupportedFunctions(compiled) {
  const known = knownFunctions();
  return compiled.functions.filter((f) => !known.has(f.toLowerCase()) && !f.includes('.'));
}

function lookupRef(node, ctx) {
  const coll = node.coll.toLowerCase();
  const key = node.name.toLowerCase();
  if (coll === 'fields') {
    if (node.prop.toLowerCase() === 'ismissing') return !ctx.row || !(key in ctx.row.f);
    if (!ctx.row) return null;
    if (!(key in ctx.row.f)) throw new ExprError(`Unknown field "${node.name}"`);
    const v = ctx.row.f[key];
    return v === undefined ? null : v;
  }
  if (coll === 'parameters') {
    if (!ctx.params || !(key in ctx.params)) throw new ExprError(`Unknown parameter "${node.name}"`);
    return ctx.params[key];
  }
  if (coll === 'globals') {
    if (key === 'executiontime') return ctx.now || wallNow();
    if (key === 'reportname') return ctx.reportName || null;
    return null; // PageNumber etc. have no meaning on a web table
  }
  throw new ExprError(`Unsupported collection "${node.coll}"`);
}

function scopeRows(ctx, scopeArg) {
  if (scopeArg && ctx.scopes && ctx.scopes[String(scopeArg).toLowerCase()]) return ctx.scopes[String(scopeArg).toLowerCase()];
  return ctx.scopeRows || ctx.allRows || [];
}

function evalAggregate(name, node, ctx) {
  const lname = name.toLowerCase();
  const scopeNode = node.args[1];
  const scopeName = scopeNode ? evaluate(scopeNode, ctx) : null;
  if (lname === 'rownumber') {
    const target = node.args[0] ? evaluate(node.args[0], ctx) : null;
    const rows = scopeRows(ctx, target);
    if (!ctx.row) return 0;
    if (target && rows !== ctx.allRows) return rows.indexOf(ctx.row) + 1;
    return ctx.row.i + 1;
  }
  const rows = scopeRows(ctx, scopeName);
  const vals = rows.map((r) => evaluate(node.args[0], Object.assign({}, ctx, { row: r })));
  const nn = vals.filter((v) => !isNull(v));
  switch (lname) {
    case 'sum': return nn.reduce((s, v) => s + toNum(v), 0);
    case 'count': return nn.length;
    case 'countdistinct': return new Set(nn.map((v) => (v instanceof Date ? v.getTime() : v))).size;
    case 'avg': return nn.length ? nn.reduce((s, v) => s + toNum(v), 0) / nn.length : null;
    case 'min': return nn.length ? nn.reduce((m, v) => (compare(v, m) < 0 ? v : m)) : null;
    case 'max': return nn.length ? nn.reduce((m, v) => (compare(v, m) > 0 ? v : m)) : null;
    case 'first': return vals.length ? vals[0] : null;
    case 'last': return vals.length ? vals[vals.length - 1] : null;
    default: throw new ExprError(`Unsupported aggregate ${name}`);
  }
}

function arith(op, a, b) {
  const x = toNum(a), y = toNum(b);
  switch (op) {
    case '-': return x - y;
    case '*': return x * y;
    case '/': if (y === 0) throw new ExprError('Division by zero'); return x / y;
    case '\\': if (y === 0) throw new ExprError('Division by zero'); return Math.trunc(Math.trunc(x) / Math.trunc(y));
    case 'mod': if (y === 0) throw new ExprError('Division by zero'); return x % y;
    case '^': return Math.pow(x, y);
    default: throw new ExprError(`Unsupported operator ${op}`);
  }
}

function evaluate(node, ctx) {
  switch (node.t) {
    case 'lit': return node.v;
    case 'ref': return lookupRef(node, ctx);
    case 'neg': return -toNum(evaluate(node.e, ctx));
    case 'not': return !truthy(evaluate(node.e, ctx));
    case 'is': {
      const l = evaluate(node.l, ctx), r = evaluate(node.r, ctx);
      const same = isNull(l) && isNull(r);
      return node.neg ? !same : same;
    }
    case 'name': {
      const [a, b] = node.parts;
      if (a.toLowerCase() === 'dateinterval' && INTERVALS[b.toLowerCase()]) return INTERVALS[b.toLowerCase()];
      throw new ExprError(`Unsupported name ${node.parts.join('.')}`);
    }
    case 'bin': {
      if (node.op === 'and') return truthy(evaluate(node.l, ctx)) && truthy(evaluate(node.r, ctx));
      if (node.op === 'or') return truthy(evaluate(node.l, ctx)) || truthy(evaluate(node.r, ctx));
      const l = evaluate(node.l, ctx);
      const r = evaluate(node.r, ctx);
      switch (node.op) {
        case 'xor': return truthy(l) !== truthy(r);
        case '&': return toStr(l) + toStr(r);
        case '+':
          if (typeof l === 'string' && typeof r === 'string') return l + r;
          if (l instanceof Date && typeof r === 'number') return new Date(l.getTime() + r * 86400000);
          return toNum(l) + toNum(r);
        case '=': return looseEquals(l, r);
        case '<>': return !looseEquals(l, r);
        case '<': return compare(l, r) < 0;
        case '>': return compare(l, r) > 0;
        case '<=': return compare(l, r) <= 0;
        case '>=': return compare(l, r) >= 0;
        default: return arith(node.op, l, r);
      }
    }
    case 'call': {
      const lname = node.name.toLowerCase();
      if (AGGREGATES.has(lname)) return evalAggregate(node.name, node, ctx);
      if (lname === 'iif') { // lazy, so the untaken branch cannot raise errors
        return truthy(evaluate(node.args[0], ctx)) ? evaluate(node.args[1], ctx) : evaluate(node.args[2], ctx);
      }
      if (lname === 'switch') {
        for (let i = 0; i + 1 < node.args.length; i += 2) if (truthy(evaluate(node.args[i], ctx))) return evaluate(node.args[i + 1], ctx);
        return null;
      }
      const fn = FUNCS[lname];
      if (!fn) throw new ExprError(`Unsupported function "${node.name}"`);
      return fn(node.args.map((a) => evaluate(a, ctx)));
    }
    default: throw new ExprError('Bad expression');
  }
}

// Evaluate a compiled expression. Throws ExprError on failure.
function run(compiled, ctx) {
  if (compiled.literal !== undefined) return compiled.literal;
  if (compiled.error) throw new ExprError(compiled.error);
  return evaluate(compiled.ast, ctx);
}

module.exports = { compile, run, parse, ExprError, unsupportedFunctions, knownFunctions, compare, toDate, toNum, toStr, wallToday, wallNow };
