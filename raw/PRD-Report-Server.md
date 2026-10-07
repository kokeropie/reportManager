# PRD: Web Report Server (SSRS-style RDL Viewer)

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-10-07 |
| **Target runtime** | Node.js 16 on Windows Server 2012 (see Constraints) |

## 1. Summary

An internal web application that works like a lightweight SQL Server Reporting Services (SSRS) portal. Users upload existing `.rdl` report files, the app reads the report definition, connects to a chosen MSSQL or MySQL database, asks the user for the report parameters, runs the query and shows the result as a table. Results can be exported to CSV and XLSX.

The app reuses the query, parameters and column layout already defined in each RDL file. No calculation is added by the app.

## 2. Background

The team has SSRS reports in RDL format. The 19 files in `sampleReport/` are the reference set for building and testing the app. Example: `Invoice List - PJTI (autoDate).rdl`:

- uses the 2008 RDL schema (`http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition`)
- has one data source reference (`PTES_SVRINS02`) and one dataset with a T-SQL `CommandText`
- takes two parameters, `startDate` and `endDate`, whose defaults are expressions (an "autoDate" report). These are only this report's parameters. Every report defines its own, and the app must not assume any particular name, number or type (see FR-16a)
- renders one `<Tablix>` with the columns of its dataset (Divisi, InvoiceID, ClientName, DateOfCreated, ORGAMT, VAT, SUBTOTAL, and others)

All target reports are expected to follow this pattern: one dataset, simple parameters, one tabular layout.

## 3. Goals

1. Run existing tabular RDL reports without opening Visual Studio or an SSRS server.
2. Let a team share reports, organized in folders.
3. Support both MSSQL and MySQL data sources, chosen per report.
4. Export results to CSV and XLSX (`.xlsx`).
5. Run on a company Windows Server.

## 4. Non-goals (v1)

- Charts, gauges, maps, subreports, matrices and drill-through.
- Drill-down toggles, page breaks per group, column groups, and page headers/footers. (Row groups with header/footer rows and sorting are supported, see FR-39.)
- PDF export.
- Report scheduling and email subscriptions.
- Editing or designing RDL files in the app.
- Translating SQL between T-SQL and MySQL. Each report's query must match its database engine.
- Windows (Active Directory) single sign-on.

## 5. Users and roles

| Role | Can do |
|---|---|
| **Admin** | Full access, including the **Connection** folder. Manage users, create connections, create folders, upload/move/delete reports, assign a connection to a report, run reports |
| **Viewer** | Browse every folder **except Connection**, run reports, export results. Never sees connection details (server, username, password) and does not need to know them |

The team is small and shares one server, so user accounts are stored in the app's own database.

## 6. Functional requirements

### 6.1 Authentication
- FR-1: Users sign in with username and password. Passwords are stored hashed (bcrypt).
- FR-2: Sessions expire after inactivity (default 8 hours, configurable).
- FR-2a: **Concurrent use.** Any number of people can be signed in at once, including several people using the same username from different computers. Each browser gets its own session, and each person can open a different report at the same time. Admins can optionally turn off "single session per user" (default: multiple sessions allowed). A single shared Viewer account is therefore supported, but individual accounts are recommended because the audit log (FR-26) records the username.
- FR-3: All pages and API routes except login require a session.

### 6.2 Connections
- FR-3a: Connections are the single place where database access details are stored. A connection holds server IP/host, port, database name, username and password. Report users never enter or see these details. Opening a report only asks for the report's own parameters.
- FR-3b: Connections are created and managed inside the **Connection** folder (see 6.3), which only Administrators can open.
- FR-4: Admins can create, edit, test and delete connections. Fields: name, type (`mssql` or `mysql`), host/IP, port, database, username, password, optional "trust server certificate" for MSSQL.
- FR-5: Passwords are encrypted at rest (AES-256-GCM) using a key from the `.env` file. They are never returned to the browser.
- FR-6: A "Test connection" action reports success or the driver's error message.
- FR-7: A connection cannot be deleted while reports use it, unless the admin confirms detaching them.

