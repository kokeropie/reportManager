# Report Server

Lightweight SSRS-style web app: upload `.rdl` reports, run them against MSSQL or MySQL, export CSV/XLSX. See `raw/PRD-Report-Server.md`.

**Status:** All three phases are built. Phase 1: app database, login and roles, user admin, connections manager with encrypted passwords and a Test button. Phase 2: folders, RDL upload and parsing, report-to-connection mapping, parameter form, query runner for MSSQL and MySQL, paged HTML viewer. Phase 3: CSV and XLSX export, audit log, health check, Windows service scripts.

It has been tested against all 19 files in `sampleReport/` for parsing, expressions, grouping, parameter binding and exports, but **never against a live MSSQL or MySQL database, a real browser session, or Windows Server 2012**. Do a first real run per database engine and walk through the checklist at the end of this file before relying on it.

## Requirements

- Node.js 16 or newer. Windows Server 2012 R2 runs Node 16; plain 2012 is not officially supported by Node, so check `node -v` works there first. The dependencies are pinned so that nothing in the install needs a newer Node.
- SQL Server 2016 or newer for the app's own data. No native Node modules are used, so `npm install` needs no compiler.

## Setup

1. In SQL Server, create an empty database and a login that can create tables in it:
   ```sql
   CREATE DATABASE ReportServer;
   CREATE LOGIN report_app WITH PASSWORD = '<strong password>';
   USE ReportServer;
   CREATE USER report_app FOR LOGIN report_app;
   ALTER ROLE db_owner ADD MEMBER report_app;
   ```
   SQL Server must allow TCP/IP connections and SQL authentication (mixed mode).
2. `npm install`
3. Copy `.env.example` to `.env` and fill it in. Generate the secrets with the commands in the file. **Back up `ENCRYPTION_KEY`**: without it, stored connection passwords cannot be decrypted.
4. `npm start`. On first start the tables and default folders (Accounting, Finance, Connection, MPM, ORN, ePRV) are created, and the first admin is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Remove `ADMIN_PASSWORD` from `.env` afterwards.
5. Open `http://<server>:3000`.

## Using it

1. **Connections** (admin): add one per database the reports read from. Name a connection the same as the RDL's data source (for example `PTES_SVRINS02`) and uploads pick it automatically. Use a read-only database account if you can.
2. **Folders**: open a folder and upload `.rdl` files (several at once is fine). Each upload shows warnings, such as unsupported functions. Pick the connection for a report from the dropdown in the folder list.
3. Anyone signed in opens a report, fills in its parameters and clicks **View report**.

Query rules: only a single `SELECT` or `WITH` statement runs. `INSERT`, `UPDATE`, `DELETE`, `EXEC`, `INTO` and similar keywords are rejected at upload and again at run time. Reports run with a timeout (`QUERY_TIMEOUT_SECONDS`) and a row cap (`MAX_ROWS`).

More admins can be added from the **Users** page, or with `npm run create-admin -- <username> <password>`.

## Exports and audit log

- On a report page, **Export CSV** and **Export Excel** run the query again with the same parameters and download the file. CSV is UTF-8 with a BOM, so Excel opens it correctly. XLSX has a bold frozen header row, column widths from the RDL, and real numbers and dates.
- Exports have their own row limit (`EXPORT_MAX_ROWS`, default 500,000). Above it the export is refused with a message, never cut short.
- Text values that start with `=`, `+` or `@` get a leading quote in both formats, so a database value can never turn into a spreadsheet formula.
- **Audit log** (admin menu): every report run and export, plus sign-ins, with the parameters, the computer's IP address and the browser. Failed runs are logged with the reason. Connection passwords are never recorded.

## Deploying on the Windows server

The app has no native modules, so a release zip built on any machine runs on the server without internet access, npm or a compiler.

**On your own computer:** `bash deploy/package-release.sh` creates `release/report-server-<version>-<date>.zip` (the app plus production `node_modules`). Or clone the repository on the server and let the setup script run `npm ci`.

**On the server (Windows Server 2012 R2 or newer):**

