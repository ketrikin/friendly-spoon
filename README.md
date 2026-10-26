# friendly-spoon — SQL Query Builder for SQL Server / SSMS

A small web app for designing SQL Server (T-SQL) queries visually. You load your database's
schema, then pick tables, joins, columns, filters and sorting. The app writes clean, formatted
T-SQL that you paste into SSMS and run.

It is plain HTML/CSS/JavaScript with **no install, no build step and no server**. It also
**never connects to your database**: you copy the SQL into SSMS yourself, so the app can't run
anything against your data.

## Getting started

1. Open `index.html` in a browser (double-click works). A demo schema is loaded so you can try it right away.
2. Click **Import schema** and follow the three steps:
   - Copy the metadata query and run it against your database in SSMS.
   - In the results grid, select all (top-left corner cell) → right-click → **Copy with Headers**.
   - Paste into the box and click **Import**.

   This reads tables, views, columns, data types, primary keys and foreign keys from `sys.*`
   catalog views. It does not read any row data.

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
  imported schema are kept in your browser's local storage.

## Development

```
npm test     # unit tests for SQL generation and schema parsing (Node 18+)
```

| File | Purpose |
| --- | --- |
| `index.html`, `css/styles.css` | Page layout and styling (light/dark) |
| `js/schema.js` | SSMS metadata query, import parser, demo schema |
| `js/sql.js` | Query model → T-SQL generation (no DOM; tested in `tests/`) |
| `js/app.js` | UI rendering and event handling |