### 6.3 Folders and reports
- FR-8: Reports live in folders. Admins can create, rename and delete folders from the website at any time.
- FR-8a: **Default folders**, created on first start: `Accounting`, `Finance`, `Connection`, `MPM`, `ORN`, `ePRV`.
- FR-8b: **`Connection` is a protected system folder.** Only Administrators can see or open it. It cannot be renamed or deleted, and it holds the connection definitions rather than reports. It is hidden from viewers in the folder list, search results and API responses, and direct URL access returns "not found" for non-admins.
- FR-8c: Folder access is all-or-nothing. Every signed-in user, admin or viewer, can open all folders except `Connection`, which is Administrator-only. This includes any folder an admin adds later. There are no per-folder permissions.
- FR-9: **Only Administrators can upload `.rdl` files**, into any folder, from the website. Viewers have no upload, replace, move or delete option, and the corresponding API endpoints reject them. The original file is stored on disk under `reports/`.
- FR-10: On upload the app parses the file and rejects it with a clear message if it is not valid RDL.
- FR-11: The report stores the RDL's `DataSourceReference` name for display. **Each report is assigned exactly one connection**, chosen by an Admin from the existing connections (a dropdown on upload and on the report's settings). A connection can be used by many reports, but a report never has more than one. A report with no connection assigned cannot be run, and viewers see "Not configured, contact an administrator".
- FR-11a: Admins can create a new connection at any time and then assign reports to it. Changing a connection's server, username or password updates every report that uses it, with no change to the reports themselves.
- FR-12: Admins can replace the RDL of an existing report, keeping its folder and connection.
- FR-13: Viewers can search reports by name.

### 6.4 RDL parsing
The parser reads these parts of the RDL:

| RDL element | Used for |
|---|---|
| `ReportParameters` | Name, DataType, Prompt, DefaultValue, AvailableValues (static lists) |
| `DataSets/DataSet/Query/CommandText` | The SQL to run |
| `QueryParameters` | Mapping of `@name` to `=Parameters!name.Value` |
| `Fields` | Field names and types |
| `Body` title textbox | Report title |
| `Tablix` (2008+) or `Table` (2005): columns, header row, detail row, total rows | Column order, widths, header text and cell values |
| Cell `Value` | Any expression the evaluator supports (6.4b) |
| Cell `Style/Format` | Number and date format codes |

- FR-14: Unsupported elements (chart, subreport, matrix/column groups) produce a visible warning on the report page. The table part still renders if present.
- FR-15: Unsupported expressions show the raw field value, plus a warning.

### 6.4a Findings from the sample reports

Analysis of the 19 RDL files in `VS Code/reportManager/sampleReport` (Accounting, Finance, ePRV, billing and bank reports). These findings are binding requirements for the parser and viewer.

| Finding | Requirement |
|---|---|
| 18 of 19 files use the **2008 schema** (`.../2008/01/reportdefinition`) and a `<Tablix>` element, not the 2005 `<Table>`. One older file ("Bank Transaction List ... - Backup") uses `<Table>`. | FR-29: The parser supports both `<Tablix>` (2008/2010/2016 schemas) and `<Table>` (2005 schema). |
| Three data source names are used: `PTES_SVRINS02` (7 reports, MSSQL, uses `dbo.` and custom functions), `dev_kenji` (5) and `dev_kenji_arjuna` (7). The two `dev_kenji*` sources use MySQL-style SQL (for example `DATE(...)`) and `schema.table` names. | FR-30: Connections are matched to RDL data source names. When an admin uploads a report, the app suggests the connection with the same name if one exists, otherwise the admin picks one. A bulk upload of several RDLs with the same data source name can assign them in one step. |
| MySQL reports use **unnamed positional parameters**: `<QueryParameter Name="?">`, filled in order from `=Parameters!Parameter1.Value`, `Parameter2`. MSSQL reports use named parameters (`@startdate`). | FR-31: Query parameters are bound by name for MSSQL and by position for `?` placeholders (MySQL). The order of `QueryParameters` in the RDL is preserved. |
| Parameter names vary: `Parameter1`/`Parameter2`, `startdate`/`enddate`, `startDate`/`endDate`, `clientName`. Counts vary from 2 to 3. | Already covered by FR-16a. Name matching is case-insensitive. |
| Some parameters are `String` even though they hold a date (older Bank Transaction backup), and some reports have a **default value expression**, such as `=DateAdd("d",-1,Today())` for the start and `=DateAdd("d",0,Today())` for the end ("autoDate" reports). | FR-32: Default values that are expressions are evaluated when the form opens. The form shows the pre-filled value and lets the user change it. |
| Cells contain **expressions**, not only `=Fields!X.Value`. Seen in the samples: `IIF`, `Left`, `Right`, `Len`, `Sum`, `Today`, `Now`, `DateAdd`, `day`, `month`, `year`, `monthname`, the `&` concatenation operator, `And`/`Or`, `=`/`<>` comparisons, string literals and nested `IIF`. | FR-33: The app includes an RDL expression evaluator (see 6.4b). This changes the earlier assumption that only simple expressions are needed. The "no extra calculation" rule still holds: the app only evaluates what the RDL says. |
| `Sum(Fields!X.Value)` appears in 3 eFaktur reports, in a footer or total row. | FR-34: Aggregate functions `Sum`, `Count`, `Avg`, `Min` and `Max` are supported over the whole dataset. Total rows show on screen and in the exports. |
| SQL features seen: `TOP (100) PERCENT`, bracketed names such as `dbo.[Clients ...]`, `dbo.Part(...)`, `schema.table` names, and `DEFAULT` as a function argument. | The query is sent to the database exactly as written, so the database does the work. Must pass the query guard (FR-27, FR-27a). |
| **4 of the 19 files use a real row group** (found while building Phase 2; the first analysis missed them). `ePRV ... New v2` and `... Outstanding` group by `Status` and show one group header row per status. Both `Corporate Billing_All v2` files group by `ClientName` with no header row and sort the detail rows by `InvoiceID`. The detail group itself can carry a group expression (`uniqueValue`) and sort expressions. No drill-down, hidden columns, charts or subreports appear in any sample. | FR-39: the renderer supports nested row groups with group header and footer rows, group and sort expressions, and aggregates scoped to a group. It does not support drill-down toggles or a page break per group. |
| `Invoice Proforma List - Void Only.rdl.data` is a binary cache file made by Report Builder, not a report. | FR-35: Upload accepts `.rdl` only and rejects other files, including `.rdl.data`, with a clear message. |

