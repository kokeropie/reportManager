'use strict';

// Each migration is one T-SQL batch (SQL Server 2016 compatible). Append only, never edit a shipped one.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    username      NVARCHAR(100) NOT NULL UNIQUE,
    password_hash NVARCHAR(100) NOT NULL,
    role          NVARCHAR(10)  NOT NULL CHECK (role IN ('admin','viewer')),
    disabled      BIT NOT NULL DEFAULT 0,
    created_at    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE TABLE folders (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    name       NVARCHAR(100) NOT NULL UNIQUE,
    is_system  BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE TABLE connections (
    id                 INT IDENTITY(1,1) PRIMARY KEY,
    name               NVARCHAR(100) NOT NULL UNIQUE,
    type               NVARCHAR(10)  NOT NULL CHECK (type IN ('mssql','mysql')),
    host               NVARCHAR(255) NOT NULL,
    port               INT NOT NULL,
    database_name      NVARCHAR(128) NOT NULL,
    username           NVARCHAR(128) NOT NULL,
    password_enc       NVARCHAR(MAX) NOT NULL,
    trust_server_cert  BIT NOT NULL DEFAULT 0,
    created_at         DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at         DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  -- Minimal shape so FR-7 (block deleting a connection that reports use) works now. Phase 2 extends it.
  CREATE TABLE reports (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    folder_id       INT NOT NULL REFERENCES folders(id),
    name            NVARCHAR(200) NOT NULL,
    file_path       NVARCHAR(500) NOT NULL,
    datasource_name NVARCHAR(200) NULL,
    connection_id   INT NULL REFERENCES connections(id),
    created_at      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE TABLE sessions (
    sid        NVARCHAR(128) NOT NULL PRIMARY KEY,
    user_id    INT NULL,
    sess       NVARCHAR(MAX) NOT NULL,
    expires_at DATETIME2 NOT NULL
  );
  CREATE INDEX ix_sessions_expires ON sessions(expires_at);
  CREATE INDEX ix_sessions_user ON sessions(user_id);
  CREATE TABLE settings (
    name  NVARCHAR(100) NOT NULL PRIMARY KEY,
    value NVARCHAR(500) NOT NULL
  );
  `,
  // Phase 2: report metadata
  `
  ALTER TABLE reports ADD
    title         NVARCHAR(300) NULL,
    warnings      NVARCHAR(MAX) NULL,
    uploaded_by   INT NULL,
    updated_at    DATETIME2 NOT NULL CONSTRAINT df_reports_updated DEFAULT SYSUTCDATETIME();
  CREATE UNIQUE INDEX ux_reports_folder_name ON reports(folder_id, name);
  `,
  // Phase 3: audit log
  `
  CREATE TABLE audit_log (
    id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    logged_at   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    user_id     INT NULL,
    username    NVARCHAR(100) NULL,
    action      NVARCHAR(30) NOT NULL,
    report_id   INT NULL,
    report_name NVARCHAR(200) NULL,
    params      NVARCHAR(4000) NULL,
    row_count   INT NULL,
    status      NVARCHAR(10) NOT NULL DEFAULT 'ok',
    error       NVARCHAR(500) NULL,
    ip          NVARCHAR(64) NULL,
    user_agent  NVARCHAR(300) NULL
  );
  CREATE INDEX ix_audit_at ON audit_log(logged_at DESC);
  CREATE INDEX ix_audit_user ON audit_log(username);
  `,
  // Phase 4: own accounts (forced password change) and scheduled report subscriptions
  `
  ALTER TABLE users ADD must_change_password BIT NOT NULL CONSTRAINT df_users_mcp DEFAULT 0;
  CREATE TABLE subscriptions (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id),
    report_id   INT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    name        NVARCHAR(200) NOT NULL,
    params      NVARCHAR(4000) NOT NULL CONSTRAINT df_subs_params DEFAULT '{}',
    format      NVARCHAR(4) NOT NULL CHECK (format IN ('csv','xlsx')),
    schedule    NVARCHAR(500) NOT NULL,
    folder      NVARCHAR(200) NOT NULL CONSTRAINT df_subs_folder DEFAULT '',
    enabled     BIT NOT NULL CONSTRAINT df_subs_enabled DEFAULT 1,
    next_run_at DATETIME2 NULL,
    last_run_at DATETIME2 NULL,
    last_status NVARCHAR(10) NULL,
    last_error  NVARCHAR(500) NULL,
    failures    INT NOT NULL CONSTRAINT df_subs_failures DEFAULT 0,
    created_at  DATETIME2 NOT NULL CONSTRAINT df_subs_created DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX ix_subs_due ON subscriptions(enabled, next_run_at);
  CREATE INDEX ix_subs_user ON subscriptions(user_id);
  CREATE TABLE subscription_runs (
    id              BIGINT IDENTITY(1,1) PRIMARY KEY,
    subscription_id INT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    user_id         INT NOT NULL,
    started_at      DATETIME2 NOT NULL,
    finished_at     DATETIME2 NULL,
    status          NVARCHAR(10) NOT NULL,
    row_count       INT NULL,
    file_name       NVARCHAR(400) NULL,
    file_size       BIGINT NULL,
    error           NVARCHAR(500) NULL
  );
  CREATE INDEX ix_subruns_sub ON subscription_runs(subscription_id, id DESC);
  CREATE INDEX ix_subruns_user ON subscription_runs(user_id, id DESC);
  `,
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
  await db.query(`IF OBJECT_ID('schema_version','U') IS NULL
    CREATE TABLE schema_version (version INT NOT NULL)`);
  const row = await db.one('SELECT MAX(version) AS v FROM schema_version');
  let current = (row && row.v) || 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    await db.query(`SET XACT_ABORT ON; BEGIN TRANSACTION;\n${MIGRATIONS[i]}\nCOMMIT TRANSACTION;`);
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
  if (!s) await db.query(`INSERT INTO settings (name, value) VALUES ('single_session', 'true')`);
}

module.exports = { migrate, MIGRATIONS, DEFAULT_FOLDERS };
