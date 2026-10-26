const test = require('node:test');
const assert = require('node:assert');
const { buildSql } = require('../js/sql.js');
const { demoSchema } = require('../js/schema.js');

const schema = demoSchema();
const custOrders = {
  from: { table: 'Sales.Customers', alias: 'c' },
  joins: [{ type: 'INNER', table: 'Sales.Orders', alias: 'o', on: [{ l: 'o.CustomerID', r: 'c.CustomerID' }] }],
};

function build(overrides) {
  return buildSql(Object.assign({ joins: [], select: [], where: [], orderBy: [] }, custOrders, overrides), schema);
}

test('concatenate values with STRING_AGG, keeping the separator spaces and order', () => {
  const { sql, warnings } = build({
    select: [
      { kind: 'column', col: 'c.LastName' },
      { kind: 'column', col: 'o.OrderID', agg: 'STRING_AGG', sep: ', ', aggOrderCol: 'o.OrderDate', aggOrderDir: 'DESC', as: 'OrderIDs' },
    ],
  });
  assert.deepStrictEqual(warnings, []);
  assert.match(sql, /STRING_AGG\(CAST\(o\.\[OrderID\] AS nvarchar\(max\)\), N', '\) WITHIN GROUP \(ORDER BY o\.\[OrderDate\] DESC\) AS \[OrderIDs\]/);
  assert.match(sql, /GROUP BY\n {4}c\.\[LastName\];$/);
});

test('distinct or pre-2017 concatenation uses a NULL-safe correlated FOR XML PATH subquery', () => {
  const { sql } = build({
    version: '2016',
    select: [
      { kind: 'column', col: 'c.Country' },
      { kind: 'column', col: 'c.LastName', fn: 'TRIM', agg: 'STRING_AGG', sep: '; ', distinct: true, as: 'Names' },
    ],
    where: [{ col: 'o.Status', op: '=', value: 'Open' }],
  });
  assert.match(sql, /SELECT DISTINCT N'; ' \+ CAST\(LTRIM\(RTRIM\(c_x\.\[LastName\]\)\) AS nvarchar\(max\)\)/);
  assert.match(sql, /FROM \[Sales\]\.\[Customers\] AS c_x\n/);
  assert.match(sql, /WHERE o_x\.\[Status\] = 'Open'\n/);
  assert.match(sql, /AND \(c_x\.\[Country\] = c\.\[Country\] OR \(c_x\.\[Country\] IS NULL AND c\.\[Country\] IS NULL\)\)/);
  assert.match(sql, /FOR XML PATH\(''\), TYPE\)\.value\('\.', 'nvarchar\(max\)'\), 1, LEN\(N'; ' \+ N'x'\) - 1, N''\) AS \[Names\]/);
  assert.doesNotMatch(sql, /STRING_AGG|TRIM\(c\./);
});

test('column functions in SELECT, WHERE and GROUP BY, with typed literals', () => {
  const { sql } = buildSql({
    from: { table: 'Sales.Orders', alias: 'o' }, joins: [], orderBy: [{ col: 'out:Total', dir: 'DESC' }],
    select: [
      { kind: 'column', col: 'o.OrderDate', fn: 'YEAR', as: 'OrderYear' },
      { kind: 'column', col: 'o.OrderDate', fn: 'DATE_TEXT', args: ['103'], as: 'Uk' },
      { kind: 'column', col: 'o.TotalAmount', fn: 'ROUND', args: ['0'], agg: 'SUM', as: 'Total' },
    ],
    where: [
      { col: 'o.OrderDate', fn: 'YEAR', op: '=', value: '2024' },
      { col: 'o.OrderDate', fn: 'DATEPART', args: ['quarter'], op: 'IN', value: '1, 2' },
      { col: 'o.OrderDate', op: '>=', value: '=DATEADD(day, -30, GETDATE())' },
      { col: 'o.Status', fn: 'ISNULL', args: ["it's"], op: '<>', value: 'x' },
    ],
  }, schema);
  assert.match(sql, /YEAR\(o\.\[OrderDate\]\) AS \[OrderYear\]/);
  assert.match(sql, /CONVERT\(varchar\(30\), o\.\[OrderDate\], 103\) AS \[Uk\]/);
  assert.match(sql, /SUM\(ROUND\(o\.\[TotalAmount\], 0\)\) AS \[Total\]/);
  assert.match(sql, /WHERE YEAR\(o\.\[OrderDate\]\) = 2024\n/);
  assert.match(sql, /AND DATEPART\(quarter, o\.\[OrderDate\]\) IN \(1, 2\)/);
  assert.match(sql, /AND o\.\[OrderDate\] >= DATEADD\(day, -30, GETDATE\(\)\)/);
  assert.match(sql, /AND ISNULL\(o\.\[Status\], 'it''s'\) <> 'x'/);
  assert.match(sql, /GROUP BY\n {4}YEAR\(o\.\[OrderDate\]\),\n {4}CONVERT/);
  assert.match(sql, /ORDER BY\n {4}\[Total\] DESC;$/);
});