### 6.4b Expression evaluator
- FR-36: A small evaluator for the Visual Basic expression syntax RDL uses. It supports field, parameter and built-in-field references, the operators and functions listed above, and returns clear errors. It must **not** use JavaScript `eval` or any way to run arbitrary code, because RDL files come from outside.
- FR-37: Any function the evaluator does not know shows the raw value in the cell with a warning (FR-15), and the missing function name appears in the upload warnings so it can be added.
- FR-38: Evaluation runs on the server so the on-screen view and both exports always match.

### 6.5 Running a report
- FR-16: The parameter form is built from `ReportParameters`: date picker for DateTime, number input for Integer/Float, checkbox for Boolean, text input for String, dropdown when static AvailableValues exist.
- FR-16a: **Parameters are fully dynamic.** The app never hard-codes parameter names such as `startdate`, `enddate` or `custcode`. The form, validation and query binding are all generated from whatever `ReportParameters` and `QueryParameters` the uploaded RDL declares. A report may have zero, one or many parameters, with any names and any supported types. Parameter names are matched case-insensitively between `QueryParameters` (`@name`) and `ReportParameters`.
- FR-16b: A `QueryParameter` whose value is a literal or a simple expression (not `=Parameters!X.Value`) is passed through as declared. A `@name` used in the SQL but missing from `QueryParameters` is reported as a clear error on upload, not at run time.
- FR-17: Default values from the RDL pre-fill the form where they are literals.
- FR-18: Query parameters are passed through the driver's parameter binding (`@name` for MSSQL, converted to `?` for MySQL). User input is never concatenated into SQL.
- FR-19: Queries have a timeout (default 120 s) and a row cap (default 100,000 rows for on-screen view). Both are configurable.
- FR-20: The viewer shows an HTML table with the RDL's columns, in order, with paging (default 100 rows per page).
- FR-21: Errors (bad connection, SQL error, timeout) are shown in plain language, with the driver message available in a collapsible detail.

### 6.6 Export
- FR-22: **CSV**: UTF-8 with BOM (so Excel opens it correctly), column headers from the RDL, streamed to the client.
- FR-23: **XLSX**: bold header row, frozen header, column widths from the RDL, numeric and date cells stored as real numbers/dates with formats from the RDL where possible.
- FR-24: Exports run the query again with the same parameters and are not subject to the on-screen row cap. A separate, larger export cap applies (default 500,000 rows).

