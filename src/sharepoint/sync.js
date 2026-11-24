'use strict';
// Pushes everything under OUTPUT_DIR/<user id>/... to SharePoint: Documents/<dest>/<user folder>/<same sub-folders>/<file>.
// The user folder on SharePoint is the username as it was on the first upload and is then fixed (stored in
// sharepoint_user_folders), so renaming a user later never moves or splits their files. SharePoint is never deleted from.
// Each file is recorded in sharepoint_uploads (size + mtime), so only new or changed files are sent again.
const fs = require('fs');
const path = require('path');
const { cleanSegment } = require('./graph');

function createSharePointSync({ db, graph, outputDir, dest = 'Report Output', intervalMinutes = 5, log = console }) {
  const destSegments = String(dest).split('/').map((s) => s.trim()).filter(Boolean).map(cleanSegment);
  let running = false;
  let again = false;
  let timer = null;
  let stopped = true;

  // The fixed SharePoint folder name for a user. First call picks it from the current username.
  async function userFolder(userId) {
    const row = await db.one('SELECT folder_name FROM sharepoint_user_folders WHERE user_id = @id', { id: userId });
    if (row) return row.folder_name;
    const u = await db.one('SELECT username FROM users WHERE id = @id', { id: userId });
    const base = cleanSegment(u ? u.username : `user-${userId}`);
    for (const name of [base, `${base} (${userId})`]) {
      const got = await db.query('INSERT IGNORE INTO sharepoint_user_folders (user_id, folder_name) VALUES (@id, @name)', { id: userId, name });
      if (got.affectedRows) return name;
      const mine = await db.one('SELECT folder_name FROM sharepoint_user_folders WHERE user_id = @id', { id: userId });
      if (mine) return mine.folder_name; // another process won the race for this user
      // otherwise the name is taken by someone else: try the id-suffixed one
    }
    throw new Error(`Could not pick a SharePoint folder for user ${userId}`);
  }

  function* walk(dir, rel = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.endsWith('.tmp')) continue; // half-written or hidden
      if (e.isDirectory()) yield* walk(path.join(dir, e.name), [...rel, e.name]);
      else if (e.isFile()) yield { rel: [...rel, e.name], abs: path.join(dir, e.name) };
    }
  }

  // userId 0 is the shared tcprofile folder (OUTPUT_DIR/tcprofile), uploaded to <dest>/tcprofile/ with a fixed name.
  async function syncUser(userId, stats) {
    const root = path.join(outputDir, userId === 0 ? 'tcprofile' : String(userId));
    const known = new Map();
    for (const r of await db.query('SELECT rel_path, size, mtime_ms FROM sharepoint_uploads WHERE user_id = @id', { id: userId })) {
      known.set(r.rel_path, r);
    }
    let folder = null;
    for (const f of walk(root)) {
      const relPath = f.rel.join('/');
      let st;
      try { st = fs.statSync(f.abs); } catch (e) { continue; }
      const prev = known.get(relPath);
      if (prev && Number(prev.size) === st.size && Number(prev.mtime_ms) === Math.floor(st.mtimeMs)) continue;
      try {
        if (folder === null) folder = userId === 0 ? 'tcprofile' : await userFolder(userId);
        await graph.uploadFile([...destSegments, cleanSegment(folder), ...f.rel.map(cleanSegment)], f.abs);
        await db.query(
          `INSERT INTO sharepoint_uploads (user_id, rel_path, size, mtime_ms, uploaded_at) VALUES (@id, @rel, @size, @mtime, UTC_TIMESTAMP(3))
           ON DUPLICATE KEY UPDATE size = VALUES(size), mtime_ms = VALUES(mtime_ms), uploaded_at = VALUES(uploaded_at)`,
          { id: userId, rel: relPath, size: st.size, mtime: Math.floor(st.mtimeMs) });
        stats.uploaded++;
      } catch (e) {
        stats.failed++;
        log.error(`SharePoint upload of ${userId}/${relPath} failed: ${e.message}`);
        if (e.fatal) throw e; // sign-in or permission problem: every other file would fail the same way
      }
    }
  }

  // One pass over every user folder. Safe to call at any time; overlapping calls are merged into one more pass.
  async function sweep() {
    if (running) { again = true; return null; }
    running = true;
    const stats = { uploaded: 0, failed: 0 };
    try {
      do {
        again = false;
        let ids = [];
        try { ids = fs.readdirSync(outputDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d+$/.test(d.name)).map((d) => parseInt(d.name, 10)); } catch (e) { /* nothing saved yet */ }
        for (const id of [0, ...ids]) await syncUser(id, stats);
      } while (again);
    } catch (e) {
      log.error(`SharePoint sync stopped: ${e.message}`);
    } finally { running = false; }
    if (stats.uploaded) log.log(`SharePoint: uploaded ${stats.uploaded} file(s)${stats.failed ? `, ${stats.failed} failed (will retry)` : ''}`);
    return stats;
  }

  // A file was just saved: push soon, without making the caller wait.
  function kick() { sweep().catch((e) => log.error('SharePoint sync crashed:', e.message)); }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => { await sweep().catch(() => {}); if (!stopped) schedule(); }, Math.max(1, intervalMinutes) * 60000);
    timer.unref();
  }

  return {
    sweep, kick, userFolder,
    start() { if (!stopped) return; stopped = false; kick(); schedule(); },
    stop() { stopped = true; clearTimeout(timer); timer = null; },
  };
}

module.exports = { createSharePointSync };
