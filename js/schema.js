// Schema import: parses the result grid of SCHEMA_QUERY (copied from SSMS) into
// { tables: { "schema.table": { key, schema, name, columns: [...] } } }.
(function (root) {
  'use strict';

  // Run this in SSMS against your database, then in the results grid:
  // click the top-left corner cell to select everything, right-click → "Copy with Headers".
  const SCHEMA_QUERY = `SELECT
    s.name  AS [schema],
    o.name  AS [table],
    c.name  AS [column],
    ty.name AS [type],
    c.is_nullable AS [nullable],
    CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS [pk],
    rs.name AS [ref_schema],
    ro.name AS [ref_table],
    rc.name AS [ref_column]
FROM sys.objects o
JOIN sys.schemas s  ON s.schema_id = o.schema_id
JOIN sys.columns c  ON c.object_id = o.object_id
JOIN sys.types   ty ON ty.user_type_id = c.user_type_id
LEFT JOIN (
    SELECT ic.object_id, ic.column_id
    FROM sys.indexes i
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    WHERE i.is_primary_key = 1
) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
LEFT JOIN sys.foreign_key_columns fkc
       ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
LEFT JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
LEFT JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
LEFT JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id
                        AND rc.column_id = fkc.referenced_column_id
WHERE o.type IN ('U', 'V')   -- user tables and views
  AND o.is_ms_shipped = 0
ORDER BY s.name, o.name, c.column_id;`;

  const FIELDS = ['schema', 'table', 'column', 'type', 'nullable', 'pk', 'ref_schema', 'ref_table', 'ref_column'];

  function truthy(v) {
    return /^(1|true|yes|y)$/i.test(String(v).trim());
  }

  function parseSchemaText(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim());
    if (!lines.length) throw new Error('Nothing to import — paste the results from SSMS first.');

    const delim = lines[0].includes('\t') ? '\t' : ',';
    let rows = lines.map(l => l.split(delim).map(s => s.trim().replace(/^"(.*)"$/, '$1')));

    // Use the header row if present, otherwise assume the columns are in SCHEMA_QUERY order.
    const header = rows[0].map(h => h.toLowerCase().replace(/[[\]"]/g, ''));
    const idx = {};
    if (header.includes('table') && header.includes('column')) {
      FIELDS.forEach(f => { idx[f] = header.indexOf(f); });
      rows = rows.slice(1);
    } else {
      FIELDS.forEach((f, i) => { idx[f] = i; });
    }
    const get = (r, f) => {
      const i = idx[f];
      if (i == null || i < 0 || i >= r.length) return '';
      return r[i] === 'NULL' ? '' : r[i];
    };

    const tables = {};
    for (const r of rows) {
      const schema = get(r, 'schema') || 'dbo';
      const name = get(r, 'table');
      const colName = get(r, 'column');
      if (!name || !colName) continue;
      const key = schema + '.' + name;
      const table = tables[key] || (tables[key] = { key, schema, name, columns: [] });
      let col = table.columns.find(c => c.name === colName);
      if (!col) {
        col = {
          name: colName,
          type: get(r, 'type').toLowerCase(),
          nullable: truthy(get(r, 'nullable')),
          pk: truthy(get(r, 'pk')),
          refs: [],
        };
        table.columns.push(col);
      }
      const refTable = get(r, 'ref_table');
      if (refTable) {
        const ref = { table: (get(r, 'ref_schema') || 'dbo') + '.' + refTable, column: get(r, 'ref_column') };
        if (!col.refs.some(x => x.table === ref.table && x.column === ref.column)) col.refs.push(ref);
      }
    }
    if (!Object.keys(tables).length) {
      throw new Error('No tables found. Make sure you used "Copy with Headers" on the full result grid.');
    }
    return { tables };
  }

  // All foreign-key relationships whose target table is also in the schema.
  function relationships(schema) {
    const out = [];
    Object.values(schema.tables).forEach(t => t.columns.forEach(c => c.refs.forEach(ref => {
      if (schema.tables[ref.table]) out.push({ from: { table: t.key, column: c.name }, to: { table: ref.table, column: ref.column } });
    })));
    return out;
  }

  // Small sample database so the app can be tried without importing anything.
  function demoSchema() {
    const def = {
      'Sales.Customers': [['CustomerID', 'int', 'pk'], ['FirstName', 'nvarchar'], ['LastName', 'nvarchar'], ['Email', 'nvarchar', 'null'],
        ['City', 'nvarchar', 'null'], ['Country', 'nvarchar', 'null'], ['CreatedAt', 'datetime2']],
      'Sales.Orders': [['OrderID', 'int', 'pk'], ['CustomerID', 'int', '', 'Sales.Customers.CustomerID'],
        ['EmployeeID', 'int', 'null', 'HR.Employees.EmployeeID'], ['OrderDate', 'date'], ['Status', 'varchar'], ['TotalAmount', 'money']],
      'Sales.OrderItems': [['OrderItemID', 'int', 'pk'], ['OrderID', 'int', '', 'Sales.Orders.OrderID'],
        ['ProductID', 'int', '', 'Production.Products.ProductID'], ['Quantity', 'int'], ['UnitPrice', 'money']],
      'Production.Products': [['ProductID', 'int', 'pk'], ['Name', 'nvarchar'], ['CategoryID', 'int', 'null', 'Production.Categories.CategoryID'],
        ['ListPrice', 'money'], ['Discontinued', 'bit']],
      'Production.Categories': [['CategoryID', 'int', 'pk'], ['Name', 'nvarchar']],
      'HR.Employees': [['EmployeeID', 'int', 'pk'], ['FirstName', 'nvarchar'], ['LastName', 'nvarchar'], ['Title', 'nvarchar', 'null'],
        ['ManagerID', 'int', 'null', 'HR.Employees.EmployeeID'], ['HireDate', 'date']],
    };
    const tables = {};
    Object.entries(def).forEach(([key, cols]) => {
      const [schema, name] = key.split('.');
      tables[key] = {
        key, schema, name,
        columns: cols.map(([n, type, flags = '', ref]) => {
          const refs = [];
          if (ref) {
            const parts = ref.split('.');
            refs.push({ table: parts[0] + '.' + parts[1], column: parts[2] });
          }
          return { name: n, type, nullable: flags === 'null', pk: flags === 'pk', refs };
        }),
      };
    });
    return { tables };
  }

  const api = { SCHEMA_QUERY, parseSchemaText, relationships, demoSchema };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SchemaTools = api;
})(this);