### 6.6a Query safety
- FR-27: Connection accounts are not read-only, so the app checks every RDL query before running it. By default only statements starting with `SELECT` or `WITH` are allowed, and keywords such as `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `EXEC` of non-allow-listed procedures and `xp_` are rejected, with a clear message. An admin can allow stored procedure calls per report if needed. This check runs on upload and again before each run.
- FR-27a: User-defined function calls inside a `SELECT`, such as `dbo.Part(...)`, are allowed and are not treated as `EXEC`. The guard looks for statement-level keywords, not function names, and tests with the `PTES_SVRINS02` samples that call `dbo.` functions (for example `Corporate Billing_All v2.rdl`) must pass.
- FR-28: Database connections are pooled per connection, so many simultaneous users share a small number of database sessions under the connection's single database username. The pool size (default 10) and the number of reports allowed to run at once are configurable.

### 6.7 Administration
- FR-25: Admins can create, disable and reset passwords for users.
- FR-26: An audit log records who ran which report with which parameters and when. Parameter values are logged; connection passwords never are.
- FR-26a: Because everyone shares one Viewer login, each audit entry also records the client IP address and browser user-agent, which is how a run can be traced to a computer.

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| **Platform** | Windows Server 2012. Node 16 compatible code. No native modules that need a newer toolchain without a documented install path. |
| **Security** | HTTPS recommended (reverse proxy or Node TLS). Credentials encrypted at rest. Helmet headers, CSRF protection, login rate limiting. Admin-only routes enforced server-side. |
| **Performance** | Report page opens in under 3 s for up to 10,000 rows. Exports stream, so memory use stays flat for large result sets. |
| **Reliability** | App runs as a Windows service and restarts on failure. |
| **Maintainability** | Plain JavaScript, small modules, a README with install and deployment steps. |
| **Browsers** | Current Chrome, Edge and Firefox. |

## 8. Technical approach

**Stack**
- Backend: Node.js 16, Express
- Database drivers: `mssql`, `mysql2`
- RDL parsing: `fast-xml-parser`
- Excel: `exceljs`
- App storage: a dedicated database on the team's SQL Server 2016 (users, sessions, connections, folders, report metadata, audit log), accessed with the same `mssql` driver. No native modules, so installation on Windows Server 2012 needs no compiler. Decided after `better-sqlite3` could not be installed for both Node 16 and the development machine.
- Frontend: plain HTML, CSS and JavaScript served by Express. No build step.
- Process management: NSSM or PM2 as a Windows service.

**Suggested layout**

```
report-server/
  server.js
  package.json
  .env.example
  README.md
  src/
    db/            app SQL Server store + migrations
    auth/          login, sessions, roles
    connections/   CRUD, encrypt/decrypt, driver factory
    rdl/           parser.js, expressions.js
    reports/       folders, upload, run, export
    export/        csv.js, xlsx.js
  public/          login, report browser, viewer, admin pages
  reports/         uploaded .rdl files (on disk)
  test/            parser + export tests, sample RDL
```

**Main API (all under `/api`)**

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/login`, `/auth/logout` | Session |
| GET/POST/PUT/DELETE | `/connections`, `/connections/:id` | Manage connections (admin) |
| POST | `/connections/:id/test` | Test connection |
| GET/POST/PUT/DELETE | `/folders`, `/folders/:id` | Folder tree |
| POST | `/folders/:id/reports` | Upload RDL |
| GET | `/reports/:id` | Report metadata + parameter definitions + columns |
| POST | `/reports/:id/run` | Run with parameters, returns a page of rows |
| POST | `/reports/:id/export?format=csv\|xlsx` | Download export |

**Run flow**
1. Load the stored RDL and parse it, with the parsed result cached.
2. Validate submitted parameters against the declared types.
3. Open a pooled connection for the report's assigned connection.
4. Execute `CommandText` with bound parameters.
5. Map result rows to the table's columns, applying formats.
6. Return a page of rows (viewer) or stream them (export).

## 9. Constraints and risks

| Risk | Impact | Mitigation |
|---|---|---|
| Node 16 is end-of-life and is the last version supporting Windows Server 2012 | No security patches for the runtime | Keep the app on a private network, pin dependencies, upgrade the OS and Node when possible |
| The app depends on its SQL Server being reachable | App cannot start or sign anyone in | Run it on the existing SQL Server 2016 instance; document the database and login setup in the README |
| T-SQL queries do not run on MySQL | MySQL reports fail | Each report's query must be written for its own engine; show the driver error clearly |
| Custom SQL functions such as `dbo.Part(...)` exist only on the source database | Query fails on the wrong connection | Admin assigns the correct connection; test connection and run errors are explicit |
| Reports with unsupported features | Incomplete rendering | Visible warnings; scope limited to tabular reports |
| Arbitrary SQL from uploaded RDL files | An uploaded RDL could contain destructive SQL | Only admins upload; recommend read-only database accounts for connections; optional check that the query starts with `SELECT` or `WITH` |
| Strict date filters in some RDLs (`>` and `<`) | Boundary dates excluded, which matches SSRS behaviour | Run the query as written; no silent changes |

