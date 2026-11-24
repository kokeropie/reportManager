'use strict';
const { nextRun, describe, normalize } = require('../subscriptions/schedule');

// The tcProfile job has one settings row: on/off and the schedule. Only daily and monthly are offered.
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function cleanSchedule(input) {
  const s = input || {};
  if (s.type !== 'daily' && s.type !== 'monthly') throw bad('Pick Daily or Monthly');
  return normalize(s.type === 'daily' ? { type: 'daily', time: s.time } : { type: 'monthly', time: s.time, days: s.days });
}

const parse = (s) => { try { return JSON.parse(s); } catch (e) { return { type: 'daily', time: '06:00' }; } };

function createTcProfileService({ db, now = () => new Date(), onChange }) {
  const view = (r) => { const schedule = parse(r.schedule); return { enabled: !!r.enabled, schedule, scheduleText: describe(schedule), nextRunAt: r.next_run_at }; };
  return {
    async get() { return view(await db.one('SELECT * FROM tcprofile_config WHERE id = 1')); },
    async save(body) {
      const b = body || {};
      const schedule = cleanSchedule(b.schedule);
      const enabled = !!b.enabled;
      await db.query('UPDATE tcprofile_config SET enabled=@e, schedule=@s, next_run_at=@n, updated_at=UTC_TIMESTAMP(3) WHERE id = 1',
        { e: enabled, s: JSON.stringify(schedule), n: enabled ? nextRun(schedule, now()) : null });
      if (onChange) onChange();
      return this.get();
    },
    async runs(limit = 30) {
      const rows = await db.query(`SELECT * FROM tcprofile_runs ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, limit | 0))}`);
      return rows.map((r) => ({ id: r.id, by: r.trigger_by, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, summary: r.summary, size: r.size_bytes === null ? null : Number(r.size_bytes) }));
    },
  };
}

module.exports = { createTcProfileService, cleanSchedule };
