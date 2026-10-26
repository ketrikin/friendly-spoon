const test = require('node:test');
const assert = require('node:assert');
const { buildSql, literal } = require('../js/sql.js');
const { parseSchemaText, demoSchema } = require('../js/schema.js');

const schema = demoSchema();

function query(overrides) {
  return Object.assign({ from: null, joins: [], select: [], where: [], orderBy: [], distinct: false, top: '' }, overrides);
}

test('empty query returns a hint comment', () => {
  assert.match(buildSql(query({}), schema).sql, /^--/);
});

test('simple select with top, filter and sort', () => {
  const { sql, warnings } = buildSql(query({
    from: { table: 'Sales.Customers', alias: 'c' },
    select: [{ col: 'c.FirstName', agg: '', as: '' }, { col: 'c.Country', agg: '', as: 'Nation' }],
    where: [{ conj: 'AND', agg: '', col: 'c.Country', op: '=', value: "Côte d'Ivoire" }],
    orderBy: [{ col: 'c.FirstName', agg: '', dir: 'DESC' }],
    top: '50',
  }), schema);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(sql, [
    'SELECT TOP (50)',
    '    c.[FirstName],',
    '    c.[Country] AS [Nation]',
    'FROM [Sales].[Customers] AS c',
    "WHERE c.[Country] = N'Côte d''Ivoire'",
    'ORDER BY',
    '    c.[FirstName] DESC;',
  ].join('\n'));
});

test('joins, aggregates, automatic GROUP BY and HAVING', () => {
  const { sql, warnings } = buildSql(query({
    from: { table: 'Sales.Customers', alias: 'c' },
    joins: [{ type: 'LEFT', table: 'Sales.Orders', alias: 'o', on: [{ l: 'o.CustomerID', r: 'c.CustomerID' }] }],
    select: [{ col: 'c.LastName', agg: '', as: '' }, { col: 'o.OrderID', agg: 'COUNT', as: 'Orders' }],
    where: [
      { conj: 'AND', agg: '', col: 'o.OrderDate', op: '>=', value: '2024-01-01' },
      { conj: 'AND', agg: 'COUNT', col: 'o.OrderID', op: '>', value: '5' },
    ],
    orderBy: [{ col: 'o.OrderID', agg: 'COUNT', dir: 'DESC' }],
  }), schema);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(sql, [
    'SELECT',
    '    c.[LastName],',
    '    COUNT(o.[OrderID]) AS [Orders]',
    'FROM [Sales].[Customers] AS c',
    'LEFT OUTER JOIN [Sales].[Orders] AS o',
    '    ON o.[CustomerID] = c.[CustomerID]',
    "WHERE o.[OrderDate] >= '2024-01-01'",
    'GROUP BY',
    '    c.[LastName]',
    'HAVING COUNT(o.[OrderID]) > 5',
    'ORDER BY',
    '    COUNT(o.[OrderID]) DESC;',
  ].join('\n'));
});

test('operators', () => {
  const run = w => buildSql(query({ from: { table: 'Production.Products', alias: 'p' }, where: [w] }), schema).sql.split('\n').pop();
  assert.strictEqual(run({ col: 'p.Name', op: 'contains', value: '50%' }), "WHERE p.[Name] LIKE N'%50[%]%';");
  assert.strictEqual(run({ col: 'p.ProductID', op: 'IN', value: '1, 2,3' }), 'WHERE p.[ProductID] IN (1, 2, 3);');
  assert.strictEqual(run({ col: 'p.ListPrice', op: 'BETWEEN', value: '10', value2: '20.5' }), 'WHERE p.[ListPrice] BETWEEN 10 AND 20.5;');
  assert.strictEqual(run({ col: 'p.CategoryID', op: 'IS NULL' }), 'WHERE p.[CategoryID] IS NULL;');
  assert.strictEqual(run({ col: 'p.Discontinued', op: '=', value: 'true' }), 'WHERE p.[Discontinued] = 1;');
  assert.strictEqual(run({ col: 'p.ProductID', op: '=', value: '@id' }), 'WHERE p.[ProductID] = @id;');
  assert.strictEqual(run({ op: 'custom', value: '(p.ListPrice > 1 OR p.Discontinued = 0)' }), 'WHERE (p.ListPrice > 1 OR p.Discontinued = 0);');
});

test('literal quoting', () => {
  assert.strictEqual(literal('42', 'varchar'), "'42'");
  assert.strictEqual(literal('42', 'int'), '42');
  assert.strictEqual(literal("O'Brien", 'nvarchar'), "N'O''Brien'");
});

test('warnings for missing join condition and mixed AND/OR', () => {
  const { sql, warnings } = buildSql(query({
    from: { table: 'Sales.Customers', alias: 'c' },
    joins: [{ type: 'INNER', table: 'Sales.Orders', alias: 'o', on: [{ l: '', r: '' }] }],
    where: [
      { conj: 'AND', col: 'c.City', op: '=', value: 'A' },
      { conj: 'AND', col: 'c.City', op: '=', value: 'B' },
      { conj: 'OR', col: 'c.City', op: '=', value: 'C' },
    ],
  }), schema);
  assert.match(sql, /ON 1 = 1/);
  assert.strictEqual(warnings.length, 2);
});

test('parses SSMS "Copy with Headers" output', () => {
  const text = [
    'schema\ttable\tcolumn\ttype\tnullable\tpk\tref_schema\tref_table\tref_column',
    'dbo\tCustomers\tId\tint\t0\t1\tNULL\tNULL\tNULL',
    'dbo\tCustomers\tName\tnvarchar\t1\t0\tNULL\tNULL\tNULL',
    'dbo\tOrders\tId\tint\t0\t1\tNULL\tNULL\tNULL',
    'dbo\tOrders\tCustomerId\tint\t0\t0\tdbo\tCustomers\tId',
  ].join('\r\n');
  const s = parseSchemaText(text);
  assert.deepStrictEqual(Object.keys(s.tables), ['dbo.Customers', 'dbo.Orders']);
  const fk = s.tables['dbo.Orders'].columns[1];
  assert.deepStrictEqual(fk.refs, [{ table: 'dbo.Customers', column: 'Id' }]);
  assert.strictEqual(s.tables['dbo.Customers'].columns[0].pk, true);
  assert.strictEqual(s.tables['dbo.Customers'].columns[1].nullable, true);
});

test('rejects empty import', () => {
  assert.throws(() => parseSchemaText('  '), /Nothing to import/);
});