1. Install Node.js 16 (64-bit `.msi` from https://nodejs.org/dist/latest-v16.x/). Check with `node -v`.
2. Unzip the release, for example to `C:\apps\report-server`.
3. Make sure SQL Server (2016 or newer, here or on another machine) allows TCP/IP and SQL logins. The setup script can create the database for you if `sqlcmd` is installed, or run `deploy\create-database.sql` yourself (header of that file explains how).
4. In an **elevated** PowerShell, in the app folder:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\deploy\setup-windows.ps1
   ```
   It asks for the SQL Server details and the first admin login, writes `.env` with freshly generated secrets, optionally creates the database, downloads NSSM if it is missing (or uses `C:\tools\nssm\nssm.exe`), installs the `ReportServer` service (starts automatically, restarts 5 seconds after a crash, logs to `logs\`, opens the firewall port), waits for `/healthz`, and removes the admin password from `.env`.
5. Open `http://<server-name>:3000` from another computer.
6. **Back up `ENCRYPTION_KEY`** from `.env`. Without it the stored connection passwords cannot be decrypted.

To do the steps by hand instead: copy `.env.example` to `.env`, fill it in, test with `node server.js`, then run `deploy\install-service.ps1 -NssmPath <path to nssm.exe>`.

`/healthz` answers `{"ok":true}` when the app and its database are up, and 503 otherwise. Point any monitoring at it.

**HTTPS (recommended if the data is sensitive).** Put IIS with URL Rewrite and Application Request Routing in front, or any reverse proxy, forwarding to `http://localhost:3000`. Then set `TRUST_PROXY=true` and `COOKIE_SECURE=true` in `.env` and restart the service. Make sure the proxy sends `X-Forwarded-For` so the audit log records real client IPs.

**Updating.** Stop the service (`nssm stop ReportServer`), unzip the new release over the old folder (the zip contains no `.env`, `reports\` or `logs\`, so those stay), start the service (`nssm start ReportServer`). New database tables are created automatically on start.

**Backups.** Back up three things: the app database, the `reports\` folder (the uploaded `.rdl` files), and `.env` (especially `ENCRYPTION_KEY`).

**Removing the service.** `.\deploy\uninstall-service.ps1 -NssmPath C:\tools\nssm\nssm.exe`. This does not delete the app, its data or the database.

**If it will not start.** Read `logs\error.log`. The usual causes are a missing `.env` value (the message names it), SQL Server not allowing TCP/IP or SQL logins, or a wrong database login.

## Known notes

- `npm audit` reports about 8 moderate findings in dependencies. They are in code paths this app does not use (Azure sign-in inside the SQL driver, the XML *builder*, UUID functions with a caller-supplied buffer). Upgrading would break the Node 16 pinning, so they are left as they are; revisit when the server moves to a newer Node.
- Exports build the whole result in memory before streaming the file out (grouping needs all rows), so a 500,000-row export of a wide report can use several hundred MB of RAM while it runs.
- The PRD's option to allow stored procedures per report (FR-27) is not built. Only `SELECT` and `WITH` queries run.

## First real run checklist

1. `npm start` creates the tables and the first admin. Sign in.
2. Connections: add `PTES_SVRINS02`, press **Test**. Do the same for a MySQL connection.
3. Upload `Corporate Billing_All v2.rdl` into Finance. The connection should attach by itself.
4. Sign out, sign in as a viewer: no Connection folder, no upload buttons.
5. Run the report, compare rows and totals with SSRS for the same dates.
6. Export CSV and Excel and open them in Excel.
7. Open **Audit log** and find your runs.
8. Install the service and restart the server to confirm it comes back by itself.

## Tests

`npm test` (Node 18+ for the HTTP tests; they use fake services and need no database).

## Notes

- The app database and the report data sources are separate things. Report connections (the **Connection** folder) can point at any MSSQL or MySQL server.
- Set `COOKIE_SECURE=true` once the site is served over HTTPS, and `TRUST_PROXY=true` behind a reverse proxy.
