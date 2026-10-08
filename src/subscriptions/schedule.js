'use strict';
// Schedules are stored as JSON and evaluated in the server's local wall-clock time, the same clock the
// report expressions (Today(), Now()) use. Types: daily, weekly, monthly, interval.

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN_INTERVAL_MINUTES = 15;

function parseTime(t) {
  const m = TIME.exec(String(t || ''));
  if (!m) throw bad('Time must be HH:MM (24 hour)');
  return { h: +m[1], m: +m[2] };
}

// Returns a clean schedule object or throws a 400 with a plain message.
function normalize(input) {
  const s = input || {};
  switch (s.type) {
    case 'daily':
      parseTime(s.time);
      return { type: 'daily', time: s.time };
    case 'weekly': {
      parseTime(s.time);
      const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))].sort();
      if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('Pick at least one weekday');
      return { type: 'weekly', time: s.time, days };
    }
    case 'monthly': {
      parseTime(s.time);
      const day = Number(s.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) throw bad('Day of month must be 1-31');
      return { type: 'monthly', time: s.time, day };
    }
    case 'interval': {
      const minutes = Number(s.everyMinutes);
      if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > 7 * 24 * 60) {
        throw bad(`Repeat interval must be between ${MIN_INTERVAL_MINUTES} minutes and 7 days`);
      }
      return { type: 'interval', everyMinutes: minutes };
    }
    default:
      throw bad('Schedule type must be daily, weekly, monthly or interval');
  }
}

// The first run time strictly after `after` (a Date).
function nextRun(schedule, after) {
  const s = normalize(schedule);
  if (s.type === 'interval') return new Date(after.getTime() + s.everyMinutes * 60000);
  const { h, m } = parseTime(s.time);
  const at = (y, mo, d) => new Date(y, mo, d, h, m, 0, 0);
  const y = after.getFullYear();
  const mo = after.getMonth();
  const d = after.getDate();
  if (s.type === 'daily') {
    const c = at(y, mo, d);
    return c > after ? c : at(y, mo, d + 1);
  }
  if (s.type === 'weekly') {
    for (let i = 0; i <= 7; i++) {
      const c = at(y, mo, d + i);
      if (s.days.includes(c.getDay()) && c > after) return c;
    }
  }
  // monthly: a day past the end of a short month (31 in April) runs on the last day of that month
  for (let i = 0; i <= 13; i++) {
    const last = new Date(y, mo + i + 1, 0).getDate();
    const c = at(y, mo + i, Math.min(s.day, last));
    if (c > after) return c;
  }
  throw new Error('Could not compute the next run');
}

function describe(schedule) {
  const s = normalize(schedule);
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (s.type === 'daily') return `Every day at ${s.time}`;
  if (s.type === 'weekly') return `Every ${s.days.map((d) => names[d]).join(', ')} at ${s.time}`;
  if (s.type === 'monthly') return `Day ${s.day} of every month at ${s.time}`;
  return s.everyMinutes % 60 === 0 ? `Every ${s.everyMinutes / 60} hour(s)` : `Every ${s.everyMinutes} minutes`;
}

module.exports = { normalize, nextRun, describe, MIN_INTERVAL_MINUTES };
