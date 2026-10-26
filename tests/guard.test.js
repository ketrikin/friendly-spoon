const test = require('node:test');
const assert = require('node:assert');
const { readOnlyProblem } = require('../server/guard.js');
const { parseServer, formatValue } = require('../server/db.js');

test('allows read-only SELECT and WITH queries', () => {
  for (const sql of [
    'SELECT * FROM [dbo].[Orders] AS o;',
    'select top (5) o.[Id] from dbo.Orders o',
    'WITH x AS (SELECT 1 AS a) SELECT a FROM x',
    "SELECT * FROM t WHERE Note = N'please delete; then drop table t'",
    'SELECT [Update], [Set] FROM [dbo].[Insert]',
    '-- DELETE FROM t\nSELECT 1 /* DROP TABLE t; */',
    'SELECT "Exec" FROM t',
  ]) assert.strictEqual(readOnlyProblem(sql), null, sql);
});

test('blocks anything that is not a single read-only SELECT', () => {
  for (const sql of [
    '', '   ', 'DELETE FROM t', 'UPDATE t SET a = 1', 'TRUNCATE TABLE t', 'EXEC sp_who',
    'SELECT 1; DROP TABLE t', 'SELECT * INTO backup FROM t',
    "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'y')",
    'WITH x AS (SELECT 1 AS a) DELETE FROM t',
    "SELECT 1 /* unterminated", "SELECT 'it''s' ; DELETE t",
    'SELECT 1\nGO\nDROP TABLE t',
  ]) assert.notStrictEqual(readOnlyProblem(sql), null, sql);
});

test('parses SSMS-style server names', () => {
  assert.deepStrictEqual(parseServer('localhost\\SQLEXPRESS'), { host: 'localhost', instanceName: 'SQLEXPRESS' });
  assert.deepStrictEqual(parseServer('db.example.com,14330'), { host: 'db.example.com', port: 14330 });
  assert.deepStrictEqual(parseServer(''), { host: 'localhost' });
});

test('formats driver values like SSMS', () => {
  const d = new Date(Date.UTC(2024, 2, 5, 14, 30, 0, 7));
  assert.strictEqual(formatValue(d, 'datetime2'), '2024-03-05 14:30:00.007');
  assert.strictEqual(formatValue(d, 'date'), '2024-03-05');
  assert.strictEqual(formatValue(Buffer.from([0xca, 0xfe]), 'varbinary'), '0xCAFE');
  assert.strictEqual(formatValue(null, 'int'), null);
});