## 10. Acceptance criteria

- **AC-1:** Uploading `Invoice List - PJTI (autoDate).rdl` shows the title, its two parameters (`startDate`, `endDate`), the field list and the table layout on the report page.
- **AC-1a:** A second RDL with different parameter names, a different number of parameters (including none) and different types produces a correct form and runs without any code change.
- **AC-1b:** All 19 sample RDL files upload without errors. Each shows its parameters, columns and any warnings, and the Backup file (2005 schema) and the 2008-schema files both parse.
- **AC-1c:** The "autoDate" reports open with the start date set to yesterday and the end date set to today.
- **AC-1d:** `eFaktur v5` and `Corporate Billing_All v2` produce the same computed column values and totals as SSRS for the same parameters.
- **AC-2:** With an MSSQL connection assigned, entering the report's parameters (for `Invoice List - PJTI (autoDate)`: startDate and endDate) returns the same rows and column order as SSRS for the same inputs.
- **AC-3:** CSV and XLSX exports contain the same columns and rows as the screen, and the XLSX opens in Excel with correct date and number types.
- **AC-4:** A viewer cannot see the Connection folder or the connections page, upload a report or read a stored password. Requesting a connection URL or API endpoint as a viewer returns "not found".
- **AC-4a:** On a fresh install the folders Accounting, Finance, Connection, MPM, ORN and ePRV exist. A viewer sees all except Connection; an admin sees all six.
- **AC-4b:** An admin creates a connection, uploads an RDL into `Finance`, assigns that connection, and a viewer then runs the report without being asked for any server, username or password.
- **AC-4c:** A report cannot be assigned more than one connection.
- **AC-5:** An invalid RDL upload is rejected with a clear error and nothing is saved.
- **AC-6:** A wrong password or unreachable host on a connection shows a readable error and does not crash the server.
- **AC-7:** The app installs and starts as a Windows service on the target server following the README.

## 11. Delivery phases

**Phase 1: Foundation**
Project setup, app database (SQL Server), login and roles, connections manager with encryption and test button.

**Phase 2: Core**
RDL parser, folder tree and upload, report to connection mapping, parameter form, query runner for MSSQL and MySQL, HTML report viewer with paging.

**Phase 3: Export and release**
CSV and XLSX export, error handling, audit log, Windows service deployment notes, testing against all 19 files in `sampleReport/`.

**Later (not committed)**
Per-folder permissions, grouping and subtotals, PDF export, scheduled reports, Active Directory login, parameter dropdowns populated from a dataset.

## 12. Decisions and open questions

**Decided**
- The server is reachable on the local network only. HTTPS is optional (recommended if sensitive data is shown).
- Phase 3 additions beyond the PRD text: a `/healthz` endpoint, sign-in and sign-out entries in the audit log, an admin audit log page with filters, and refusing an over-cap export instead of truncating it.
- Connection database accounts are **not** read-only. Because of this, the app enforces its own guard (FR-27) and only Administrators can upload RDL files.
- Node 16 is accepted for now. Code must stay compatible with Node 16 and avoid features that block a later upgrade to a newer Node and Windows Server.
- All reports use MSSQL or MySQL. Currently only two databases are in use.
- Multiple people can sign in at the same time and open different reports. Sessions and report runs are independent. A shared login is allowed (see FR-2a).
- **One shared Viewer login** is used for everyone, plus one or more Administrator accounts. Because individual users are not identified, the audit log also records the client IP address and browser (FR-26a).
- Other reports use the same custom SQL functions (such as `dbo.Part`) and are on the same MSSQL server. Calls to user-defined functions inside a `SELECT` are allowed by the query guard (FR-27a).

- Dates are handled as naive wall-clock values (no time zones), the way SSRS shows them. Internally they are UTC `Date` objects read with UTC getters, and the MSSQL and MySQL drivers are set up so values round-trip unchanged. `Today()` and `Now()` use the server's local clock.
- A `String` parameter that holds a date (for example the Bank Transaction List reports) is shown as a plain text box, exactly as the RDL declares it.

**Open**
None at this time.
