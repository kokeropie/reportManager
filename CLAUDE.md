# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

All three phases are implemented: auth, users, connections, folders, RDL parser and expression engine, upload, parameter form, MSSQL/MySQL runner, paged viewer, CSV/XLSX export, audit log, `/healthz`, NSSM service scripts in `deploy/`. The runner, the SQL in `src/` and the deploy scripts were never run against a live database or server (tests use fake executors and fake db objects), so treat a first real run as unverified. Git repo with remote `origin` = github.com/kokeropie/reportManager. Tests that need `sampleReport/` skip themselves when it is absent (a fresh clone). `bash deploy/package-release.sh` builds the Windows release zip; `deploy/setup-windows.ps1` is the one-step server setup (PowerShell 3.0 compatible, parse-checked but never run on a server).

Commands: `npm install`, `npm start` (needs `.env`, see `.env.example` and `README.md`), `npm test` (all), `node --test test/crypto.test.js` (one file). Tests use fake services and need no database. There is no lint setup. The code has only been run on local Node 24 and must stay Node 16 compatible (no `fetch`, `structuredClone` or other newer APIs in `src/`).

- `raw/PRD-Report-Server.md` is the source of truth (FR-/AC- numbered requirements). Read it before building anything. Its section 8 gives the intended stack, folder layout, API table and run flow.
- `sampleReport/` (git-ignored, never pushed: it holds real company SQL) has 19 real SSRS `.rdl` files, plus one `.rdl.data` binary cache file that must be rejected on upload (FR-35). These are the parser's test fixtures (AC-1b).
- All acceptance criteria and tests use the files in `sampleReport/`. There is no separate Danamon file. Use `Invoice List - PJTI (autoDate).rdl` for the simple case and `Corporate Billing_All v2.rdl` for UDF calls and expressions.

## What is being built

An internal "lightweight SSRS" web app. An admin uploads `.rdl` files into folders and assigns each report one stored DB connection (MSSQL or MySQL). A viewer fills in the report's parameters, the app runs the RDL's own query, shows a paged HTML table and exports CSV or XLSX.

Stack: Node.js 16 (must stay Node 16 compatible, because the target is Windows Server 2012), Express 4, `mssql`, `mysql2`, `fast-xml-parser` and `exceljs` (the last two arrive in Phases 2 and 3), and a plain ES-module HTML/CSS/JS frontend with no build step. The app's own data lives in a SQL Server 2016 database, not SQLite, so there are no native modules.

## Code layout

- `src/app.js` builds the Express app. Every `/api` route except `/api/auth/*` sits behind `requireAuth` plus `csrfProtect`. Admin-only routers use `requireAdmin`, which returns 404 to viewers on purpose.
- `src/db/` is a thin `mssql` wrapper (`query`/`one` always bind parameters) and an append-only T-SQL migration list that also seeds the default folders. Never edit a shipped migration; add a new one.
- `src/auth/` holds users (bcryptjs), a SQL-backed `express-session` store, CSRF and the auth/users routers. The CSRF token is fetched from `GET /api/auth/csrf` before login and sent as `X-CSRF-Token`.
- `src/connections/` holds the validate, service (AES-256-GCM encrypt and decrypt), driver (`testConnection`) and routes. Only `service.getWithSecret` returns a plaintext password, and only for the driver.
- `src/rdl/` is the core. `parser.js` turns an RDL file into a definition (parameters, query, `table.rows` plus a `plan` tree of static rows and groups; row `kind` is header/groupHeader/detail/groupFooter/footer). `expressions.js` is the VB-subset evaluator (tokenizer, parser, AST walker; aggregates take a scope; no `eval`). `engine.js` turns query rows into grid rows by walking the plan (partition by group expressions, sort, emit rows) and validates parameters and evaluates defaults. `guard.js` blanks strings/comments/quoted identifiers before checking keywords and scanning `@name`/`?` placeholders. `formats.js` does Format codes.
- `src/runner/` has `binding.js` (named params for MSSQL, positional `?` for MySQL, `@name` to `?` rewriting), `pools.js` (one pool per connection, streaming execute with a row cap), `limiter.js` (max concurrent runs), `runStore.js` (cached results so paging does not re-run the query).
- `src/reports/` has `service.js` (upload, replace, files on disk under `REPORTS_DIR` with random names, parse cache), `runService.js` (describe and run pipeline, plain-language errors with the driver message in `detail`) and `routes.js`. Folder CRUD and `POST /folders/:id/reports` (admin upload) live in `src/folders/routes.js`.
- `src/export/` streams CSV (BOM, back-pressure) and XLSX (exceljs streaming writer) from the same grid the screen uses. Both neutralise text that starts with `=`, `+`, `@`. `runService.fetchGrid` is shared by the screen run and `exportData`; the export has its own cap (`EXPORT_MAX_ROWS`) and fails over the cap instead of truncating.
- `src/audit/` logs runs, exports and sign-ins (user, params, IP, user agent). `audit.log` never throws. The audit list endpoint is admin-only (404 for viewers).
- Dependencies are pinned for Node 16: `mssql` 9.3.2 plus `overrides` for the `@azure/*` packages (newer ones need Node 18-22). Do not run `npm audit fix --force` or bump `mssql` without re-checking `engines` in `package-lock.json`.
- Dates are naive wall-clock values held as UTC `Date`s and read only with UTC getters. MSSQL uses `DateTime` params; MySQL pools use `timezone: 'Z'`.
- `public/js/app.js` is a hash router; screens are in `public/js/views/`. `public/js/api.js` is the fetch wrapper. Its `h()` helper builds DOM with `textContent` only, so never use `innerHTML` with server data.

