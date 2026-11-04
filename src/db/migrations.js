'use strict';

// MariaDB 10.5+ (utf8mb4). Each migration is a list of statements, run one by one (MariaDB cannot roll back DDL, so
// they use IF NOT EXISTS and a half-finished migration is simply run again). Append only, never edit a shipped one.
// Timestamps are DATETIME(3) holding UTC.
const NOW = '(UTC_TIMESTAMP(3))';
const MIGRATIONS = [
  [
    `CREATE TABLE IF NOT EXISTS users (
      id                   INT AUTO_INCREMENT PRIMARY KEY,
      username             VARCHAR(100) NOT NULL UNIQUE,
      password_hash        VARCHAR(100) NOT NULL,
      role                 VARCHAR(10)  NOT NULL,
      disabled             TINYINT(1) NOT NULL DEFAULT 0,
      must_change_password TINYINT(1) NOT NULL DEFAULT 0,
      created_at           DATETIME(3) NOT NULL DEFAULT ${NOW},
      CONSTRAINT ck_users_role CHECK (role IN ('admin','viewer'))
    )`,
    `CREATE TABLE IF NOT EXISTS folders (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      name       VARCHAR(100) NOT NULL UNIQUE,
      is_system  TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT ${NOW}
    )`,
    `CREATE TABLE IF NOT EXISTS connections (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      name               VARCHAR(100) NOT NULL UNIQUE,
      type               VARCHAR(10)  NOT NULL,
      host               VARCHAR(255) NOT NULL,
      port               INT NOT NULL,
      database_name      VARCHAR(128) NOT NULL,
      username           VARCHAR(128) NOT NULL,
      password_enc       LONGTEXT NOT NULL,
      trust_server_cert  TINYINT(1) NOT NULL DEFAULT 0,
      created_at         DATETIME(3) NOT NULL DEFAULT ${NOW},
      updated_at         DATETIME(3) NOT NULL DEFAULT ${NOW},
      CONSTRAINT ck_connections_type CHECK (type IN ('mssql','mysql'))
    )`,
    `CREATE TABLE IF NOT EXISTS reports (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      folder_id       INT NOT NULL,
      name            VARCHAR(200) NOT NULL,
      file_path       VARCHAR(500) NOT NULL,
      datasource_name VARCHAR(200) NULL,
      connection_id   INT NULL,
      title           VARCHAR(300) NULL,
      warnings        LONGTEXT NULL,
      uploaded_by     INT NULL,
      created_at      DATETIME(3) NOT NULL DEFAULT ${NOW},
      updated_at      DATETIME(3) NOT NULL DEFAULT ${NOW},
      UNIQUE KEY ux_reports_folder_name (folder_id, name),
      CONSTRAINT fk_reports_folder FOREIGN KEY (folder_id) REFERENCES folders(id),
      CONSTRAINT fk_reports_connection FOREIGN KEY (connection_id) REFERENCES connections(id)
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      sid        VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      user_id    INT NULL,
      sess       LONGTEXT NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      KEY ix_sessions_expires (expires_at),
      KEY ix_sessions_user (user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      name  VARCHAR(100) NOT NULL PRIMARY KEY,
      value VARCHAR(500) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      logged_at   DATETIME(3) NOT NULL DEFAULT ${NOW},
      user_id     INT NULL,
      username    VARCHAR(100) NULL,
      action      VARCHAR(30) NOT NULL,
      report_id   INT NULL,
      report_name VARCHAR(200) NULL,
      params      VARCHAR(4000) NULL,
      row_count   INT NULL,
      status      VARCHAR(10) NOT NULL DEFAULT 'ok',
      error       VARCHAR(500) NULL,
      ip          VARCHAR(64) NULL,
      user_agent  VARCHAR(300) NULL,
      KEY ix_audit_at (logged_at),
      KEY ix_audit_user (username)
    )`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     INT NOT NULL,
      report_id   INT NOT NULL,
      name        VARCHAR(200) NOT NULL,
      params      VARCHAR(4000) NOT NULL DEFAULT '{}',
      format      VARCHAR(4) NOT NULL,
      schedule    VARCHAR(500) NOT NULL,
      folder      VARCHAR(200) NOT NULL DEFAULT '',
      enabled     TINYINT(1) NOT NULL DEFAULT 1,
      next_run_at DATETIME(3) NULL,
      last_run_at DATETIME(3) NULL,
      last_status VARCHAR(10) NULL,
      last_error  VARCHAR(500) NULL,
      failures    INT NOT NULL DEFAULT 0,
      created_at  DATETIME(3) NOT NULL DEFAULT ${NOW},
      KEY ix_subs_due (enabled, next_run_at),
      KEY ix_subs_user (user_id),
      CONSTRAINT fk_subs_user FOREIGN KEY (user_id) REFERENCES users(id),
      CONSTRAINT fk_subs_report FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
      CONSTRAINT ck_subs_format CHECK (format IN ('csv','xlsx'))
    )`,
    `CREATE TABLE IF NOT EXISTS subscription_runs (
      id              BIGINT AUTO_INCREMENT PRIMARY KEY,
      subscription_id INT NOT NULL,
      user_id         INT NOT NULL,
      started_at      DATETIME(3) NOT NULL,
      finished_at     DATETIME(3) NULL,
      status          VARCHAR(10) NOT NULL,
      row_count       INT NULL,
      file_name       VARCHAR(400) NULL,
      file_size       BIGINT NULL,
      error           VARCHAR(500) NULL,
      KEY ix_subruns_sub (subscription_id, id),
      KEY ix_subruns_user (user_id, id),
      CONSTRAINT fk_subruns_sub FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
    )`,
    // Folder access: no rows for a folder = every viewer can open it; rows = only those viewers (admins always can).
    `CREATE TABLE IF NOT EXISTS folder_access (
      folder_id INT NOT NULL,
      user_id   INT NOT NULL,
      PRIMARY KEY (folder_id, user_id),
      KEY ix_folder_access_user (user_id),
      CONSTRAINT fk_fa_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
      CONSTRAINT fk_fa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    // Nightly copy of the newest MySQL/MariaDB dumps from a backup server, restore, and clean-up (src/dbsync). One settings row.
    `CREATE TABLE IF NOT EXISTS dbsync_config (
      id               INT NOT NULL PRIMARY KEY,
      enabled          TINYINT(1) NOT NULL DEFAULT 0,
      src_host         VARCHAR(255) NOT NULL DEFAULT '',
      src_port         INT NOT NULL DEFAULT 22,
      src_user         VARCHAR(100) NOT NULL DEFAULT '',
      src_password_enc VARCHAR(2000) NULL,
      src_dir          VARCHAR(300) NOT NULL DEFAULT '/home/backup_db',
      src_hostkey      VARCHAR(100) NULL,
      dst_host         VARCHAR(255) NOT NULL DEFAULT '',
      dst_port         INT NOT NULL DEFAULT 22,
      dst_user         VARCHAR(100) NOT NULL DEFAULT '',
      dst_password_enc VARCHAR(2000) NULL,
      dst_dir          VARCHAR(300) NOT NULL DEFAULT '/home/mysqlbackup',
      dst_hostkey      VARCHAR(100) NULL,
      my_host          VARCHAR(255) NOT NULL DEFAULT 'localhost',
      my_port          INT NOT NULL DEFAULT 3306,
      my_user          VARCHAR(100) NOT NULL DEFAULT '',
      my_password_enc  VARCHAR(2000) NULL,
      items            VARCHAR(2000) NOT NULL DEFAULT '[{"prefix":"dev_arjuna","database":"dev_arjuna"},{"prefix":"dev_kenji","database":"dev_kenji"}]',
      sync_schedule    VARCHAR(500) NOT NULL DEFAULT '{"type":"daily","time":"02:00"}',
      cleanup_schedule VARCHAR(500) NOT NULL DEFAULT '{"type":"daily","time":"18:00"}',
      next_sync_at     DATETIME(3) NULL,
      next_cleanup_at  DATETIME(3) NULL,
      updated_at       DATETIME(3) NOT NULL DEFAULT ${NOW},
      CONSTRAINT ck_dbsync_single CHECK (id = 1)
    )`,
    `INSERT IGNORE INTO dbsync_config (id) VALUES (1)`,
    `CREATE TABLE IF NOT EXISTS dbsync_runs (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      kind        VARCHAR(10) NOT NULL,
      trigger_by  VARCHAR(10) NOT NULL,
      started_at  DATETIME(3) NOT NULL,
      finished_at DATETIME(3) NULL,
      status      VARCHAR(10) NOT NULL,
      summary     VARCHAR(500) NULL,
      log         LONGTEXT NULL,
      CONSTRAINT ck_dbsync_kind CHECK (kind IN ('sync','cleanup'))
    )`,
  ],
  // DB Sync: optional SSH private key (and its passphrase) per machine, stored encrypted like the passwords.
  [
    `ALTER TABLE dbsync_config
      ADD COLUMN IF NOT EXISTS src_key_enc LONGTEXT NULL,
      ADD COLUMN IF NOT EXISTS src_passphrase_enc VARCHAR(2000) NULL,
      ADD COLUMN IF NOT EXISTS dst_key_enc LONGTEXT NULL,
      ADD COLUMN IF NOT EXISTS dst_passphrase_enc VARCHAR(2000) NULL`,
  ],
];

const DEFAULT_FOLDERS = [
  ['Accounting', 0],
  ['Finance', 0],
  ['Connection', 1],
  ['MPM', 0],
  ['ORN', 0],
  ['ePRV', 0],
];

async function migrate(db) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_version (version INT NOT NULL)');
  const row = await db.one('SELECT MAX(version) AS v FROM schema_version');
  const current = (row && row.v) || 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    for (const statement of MIGRATIONS[i]) await db.query(statement);
    await db.query('INSERT INTO schema_version (version) VALUES (@v)', { v: i + 1 });
  }
  // FR-8a: default folders on first start
  const count = await db.one('SELECT COUNT(*) AS n FROM folders');
  if (count.n === 0) {
    for (const [name, isSystem] of DEFAULT_FOLDERS) {
      await db.query('INSERT INTO folders (name, is_system) VALUES (@name, @isSystem)', { name, isSystem: !!isSystem });
    }
  }
  const s = await db.one(`SELECT value FROM settings WHERE name = 'single_session'`);
  if (!s) await db.query(`INSERT INTO settings (name, value) VALUES ('single_session', 'false')`);
}

module.exports = { migrate, MIGRATIONS, DEFAULT_FOLDERS };
