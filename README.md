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
- **Sort**: any column or aggregate, ascending or descending. You can also sort by a named output
  column, such as a CASE, window or calculated column.
- Edit a table alias and every reference to it updates.

## Advanced options

### Concatenate values from many rows

Use **+ concatenate values**, or pick *Concatenate values* in a column's aggregate list. It turns
the values from every row in a group into one text value, for example each customer with all of their
order numbers:

| LastName | OrderIDs |
| --- | --- |
| Smith | 11, 10 |
| Jones | 14 |

You can choose the separator (`, ` by default), the order of the values, and *distinct values only*.
On SQL Server 2017 or later this uses `STRING_AGG … WITHIN GROUP (ORDER BY …)`. For
**distinct values**, or when *SQL Server version* is set to **2016 or earlier** (under Advanced
options), the app writes the equivalent `STUFF((SELECT … FOR XML PATH('')…), 1, …)` subquery. That
version is matched to each group, handles `&`, `<` and `NULL` group values correctly, and returns
the same results.

### Functions on columns (ƒ)

Every column, filter and CASE condition has a **ƒ** list:

- **Text**: `UPPER`, `LOWER`, `TRIM`, `LEN`, `LEFT`, `RIGHT`, `SUBSTRING`, `REPLACE`, `CONCAT`
- **NULLs**: `ISNULL` (replace NULLs), `NULLIF`
- **Convert**: `CAST`, `TRY_CAST`, *date as text* (`CONVERT` with a style such as dd/mm/yyyy)
- **Dates**: `YEAR`, `MONTH`, `DAY`, `DATEPART`, `DATENAME`, *date only*, *first/last day of month*,
  `DATEADD`, *days/months/… until today* (`DATEDIFF`)
- **Numbers**: `ROUND`, `ABS`, `CEILING`, `FLOOR`

A filter such as *YEAR(OrderDate) = 2024* is written as `WHERE YEAR(o.[OrderDate]) = 2024`.
Grouped columns with a function are repeated in `GROUP BY` for you.

### More column types

- **+ CASE**: `CASE WHEN … THEN … ELSE … END`, using the same condition builder as filters.
- **+ window function**: `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `NTILE`, `LAG`/`LEAD` (value from the
  previous/next row), `FIRST_VALUE`/`LAST_VALUE`, and `SUM`/`AVG`/`COUNT`/`MIN`/`MAX` as either a
  **running total** or a **total for the whole group**. Each one takes *per group of* (`PARTITION BY`)
  and *ordered by* columns.
- **+ calculated**: type any SQL expression. Tick *aggregate* if it uses `SUM`/`COUNT`/…, for example
  `SUM(CASE WHEN o.[Status] = 'Open' THEN 1 ELSE 0 END)`, so it stays out of `GROUP BY`.

### Filters

- **Subqueries**: `IN (subquery)`, `NOT IN (subquery)`, `EXISTS (subquery)`, `NOT EXISTS (subquery)`.
- **Raw SQL values**: start a value with `=` to use it as SQL instead of text, for example
  `=DATEADD(day, -30, GETDATE())`. This works in filter values, CASE results and function arguments.

### Query-level options (the *Advanced options* panel)

- **SQL Server version**: *2017 or later*, or *2016 or earlier*. The older setting avoids
  `STRING_AGG` and `TRIM`.
- **Keep first row per group**: for example, each customer's most recent order. This wraps the query
  in a CTE with `ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)` and keeps row 1. Name every column
  (`AS`) so the helper `_KeepRow` column is left out of the output.
- **Subtotals**: `GROUP BY ROLLUP (…)` adds subtotal and grand-total rows.
- **Skip rows**: paging with `OFFSET … ROWS FETCH NEXT … ROWS ONLY`. *TOP* sets the page size.
- **Save into table**: `SELECT … INTO #Results`, preceded by `DROP TABLE IF EXISTS`, so the script
  can be re-run and later steps can use the temp table.
- **Variables**: `DECLARE @name type = value;` at the top of the script. Use `@name` in filters.

## Checking and saving

- The **warnings** under the SQL flag likely mistakes, such as a join with no condition, mixed AND/OR,
  or an `ORDER BY` column that SQL Server would reject.
- **Copy**, **Download .sql**, or **Save** a named query. Saved queries, the current query and the
  imported schema are kept in your browser's local storage.

## Development

```
npm test     # unit tests for SQL generation (incl. advanced options) and schema parsing (Node 18+)
```

| File | Purpose |
| --- | --- |
| `index.html`, `css/styles.css` | Page layout and styling (light/dark) |
| `js/schema.js` | SSMS metadata query, import parser, demo schema |
| `js/sql.js` | Query model → T-SQL generation (no DOM; tested in `tests/`) |
| `js/app.js` | UI rendering and event handling |
