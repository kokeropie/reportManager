'use strict';

// FR-26/26a: who ran which report, with which parameters, from which computer. Never stores passwords.
const clip = (s, n) => (s === null || s === undefined ? null : String(s).slice(0, n));

function createAuditService(db) {
  return {
    // Never throws: a logging problem must not break a user's report.
    async log(e) {
      try {
        await db.query(
          `INSERT INTO audit_log (user_id, username, action, report_id, report_name, params, row_count, status, error, ip, user_agent)
           VALUES (@userId, @username, @action, @reportId, @reportName, @params, @rowCount, @status, @error, @ip, @ua)`,
          {
            userId: e.userId || null,
            username: clip(e.username, 100),
            action: clip(e.action, 30),
            reportId: e.reportId || null,
            reportName: clip(e.reportName, 200),
            params: e.params === undefined ? null : clip(JSON.stringify(e.params), 4000),
            rowCount: e.rowCount === undefined ? null : e.rowCount,
            status: e.status || 'ok',
            error: clip(e.error, 500),
            ip: clip(e.ip, 64),
            ua: clip(e.userAgent, 300),
          }
        );
      } catch (err) {
        console.error('Audit log write failed:', err.message);
      }
    },

    async list({ page = 1, pageSize = 100, user, report, action, from, to } = {}) {
      const where = [];
      const p = {};
      if (user) { where.push('username LIKE @user'); p.user = '%' + user + '%'; }
      if (report) { where.push('report_name LIKE @report'); p.report = '%' + report + '%'; }
      if (action) { where.push('action = @action'); p.action = action; }
      if (from) { where.push('logged_at >= @from'); p.from = new Date(from); }
      if (to) { where.push('logged_at < @to'); p.to = new Date(new Date(to).getTime() + 86400000); }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = (await db.one(`SELECT COUNT(*) AS n FROM audit_log ${w}`, p)).n;
      const size = Math.min(Math.max(pageSize, 10), 500);
      const pg = Math.max(1, page);
      const rows = await db.query(
        `SELECT id, logged_at, username, action, report_id, report_name, params, row_count, status, error, ip, user_agent
         FROM audit_log ${w} ORDER BY id DESC OFFSET @off ROWS FETCH NEXT @size ROWS ONLY`,
        { ...p, off: (pg - 1) * size, size }
      );
      return {
        page: pg, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)),
        rows: rows.map((r) => ({
          id: r.id, at: r.logged_at, username: r.username, action: r.action, reportId: r.report_id, reportName: r.report_name,
          params: r.params, rowCount: r.row_count, status: r.status, error: r.error, ip: r.ip, userAgent: r.user_agent,
        })),
      };
    },
  };
}

module.exports = { createAuditService };