test('CASE, window functions and calculated columns', () => {
  const { sql, warnings } = build({
    select: [
      { kind: 'case', whens: [{ col: 'o.TotalAmount', op: '>=', value: '100', then: 'Large' }], else: '0', as: 'Size' },
      { kind: 'window', wfn: 'ROW_NUMBER', partition: ['c.CustomerID', ''], wOrderCol: 'o.OrderDate', wOrderDir: 'DESC', as: 'Recency' },
      { kind: 'window', wfn: 'SUM', col: 'o.TotalAmount', partition: ['c.CustomerID'], wOrderCol: 'o.OrderDate', frame: 'running', as: 'Running' },
      { kind: 'window', wfn: 'SUM', col: 'o.TotalAmount', partition: ['c.CustomerID'], wOrderCol: 'o.OrderDate', frame: 'partition', as: 'GroupTotal' },
      { kind: 'window', wfn: 'LEAD', col: 'o.OrderDate', n: '2', partition: [], wOrderCol: 'o.OrderDate', as: 'Next2' },
      { kind: 'expr', expr: "CONCAT(c.[FirstName], ' ', c.[LastName])", as: 'FullName' },
    ],
  });
  assert.deepStrictEqual(warnings, []);
  assert.match(sql, /CASE\n {8}WHEN o\.\[TotalAmount\] >= 100 THEN N'Large'\n {8}ELSE 0\n {4}END AS \[Size\]/);
  assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY c\.\[CustomerID\] ORDER BY o\.\[OrderDate\] DESC\) AS \[Recency\]/);
  assert.match(sql, /SUM\(o\.\[TotalAmount\]\) OVER \(PARTITION BY c\.\[CustomerID\] ORDER BY o\.\[OrderDate\] ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\) AS \[Running\]/);
  assert.match(sql, /SUM\(o\.\[TotalAmount\]\) OVER \(PARTITION BY c\.\[CustomerID\]\) AS \[GroupTotal\]/);
  assert.match(sql, /LEAD\(o\.\[OrderDate\], 2\) OVER \(ORDER BY o\.\[OrderDate\] ASC\) AS \[Next2\]/);
  assert.doesNotMatch(sql, /GROUP BY/);
});

test('aggregate expressions stay out of GROUP BY; ROLLUP and paging', () => {
  const { sql } = build({
    rollup: true, offset: '20', top: '10',
    select: [
      { kind: 'column', col: 'c.Country' },
      { kind: 'expr', expr: "SUM(CASE WHEN o.[Status] = 'Open' THEN 1 ELSE 0 END)", isAgg: true, as: 'OpenOrders' },
    ],
    orderBy: [{ col: 'c.Country', dir: 'ASC' }],
  });
  assert.match(sql, /^SELECT\n/);
  assert.match(sql, /GROUP BY ROLLUP \(\n {4}c\.\[Country\]\n\)/);
  assert.match(sql, /OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY;$/);
});

test('keep first row per group wraps the query in a CTE; variables and temp table', () => {
  const { sql, warnings } = build({
    vars: [{ name: '@since', type: 'date', value: '2024-01-01' }, { name: 'n', type: 'int', value: '' }],
    into: '#Latest', top: '5',
    select: [{ kind: 'column', col: 'c.LastName' }, { kind: 'column', col: 'o.TotalAmount', as: 'Amount' }],
    where: [{ col: 'o.OrderDate', op: '>=', value: '@since' }],
    dedupe: { on: true, partition: ['c.CustomerID'], orderCol: 'o.OrderDate', orderDir: 'DESC' },
    orderBy: [{ col: 'c.LastName', dir: 'ASC' }],
  });
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(sql, [
    "DECLARE @since date = '2024-01-01';",
    'DECLARE @n int;',
    '',
    'DROP TABLE IF EXISTS #Latest;',
    '',
    'WITH Ranked AS (',
    '    SELECT',
    '        c.[LastName],',
    '        o.[TotalAmount] AS [Amount],',
    '        ROW_NUMBER() OVER (PARTITION BY c.[CustomerID] ORDER BY o.[OrderDate] DESC) AS [_KeepRow]',
    '    FROM [Sales].[Customers] AS c',
    '    INNER JOIN [Sales].[Orders] AS o',
    '        ON o.[CustomerID] = c.[CustomerID]',
    '    WHERE o.[OrderDate] >= @since',
    ')',
    'SELECT TOP (5)',
    '    [LastName],',
    '    [Amount]',
    'INTO #Latest',
    'FROM Ranked',
    'WHERE [_KeepRow] = 1',
    'ORDER BY',
    '    [LastName] ASC;',
  ].join('\n'));
});

test('subquery filters', () => {
  const { sql } = build({
    where: [
      { col: 'c.CustomerID', op: 'NOT IN (subquery)', value: 'SELECT x.[CustomerID] FROM [Sales].[Orders] AS x' },
      { conj: 'AND', op: 'EXISTS (subquery)', value: 'SELECT 1 FROM [Sales].[OrderItems] AS oi WHERE oi.[OrderID] = o.[OrderID]' },
    ],
  });
  assert.match(sql, /WHERE c\.\[CustomerID\] NOT IN \(SELECT x\.\[CustomerID\] FROM \[Sales\]\.\[Orders\] AS x\)\n {4}AND EXISTS \(SELECT 1 FROM/);
});

test('warns about unnamed calculated columns and window functions without an order', () => {
  const { warnings } = build({
    select: [{ kind: 'window', wfn: 'RANK', partition: [] }, { kind: 'expr', expr: '1 + 1' }],
  });
  assert.ok(warnings.some(w => /RANK needs an "order by"/.test(w)));
  assert.ok(warnings.some(w => /Give each calculated/.test(w)));
});

test('first-row-per-group helper column never clashes with a user column', () => {
  const { sql } = build({
    select: [
      { kind: 'column', col: 'c.LastName' },
      { kind: 'window', wfn: 'ROW_NUMBER', partition: [], wOrderCol: 'o.OrderDate', as: '_KeepRow' },
    ],
    dedupe: { on: true, partition: ['c.CustomerID'], orderCol: 'o.OrderDate', orderDir: 'DESC' },
  });
  assert.match(sql, /DESC\) AS \[_KeepRow2\]\n {4}FROM/);
  assert.match(sql, /WHERE \[_KeepRow2\] = 1;$/);
});