## Architecture constraints

These decisions span several modules and are easy to break:

- **Everything is driven by the RDL.** Parameter names, count and types are never hard-coded (FR-16a). The form, validation and query binding are generated from `ReportParameters` and `QueryParameters`, matched case-insensitively.
- **The parser must handle both RDL schemas.** `<Tablix>` (2008+) is used by 18 of the 19 samples, and `<Table>` (2005) by the "Bank Transaction List … - Backup" sample (FR-29).
- **Parameter binding differs per engine.**
  - MSSQL uses named `@param`.
  - MySQL reports use unnamed `<QueryParameter Name="?">` placeholders, bound by position in the RDL's declared order (FR-31).
  - Never concatenate user input into SQL (FR-18).
- **The expression evaluator is custom and must not use JS `eval`** (FR-36). RDL files come from outside. It supports VB syntax: `IIF`, `Left`, `Right`, `Len`, `Today`, `Now`, `DateAdd`, `day`/`month`/`year`, `monthname`, `&`, `And`/`Or`, comparisons, and the `Sum`/`Count`/`Avg`/`Min`/`Max` aggregates. It also evaluates default-value expressions like `=DateAdd("d",-1,Today())` for the "autoDate" reports. Unknown functions show the raw value plus a warning. Evaluation runs server-side so the screen and both exports always match.
- **The SQL is sent as written.** Do not translate T-SQL and MySQL. A query guard allows only `SELECT`/`WITH` statements (FR-27) and rejects statement-level keywords such as `INSERT`, `DROP`, `EXEC` and `xp_`. It must not flag UDF calls like `dbo.Part(...)` (FR-27a).
- **Folders and roles.** The `Connection` folder is admin-only. For viewers it must return "not found" everywhere: folder list, search, API and direct URL (FR-8b). Other folders are all-or-nothing, with no per-folder permissions. Only admins upload, replace, move or delete.
- **Connection secrets.** Passwords are AES-256-GCM encrypted with a key from `.env` and are never sent to the browser (FR-5). A report has exactly one connection (FR-11).
- **Exports stream and re-run the query.** They use a larger row cap than the screen (FR-24). CSV is UTF-8 with BOM. XLSX uses real number and date types.
- **Audit log.** It records username, report, parameters, client IP and user-agent (FR-26, FR-26a). It never records connection passwords. One shared Viewer login is expected, so IP and user-agent are what identify a run.

## Sample report notes

Data source names in the samples: `PTES_SVRINS02` (MSSQL, uses `dbo.` and custom functions), `dev_kenji` and `dev_kenji_arjuna` (MySQL-style SQL). On upload, suggest the connection whose name matches the RDL data source name (FR-30).
