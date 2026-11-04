'use strict';
const { encrypt, decrypt } = require('../crypto');
const { nextRun, describe } = require('../subscriptions/schedule');
const { validateConfig } = require('./validate');
const { sshTarget, localTarget, q } = require('./remote');
const { optionFile } = require('./sync');

// Settings for the nightly copy-and-restore. One row. SSH and MySQL passwords are stored AES-256-GCM encrypted
// (same key and format as connection passwords) and are never sent to the browser.

const dec = (v, key) => (v ? decrypt(v, key) : '');
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch (e) { return fallback; } };

function fromRow(r, key, withSecrets) {
  const cfg = {
    enabled: !!r.enabled,
    source: { host: r.src_host, port: r.src_port, username: r.src_user, dir: r.src_dir, hostKey: r.src_hostkey || '' },
    dest: { host: r.dst_host, port: r.dst_port, username: r.dst_user, dir: r.dst_dir, hostKey: r.dst_hostkey || '' },
    mysql: { host: r.my_host, port: r.my_port, username: r.my_user },
    items: parseJson(r.items, []),
    syncSchedule: parseJson(r.sync_schedule, null),
    cleanupSchedule: parseJson(r.cleanup_schedule, null),
    nextSyncAt: r.next_sync_at, nextCleanupAt: r.next_cleanup_at,
  };
  if (withSecrets) {
    cfg.source.password = dec(r.src_password_enc, key);
    cfg.source.privateKey = dec(r.src_key_enc, key);
    cfg.source.passphrase = dec(r.src_passphrase_enc, key);
    cfg.dest.password = dec(r.dst_password_enc, key);
    cfg.dest.privateKey = dec(r.dst_key_enc, key);
    cfg.dest.passphrase = dec(r.dst_passphrase_enc, key);
    cfg.mysql.password = dec(r.my_password_enc, key);
  } else {
    cfg.source.hasPassword = !!r.src_password_enc;
    cfg.source.hasKey = !!r.src_key_enc;
    cfg.dest.hasPassword = !!r.dst_password_enc;
    cfg.dest.hasKey = !!r.dst_key_enc;
    cfg.mysql.hasPassword = !!r.my_password_enc;
    cfg.syncText = cfg.syncSchedule && describe(cfg.syncSchedule);
    cfg.cleanupText = cfg.cleanupSchedule && describe(cfg.cleanupSchedule);
  }
  return cfg;
}

const defaultOpen = (part, extra) => (part.host ? sshTarget({ ...part, ...extra }) : localTarget());

