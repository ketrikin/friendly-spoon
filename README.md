# friendly-spoon — SQL Query Builder for SQL Server / SSMS

A web app for designing SQL Server (T-SQL) queries visually. You pick tables, joins, columns,
filters and sorting, and it writes clean, formatted T-SQL. You can run the query right in the app
and see the results, or copy it into SSMS.

There are two ways to use it:

| | Open `index.html` directly | Start the local server (`npm start`) |
| --- | --- | --- |
| Build queries, copy them into SSMS | ✅ | ✅ |
| Load your schema | Paste it in from SSMS | Loads automatically when you connect |
| Run queries and see results in the app | — | ✅ |
| Needs | Just a browser | [Node.js](https://nodejs.org) 18 or newer |

## Running queries in the app (local server)

1. Install [Node.js](https://nodejs.org) (the LTS version) if you don't have it.
2. Start the app:
   - **Windows:** double-click `start.cmd`. The first run installs dependencies, then your browser
     opens at <http://localhost:3210>.
   - **Any OS:** in a terminal in this folder, run `npm install` once, then `npm start`, and open
     <http://localhost:3210>.
3. Click **Connect** and enter the same details you use in SSMS's *Connect to Server* window:
   - **Server name:** for example `localhost`, `localhost\SQLEXPRESS` or `myserver,1433`.
   - **Authentication:**
     - *SQL Server Authentication*: a login name and password.
     - *Windows Authentication*: your Windows sign-in, the SSMS default. This needs one extra
       package. Run `npm install msnodesqlv8` once and make sure the
       [Microsoft ODBC Driver for SQL Server](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server)
       is installed (SSMS usually installs it). If you have version 17 instead of 18, change the
       *ODBC driver* field to `ODBC Driver 17 for SQL Server`.
     - *Windows (NTLM)*: a Windows account with domain, user name and password. It needs no extra
       packages.
   - **Database:** optional. You can switch databases from the drop-down in the top bar later.
   - **Encrypt / Trust server certificate:** the same options as in SSMS. Leave both on unless your
     DBA says otherwise.
4. Your tables load into the schema panel automatically. Build a query and press **▶ Run**
   (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>, or <kbd>F5</kbd> as in SSMS).

The results grid shows up to *Max rows* rows (1,000 by default), with column types, `NULL`s and
timing. **Copy** puts the results on the clipboard with headers, ready to paste into Excel.
**Download .csv** saves them as a file. **Cancel** stops a long-running query on the server.

### Safety

- **Read-only.** The app only runs single `SELECT` (or `WITH … SELECT`) statements. Anything else
  is refused, including `INSERT`, `UPDATE`, `DELETE`, `EXEC`, `SELECT … INTO`, DDL and multiple
  statements. As a second safeguard, every query runs inside a transaction that is always rolled back.
  For extra peace of mind, connect with a login that only has read access (`db_datareader`).
- **This computer only.** The server listens on `127.0.0.1`, so other machines can't reach it. It
  also rejects requests made by other websites open in your browser.
- **Passwords aren't saved.** Your password stays in the local server's memory while it runs (so
  you can switch databases) and is never written to disk. The other connection fields are
  remembered in your browser.

## Using it without the server

Open `index.html` directly. A demo schema is loaded so you can try it right away. To use your own
database, click **Import schema** and follow the three steps: run the provided metadata query in
SSMS, then **Copy with Headers**, then paste. This reads tables, views, columns, data types, primary
keys and foreign keys from `sys.*` catalog views. It does not read any row data.

## Building a query

- **Click a table** in the schema panel to start the query from it. Click more tables to join them;
  if a foreign key links them, the `ON` condition is filled in for you.
- **Suggested joins** lists every table related by a foreign key to the tables already in your query.
- **Click a column** (expand a table with ▸) to add it to the `SELECT` list.
- **Columns**: aggregates (`COUNT`, `SUM`, `AVG`, …), column aliases, `DISTINCT`, `TOP (n)`.
  Non-aggregated columns are added to `GROUP BY` automatically.
- **Filters**: `=`, `<>`, `>`, `contains`, `starts with`, `IN (a, b, c)`, `BETWEEN`, `IS NULL`, and more.
  Values are quoted based on the column's data type: `N'…'` for Unicode text, numbers unquoted,
  and `'` escaped. You can also enter `@variables`. A filter with an aggregate becomes `HAVING`.
  Choose **custom** to type any raw condition, for example one that needs parentheses.
- **Sort**: any column or aggregate, ascending or descending.
- Edit a table alias and every reference to it updates.
- The **warnings** under the SQL flag likely mistakes, such as a join with no condition, mixed AND/OR,
  or an `ORDER BY` column that SQL Server would reject.
- **Copy**, **Download .sql**, or **Save** a named query. Saved queries, the current query and the
  schema are kept in your browser's local storage.

## Development

```
npm install
npm test     # unit tests: SQL generation, schema parsing, read-only guard (Node 18+)
npm start    # local server on http://localhost:3210 (set PORT to change it)
```

| File | Purpose |
| --- | --- |
| `index.html`, `css/styles.css` | Page layout and styling (light/dark) |
| `js/schema.js` | SSMS metadata query, import parser, demo schema (shared with the server) |
| `js/sql.js` | Query model → T-SQL generation (no DOM; tested in `tests/`) |
| `js/app.js` | UI rendering, connection and results handling |
| `server/server.js` | Local HTTP server: static files plus the JSON API |
| `server/db.js` | SQL Server connections (`mssql`), schema loading, capped/cancellable queries |
| `server/guard.js` | Read-only check applied to every query before it runs |
| `start.cmd` | Windows one-click launcher |