function createDbSyncService({ db, encryptionKey, now = () => new Date(), open = defaultOpen, onChange }) {
  const row = () => db.one('SELECT * FROM dbsync_config WHERE id = 1');

  return {
    async get() { return fromRow(await row(), encryptionKey, false); },
    async getWithSecret() { return fromRow(await row(), encryptionKey, true); },

    async save(body, opts) {
      const v = validateConfig(body, opts);
      const old = await row();
      // A different address is a different machine: its host key has to be trusted again.
      const srcSame = v.source.host === old.src_host && v.source.port === old.src_port;
      const dstSame = v.dest.host === old.dst_host && v.dest.port === old.dst_port;
      const t = now();
      // blank = keep what is stored; clearKey removes the key and its passphrase together
      const keyCols = (p) => (p.clearKey ? { key: '', pass: '' } : { key: p.privateKey ? encrypt(p.privateKey, encryptionKey) : null, pass: p.passphrase ? encrypt(p.passphrase, encryptionKey) : null });
      const sk = keyCols(v.source), dk = keyCols(v.dest);
      await db.query(
        `UPDATE dbsync_config SET enabled=@enabled,
           src_host=@sh, src_port=@sp, src_user=@su, src_password_enc=COALESCE(@spw, src_password_enc), src_key_enc=COALESCE(@skk, src_key_enc), src_passphrase_enc=COALESCE(@skp, src_passphrase_enc), src_dir=@sd, src_hostkey=@skey,
           dst_host=@dh, dst_port=@dp, dst_user=@du, dst_password_enc=COALESCE(@dpw, dst_password_enc), dst_key_enc=COALESCE(@dkk, dst_key_enc), dst_passphrase_enc=COALESCE(@dkp, dst_passphrase_enc), dst_dir=@dd, dst_hostkey=@dkey,
           my_host=@mh, my_port=@mp, my_user=@mu, my_password_enc=COALESCE(@mpw, my_password_enc),
           items=@items, sync_schedule=@ss, cleanup_schedule=@cs, next_sync_at=@ns, next_cleanup_at=@nc, updated_at=UTC_TIMESTAMP(3)
         WHERE id = 1`,
        {
          enabled: v.enabled,
          sh: v.source.host, sp: v.source.port, su: v.source.username, spw: v.source.password ? encrypt(v.source.password, encryptionKey) : null, skk: sk.key, skp: sk.pass, sd: v.source.dir, skey: srcSame ? old.src_hostkey : null,
          dh: v.dest.host, dp: v.dest.port, du: v.dest.username, dpw: v.dest.password ? encrypt(v.dest.password, encryptionKey) : null, dkk: dk.key, dkp: dk.pass, dd: v.dest.dir, dkey: dstSame ? old.dst_hostkey : null,
          mh: v.mysql.host, mp: v.mysql.port, mu: v.mysql.username, mpw: v.mysql.password ? encrypt(v.mysql.password, encryptionKey) : null,
          items: JSON.stringify(v.items), ss: JSON.stringify(v.syncSchedule), cs: JSON.stringify(v.cleanupSchedule),
          ns: v.enabled ? nextRun(v.syncSchedule, t) : null, nc: v.enabled ? nextRun(v.cleanupSchedule, t) : null,
        }
      );
      if (onChange) onChange();
      return this.get();
    },

    // Opens one machine and reports plainly what works. Trusts (pins) its host key the first time.
    // which: 'source' | 'dest' | 'mysql'
    async test(which) {
      const cfg = await this.getWithSecret();
      const part = which === 'source' ? cfg.source : cfg.dest;
      if (which !== 'source' && cfg.dest.host === '' && process.platform === 'win32') return { ok: false, message: 'Enter the Ubuntu server address first.' };
      if (which === 'source' && !part.host) return { ok: false, message: 'Enter the backup server address first.' };
      const t = open(part, { pinHostKey: true });
      try {
        await t.open();
        if (t.kind === 'ssh') {
          const col = which === 'source' ? 'src_hostkey' : 'dst_hostkey';
          await db.query(`UPDATE dbsync_config SET ${col} = @k WHERE id = 1`, { k: t.fingerprint });
        }
        if (which === 'source') {
          const files = await t.list(part.dir);
          const names = cfg.items.map((i) => i.prefix).join(', ');
          return { ok: true, message: `Connected to ${t.label}. ${part.dir} has ${files.length} file(s). Looking for: ${names}.` };
        }
        if (which === 'dest') {
          const r = await t.exec(`for c in gzip mysql; do command -v $c >/dev/null 2>&1 || echo "missing: $c"; done; test -d ${q(part.dir)} && echo "folder exists" || echo "folder will be created on the first run"`);
          const missing = /missing: (\w+)/.exec(r.text);
          return { ok: !missing, message: `Connected to ${t.label}. ${r.text.replace(/\n/g, '. ')}${missing ? ' Install it on that server (Ubuntu: sudo apt install mysql-client).' : ''}` };
        }
        // mysql: log in from the target machine and check both databases exist
        const cnf = `${part.dir.replace(/\/$/, '')}/.dbsync-test-${Date.now()}.cnf`;
        await t.mkdirp(part.dir);
        await t.writeSecret(cnf, optionFile(cfg.mysql));
        try {
          const r = await t.exec(`mysql --defaults-extra-file=${q(cnf)} -N -e "SHOW DATABASES"`);
          if (r.code === 127) return { ok: false, message: `The mysql client is not installed on ${t.label}.` };
          if (r.code !== 0) return { ok: false, message: `MySQL refused the login: ${r.text}` };
          const have = new Set(r.text.split('\n').map((s) => s.trim()));
          const absent = cfg.items.filter((i) => !have.has(i.database)).map((i) => i.database);
          return absent.length
            ? { ok: false, message: `Logged in, but these databases do not exist yet: ${absent.join(', ')}. Create them first.` }
            : { ok: true, message: `Logged in to MySQL at ${cfg.mysql.host}. Databases found: ${cfg.items.map((i) => i.database).join(', ')}.` };
        } finally { await t.remove(cnf).catch(() => {}); }
      } catch (e) {
        return { ok: false, message: e.message };
      } finally { t.close(); }
    },

    async runs(limit = 30) {
      const rows = await db.query(`SELECT * FROM dbsync_runs ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, limit | 0))}`);
      return rows.map((r) => ({ id: r.id, kind: r.kind, by: r.trigger_by, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, summary: r.summary, log: r.log }));
    },
  };
}

module.exports = { createDbSyncService, fromRow };
