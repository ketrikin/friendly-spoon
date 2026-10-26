// T-SQL generation from the query-builder model.
//
// Query model (column references are "alias.Column", "alias.*", "*", or "out:Name" for an
// output column of the SELECT list, usable in ORDER BY):
// {
//   from:    { table: "schema.table", alias },
//   joins:   [{ type: "INNER"|"LEFT"|"RIGHT"|"FULL"|"CROSS", table, alias, on: [{ l, r }] }],
//   select:  [item],   // see below
//   where:   [{ conj: "AND"|"OR", agg, col, fn, args, op, value, value2 }],   // rows with agg go to HAVING
//   orderBy: [{ col, agg, dir: "ASC"|"DESC" }],
//   distinct: bool, top: number|"", offset: number|"",
//   version: "2017"|"2016",  // 2016 = no STRING_AGG / TRIM, use older equivalents
//   rollup: bool,            // GROUP BY ROLLUP (subtotals)
//   into: "#Temp"|"",        // SELECT … INTO
//   vars: [{ name, type, value }],                 // DECLARE @name type = value;
//   dedupe: { on, partition: [ref], orderCol, orderDir }   // keep first row per group
// }
//
// Select items:
//   { kind: "column", col, fn, args, agg, as, sep, distinct, aggOrderCol, aggOrderDir }
//   { kind: "expr", expr, isAgg, as }
//   { kind: "case", whens: [{ col, fn, args, op, value, value2, then }], else, as }
//   { kind: "window", wfn, col, n, partition: [ref], wOrderCol, wOrderDir, frame, as }
//
// Values typed by the user are quoted for the column's type. A value starting with "=" is
// passed through as raw SQL (e.g. "=GETDATE()"), and "@name" is passed through as a variable.
(function (root) {
  'use strict';

  const NUMERIC_TYPES = new Set(['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney', 'bit']);
  const UNICODE_TYPES = new Set(['nchar', 'nvarchar', 'ntext', 'sysname']);

  const AGGREGATES = [
    ['', '—'], ['COUNT', 'COUNT'], ['COUNT_DISTINCT', 'COUNT DISTINCT'],
    ['SUM', 'SUM'], ['AVG', 'AVG'], ['MIN', 'MIN'], ['MAX', 'MAX'],
    ['STRING_AGG', 'Concatenate values'], ['STDEV', 'STDEV'], ['VAR', 'VAR'],
  ];
  const FILTER_AGGREGATES = AGGREGATES.filter(([v]) => v !== 'STRING_AGG');
  const JOIN_TYPES = ['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'];
  const OPERATORS = ['=', '<>', '>', '>=', '<', '<=', 'contains', 'starts with', 'ends with', 'LIKE', 'NOT LIKE',
    'IN', 'NOT IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL',
    'IN (subquery)', 'NOT IN (subquery)', 'EXISTS (subquery)', 'NOT EXISTS (subquery)', 'custom'];
  const NO_VALUE_OPS = new Set(['IS NULL', 'IS NOT NULL']);
  const NO_COLUMN_OPS = new Set(['EXISTS (subquery)', 'NOT EXISTS (subquery)', 'custom']);
  const RAW_VALUE_OPS = new Set(['IN (subquery)', 'NOT IN (subquery)', 'EXISTS (subquery)', 'NOT EXISTS (subquery)', 'custom']);

  const DATE_PARTS = ['year', 'quarter', 'month', 'week', 'day', 'dayofyear', 'weekday', 'hour', 'minute', 'second'];
  const DATE_STYLES = [['23', 'yyyy-mm-dd'], ['101', 'mm/dd/yyyy'], ['103', 'dd/mm/yyyy'], ['120', 'yyyy-mm-dd hh:mi:ss'],
    ['112', 'yyyymmdd'], ['108', 'hh:mi:ss']];

  // Scalar functions applied to a column. {x} is the column, {0}/{1} the arguments.
  // `returns` is the result type ('arg0' = the type given as the first argument).
  const FUNCTIONS = [
    { group: 'Text', id: 'UPPER', label: 'UPPER', tpl: 'UPPER({x})' },
    { group: 'Text', id: 'LOWER', label: 'LOWER', tpl: 'LOWER({x})' },
    { group: 'Text', id: 'TRIM', label: 'TRIM spaces', tpl: 'TRIM({x})', legacy: 'LTRIM(RTRIM({x}))' },
    { group: 'Text', id: 'LEN', label: 'LEN (length)', tpl: 'LEN({x})', returns: 'int' },
    { group: 'Text', id: 'LEFT', label: 'LEFT (first n chars)', tpl: 'LEFT({x}, {0})', args: [{ label: 'n', kind: 'int', def: '10' }] },
    { group: 'Text', id: 'RIGHT', label: 'RIGHT (last n chars)', tpl: 'RIGHT({x}, {0})', args: [{ label: 'n', kind: 'int', def: '10' }] },
    { group: 'Text', id: 'SUBSTRING', label: 'SUBSTRING', tpl: 'SUBSTRING({x}, {0}, {1})',
      args: [{ label: 'start', kind: 'int', def: '1' }, { label: 'length', kind: 'int', def: '10' }] },
    { group: 'Text', id: 'REPLACE', label: 'REPLACE', tpl: 'REPLACE({x}, {0}, {1})',
      args: [{ label: 'find', kind: 'text' }, { label: 'replace with', kind: 'text' }] },
    { group: 'Text', id: 'CONCAT', label: 'CONCAT (append)', tpl: 'CONCAT({x}, {0})', returns: 'nvarchar',
      args: [{ label: "text, or =c.[Column]", kind: 'text' }] },
    { group: 'NULLs', id: 'ISNULL', label: 'ISNULL (replace NULL)', tpl: 'ISNULL({x}, {0})', args: [{ label: 'if NULL use', kind: 'value' }] },
    { group: 'NULLs', id: 'NULLIF', label: 'NULLIF (value → NULL)', tpl: 'NULLIF({x}, {0})', args: [{ label: 'value', kind: 'value' }] },
    { group: 'Convert', id: 'CAST', label: 'CAST', tpl: 'CAST({x} AS {0})', returns: 'arg0', args: [{ label: 'type', kind: 'type', def: 'nvarchar(100)' }] },
    { group: 'Convert', id: 'TRY_CAST', label: 'TRY_CAST (NULL if invalid)', tpl: 'TRY_CAST({x} AS {0})', returns: 'arg0',
      args: [{ label: 'type', kind: 'type', def: 'int' }] },
    { group: 'Convert', id: 'DATE_TEXT', label: 'Date as text', tpl: 'CONVERT(varchar(30), {x}, {0})', returns: 'varchar',
      args: [{ label: 'format', kind: 'style', def: '23' }] },
    { group: 'Dates', id: 'YEAR', label: 'YEAR', tpl: 'YEAR({x})', returns: 'int' },
    { group: 'Dates', id: 'MONTH', label: 'MONTH', tpl: 'MONTH({x})', returns: 'int' },
    { group: 'Dates', id: 'DAY', label: 'DAY', tpl: 'DAY({x})', returns: 'int' },
    { group: 'Dates', id: 'DATEPART', label: 'DATEPART', tpl: 'DATEPART({0}, {x})', returns: 'int',
      args: [{ label: 'part', kind: 'datepart', def: 'quarter' }] },
    { group: 'Dates', id: 'DATENAME', label: 'DATENAME (e.g. month name)', tpl: 'DATENAME({0}, {x})', returns: 'nvarchar',
      args: [{ label: 'part', kind: 'datepart', def: 'month' }] },
    { group: 'Dates', id: 'DATE_ONLY', label: 'Date only (drop time)', tpl: 'CAST({x} AS date)', returns: 'date' },
    { group: 'Dates', id: 'MONTH_START', label: 'First day of month', tpl: 'DATEFROMPARTS(YEAR({x}), MONTH({x}), 1)', returns: 'date' },
    { group: 'Dates', id: 'EOMONTH', label: 'Last day of month', tpl: 'EOMONTH({x})', returns: 'date' },
    { group: 'Dates', id: 'DATEADD', label: 'DATEADD', tpl: 'DATEADD({0}, {1}, {x})',
      args: [{ label: 'part', kind: 'datepart', def: 'day' }, { label: 'amount', kind: 'int', def: '1' }] },
    { group: 'Dates', id: 'AGE', label: 'DATEDIFF until today', tpl: 'DATEDIFF({0}, {x}, GETDATE())', returns: 'int',
      args: [{ label: 'part', kind: 'datepart', def: 'day' }] },
    { group: 'Numbers', id: 'ROUND', label: 'ROUND', tpl: 'ROUND({x}, {0})', args: [{ label: 'decimals', kind: 'int', def: '2' }] },
    { group: 'Numbers', id: 'ABS', label: 'ABS', tpl: 'ABS({x})' },
    { group: 'Numbers', id: 'CEILING', label: 'CEILING', tpl: 'CEILING({x})' },
    { group: 'Numbers', id: 'FLOOR', label: 'FLOOR', tpl: 'FLOOR({x})' },
  ];

  // Window functions: col = takes a column, n = takes a number, order = needs ORDER BY in OVER,
  // agg = aggregate that can be a running total or a whole-group total.
  const WINDOW_FUNCTIONS = [
    { id: 'ROW_NUMBER', label: 'ROW_NUMBER (1, 2, 3 …)', order: true },
    { id: 'RANK', label: 'RANK (ties share, then gap)', order: true },
    { id: 'DENSE_RANK', label: 'DENSE_RANK (ties share, no gap)', order: true },
    { id: 'NTILE', label: 'NTILE (split into n buckets)', n: true, def: '4', order: true },
    { id: 'LAG', label: 'LAG (value from previous row)', col: true, n: true, def: '1', order: true },
    { id: 'LEAD', label: 'LEAD (value from next row)', col: true, n: true, def: '1', order: true },
    { id: 'FIRST_VALUE', label: 'FIRST_VALUE in group', col: true, order: true },
    { id: 'LAST_VALUE', label: 'LAST_VALUE in group', col: true, order: true },
    { id: 'SUM', label: 'SUM', col: true, agg: true },
    { id: 'AVG', label: 'AVG', col: true, agg: true },
    { id: 'COUNT', label: 'COUNT', col: true, agg: true },
    { id: 'MIN', label: 'MIN', col: true, agg: true },
    { id: 'MAX', label: 'MAX', col: true, agg: true },
  ];

  const I = '    ';

  function quoteId(name) {
    return '[' + String(name).replace(/\]/g, ']]') + ']';
  }

  function tableRef(key, schema) {
    const t = schema && schema.tables[key];
    if (t) return quoteId(t.schema) + '.' + quoteId(t.name);
    const i = key.indexOf('.');
    return i < 0 ? quoteId(key) : quoteId(key.slice(0, i)) + '.' + quoteId(key.slice(i + 1));
  }

  function splitRef(ref) {
    const i = ref.indexOf('.');
    return i < 0 ? { alias: '', column: ref } : { alias: ref.slice(0, i), column: ref.slice(i + 1) };
  }

  function instances(query) {
    if (!query.from || !query.from.table) return [];
    return [{ alias: query.from.alias, table: query.from.table }]
      .concat((query.joins || []).map(j => ({ alias: j.alias, table: j.table })));
  }

  // ctx carries the query, schema and an optional alias rename (used for correlated subqueries).
  function makeCtx(query, schema, rename) {
    return { query, schema, legacy: query.version === '2016', rename: rename || null, groupItems: [] };
  }

  function aliasOf(alias, ctx) {
    return ctx && ctx.rename ? ctx.rename(alias) : alias;
  }

  function colExpr(ref, ctx) {
    if (!ref || ref === '*') return '*';
    if (ref.startsWith('out:')) return quoteId(ref.slice(4));
    const { alias, column } = splitRef(ref);
    const a = aliasOf(alias, ctx);
    if (column === '*') return a + '.*';
    return (a ? a + '.' : '') + quoteId(column);
  }

  // Rename alias prefixes inside free-form SQL (only needed for correlated subqueries).
  function renameRaw(text, ctx) {
    let out = String(text || '');
    if (!ctx || !ctx.rename) return out;
    instances(ctx.query).forEach(i => {
      out = out.replace(new RegExp('(^|[^\\w@#.])' + i.alias + '\\.', 'g'), (m, pre) => pre + ctx.rename(i.alias) + '.');
    });
    return out;
  }

  function columnType(ref, query, schema) {
    if (!ref || !schema || ref.startsWith('out:')) return '';
    const { alias, column } = splitRef(ref);
    const inst = instances(query).find(i => i.alias === alias);
    const table = inst && schema.tables[inst.table];
    const col = table && table.columns.find(c => c.name === column);
    return col ? col.type : '';
  }

  function literal(raw, type) {
    const v = String(raw == null ? '' : raw).trim();
    if (v.startsWith('=')) return v.slice(1).trim();       // raw SQL
    if (/^@[A-Za-z_]\w*$/.test(v)) return v;              // @variable / parameter
    if (/^null$/i.test(v)) return 'NULL';
    const isNumber = /^-?\d+(\.\d+)?$/.test(v);
    if (type === 'auto') return isNumber ? v : "N'" + v.replace(/'/g, "''") + "'";
    if (type === 'bit' && /^(true|false)$/i.test(v)) return /^true$/i.test(v) ? '1' : '0';
    if (isNumber && (!type || NUMERIC_TYPES.has(type))) return v;
    return (UNICODE_TYPES.has(type) ? 'N' : '') + "'" + v.replace(/'/g, "''") + "'";
  }

  function escapeLike(v) {
    return String(v == null ? '' : v).replace(/[[%_]/g, '[$&]');
  }

  function findFn(id) {
    return FUNCTIONS.find(f => f.id === id);
  }

  function cleanType(t) {
    const v = String(t || '').trim();
    return /^[A-Za-z]+\s*(\(\s*(\d+|max)\s*(,\s*\d+\s*)?\))?$/i.test(v) ? v : 'nvarchar(100)';
  }

  function fnArg(arg, raw, colType) {
    const v = raw == null || raw === '' ? (arg.def || '') : String(raw);
    switch (arg.kind) {
      case 'int': return /^-?\d+$/.test(v.trim()) ? v.trim() : (arg.def || '0');
      case 'type': return cleanType(v);
      case 'datepart': return DATE_PARTS.includes(v) ? v : (arg.def || 'day');
      case 'style': return /^\d+$/.test(v) ? v : '23';
      case 'value': return literal(v, colType);
      default: return literal(v, 'nvarchar');
    }
  }

  // Column (with optional scalar function) as SQL, and its resulting data type.
  function valueExpr(src, ctx) {
    const base = colExpr(src.col, ctx);
    const f = src.fn && findFn(src.fn);
    if (!f || !src.col || src.col === '*' || src.col.endsWith('.*')) return base;
    const type = columnType(src.col, ctx.query, ctx.schema);
    const tpl = ctx.legacy && f.legacy ? f.legacy : f.tpl;
    const args = (f.args || []).map((a, i) => fnArg(a, (src.args || [])[i], type));
    return tpl.replace(/\{(x|\d)\}/g, (m, k) => (k === 'x' ? base : args[+k]));
  }

  function valueType(src, ctx) {
    const type = columnType(src.col, ctx.query, ctx.schema);
    const f = src.fn && findFn(src.fn);
    if (!f || !f.returns) return type;
    if (f.returns === 'arg0') return cleanType((src.args || [])[0] || f.args[0].def).replace(/\s*\(.*$/, '').toLowerCase();
    return f.returns;
  }

  function aggregate(agg, inner, src, ctx) {
    const isStar = !src.col || src.col === '*' || src.col.endsWith('.*');
    switch (agg) {
      case 'COUNT': return 'COUNT(' + (isStar ? '*' : inner) + ')';
      case 'COUNT_DISTINCT': return 'COUNT(DISTINCT ' + inner + ')';
      case 'STRING_AGG': return stringAgg(src, inner, ctx);
      default: return agg + '(' + inner + ')';
    }
  }

  // Not trimmed: spaces are usually part of the separator (", ").
  function separator(item) {
    const v = item.sep == null ? ', ' : String(item.sep);
    if (v.trim().startsWith('=')) return v.trim().slice(1).trim();
    return "N'" + v.replace(/'/g, "''") + "'";
  }

  function stringAgg(item, inner, ctx) {
    if (!item.distinct && !ctx.legacy) {
      let e = 'STRING_AGG(CAST(' + inner + ' AS nvarchar(max)), ' + separator(item) + ')';
      if (item.aggOrderCol) e += ' WITHIN GROUP (ORDER BY ' + colExpr(item.aggOrderCol, ctx) + ' ' + (item.aggOrderDir || 'ASC') + ')';
      return e;
    }
    return xmlConcat(item, ctx);
  }

  // Concatenation that works on every SQL Server version and supports DISTINCT: a correlated
  // subquery over the same tables/filters, matched to the outer row on the grouped columns.
  function xmlConcat(item, ctx) {
    const sep = separator(item);
    const inner = makeCtx(ctx.query, ctx.schema, alias => alias + '_x');
    const value = sep + ' + CAST(' + valueExpr(item, inner) + ' AS nvarchar(max))';
    const pad = I;
    const lines = ['STUFF((', pad + 'SELECT ' + (item.distinct ? 'DISTINCT ' : '') + value];
    fromLines(inner, []).forEach(l => lines.push(pad + l));

    const where = (ctx.query.where || []).filter(w => !w.agg).map(w => ({ w, sql: condition(w, inner) })).filter(x => x.sql);
    const conds = [];
    if (where.length) {
      const joined = where.map((x, i) => (i ? (x.w.conj || 'AND') + ' ' : '') + x.sql).join(' ');
      conds.push(where.some(x => x.w.conj === 'OR') ? '(' + joined + ')' : joined);
    }
    // NULL-safe match so groups whose value is NULL still get their list.
    ctx.groupItems.forEach(g => {
      const a = itemExpr(g, inner);
      const b = itemExpr(g, ctx);
      conds.push('(' + a + ' = ' + b + ' OR (' + a + ' IS NULL AND ' + b + ' IS NULL))');
    });
    conds.forEach((c, i) => lines.push(pad + (i ? I + 'AND ' : 'WHERE ') + c));

    if (item.distinct) lines.push(pad + 'ORDER BY ' + value);
    else if (item.aggOrderCol) lines.push(pad + 'ORDER BY ' + colExpr(item.aggOrderCol, inner) + ' ' + (item.aggOrderDir || 'ASC'));
    lines.push(pad + "FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, LEN(" + sep + " + N'x') - 1, N'')");
    return lines.join('\n' + I);
  }

  function condition(w, ctx) {
    if (w.op === 'custom') return renameRaw(w.value, ctx).trim();
    const raw = renameRaw(w.value, ctx).trim();
    if (w.op === 'EXISTS (subquery)' || w.op === 'NOT EXISTS (subquery)') {
      return raw ? w.op.replace(' (subquery)', '') + ' (' + raw + ')' : '';
    }
    if (!w.col) return '';
    const isCount = w.agg === 'COUNT' || w.agg === 'COUNT_DISTINCT';
    const type = isCount ? 'int' : valueType(w, ctx);
    const inner = valueExpr(w, ctx);
    const lhs = w.agg ? aggregate(w.agg, inner, w, ctx) : inner;
    const lit = v => literal(v, type);
    const likeType = NUMERIC_TYPES.has(type) ? 'varchar' : type;
    switch (w.op) {
      case 'IS NULL':
      case 'IS NOT NULL':
        return lhs + ' ' + w.op;
      case 'IN':
      case 'NOT IN': {
        const items = String(w.value || '').split(',').map(s => s.trim()).filter(Boolean);
        return items.length ? lhs + ' ' + w.op + ' (' + items.map(lit).join(', ') + ')' : '';
      }
      case 'IN (subquery)':
      case 'NOT IN (subquery)':
        return raw ? lhs + ' ' + w.op.replace(' (subquery)', '') + ' (' + raw + ')' : '';
      case 'BETWEEN':
        return lhs + ' BETWEEN ' + lit(w.value) + ' AND ' + lit(w.value2);
      case 'contains':
        return lhs + ' LIKE ' + literal('%' + escapeLike(w.value) + '%', likeType);
      case 'starts with':
        return lhs + ' LIKE ' + literal(escapeLike(w.value) + '%', likeType);
      case 'ends with':
        return lhs + ' LIKE ' + literal('%' + escapeLike(w.value), likeType);
      case 'LIKE':
      case 'NOT LIKE':
        return lhs + ' ' + w.op + ' ' + literal(w.value, likeType);
      default:
        return lhs + ' ' + (w.op || '=') + ' ' + lit(w.value);
    }
  }

  // ---------- Select items ----------

  function itemKind(item) {
    return item.kind || 'column';
  }

  function isComplete(item) {
    switch (itemKind(item)) {
      case 'expr': return !!String(item.expr || '').trim();
      case 'case': return (item.whens || []).some(w => w.col || NO_COLUMN_OPS.has(w.op));
      case 'window': {
        const w = WINDOW_FUNCTIONS.find(x => x.id === item.wfn);
        return !!w && (!w.col || !!item.col || w.id === 'COUNT');
      }
      default: return !!item.col;
    }
  }

  function isAggregate(item) {
    const k = itemKind(item);
    return (k === 'column' && !!item.agg) || (k === 'expr' && !!item.isAgg);
  }

  function isStar(item) {
    return itemKind(item) === 'column' && (item.col === '*' || item.col.endsWith('.*'));
  }

  function outputName(item) {
    if (item.as && item.as.trim()) return item.as.trim();
    if (itemKind(item) === 'column' && !item.agg && !item.fn && item.col && !isStar(item)) return splitRef(item.col).column;
    return null;
  }

  function caseExpr(item, ctx) {
    const whens = (item.whens || []).map(w => ({ w, sql: condition(w, ctx) })).filter(x => x.sql);
    const lines = ['CASE'];
    whens.forEach(x => lines.push(I + 'WHEN ' + x.sql + ' THEN ' + literal(x.w.then, 'auto')));
    if (String(item.else || '').trim()) lines.push(I + 'ELSE ' + literal(item.else, 'auto'));
    lines.push('END');
    return lines.join('\n' + I);
  }

  function windowExpr(item, ctx, warnings) {
    const w = WINDOW_FUNCTIONS.find(x => x.id === item.wfn);
    const n = /^\d+$/.test(String(item.n || '').trim()) ? String(item.n).trim() : w.def;
    const col = item.col ? colExpr(item.col, ctx) : '*';
    let call;
    if (w.id === 'NTILE') call = 'NTILE(' + n + ')';
    else if (w.id === 'LAG' || w.id === 'LEAD') call = w.id + '(' + col + ', ' + n + ')';
    else if (w.col) call = w.id + '(' + col + ')';
    else call = w.id + '()';

    const over = [];
    const partition = (item.partition || []).filter(Boolean);
    if (partition.length) over.push('PARTITION BY ' + partition.map(p => colExpr(p, ctx)).join(', '));
    const wholeGroup = w.agg && item.frame !== 'running';
    if (item.wOrderCol && !wholeGroup) {
      over.push('ORDER BY ' + colExpr(item.wOrderCol, ctx) + ' ' + (item.wOrderDir || 'ASC'));
    } else if (w.order) {
      over.push('ORDER BY (SELECT NULL)');
      if (warnings) warnings.push(w.id + ' needs an "order by" column to give a meaningful result.');
    } else if (w.agg && !wholeGroup && warnings) {
      warnings.push('A running ' + w.id + ' needs an "order by" column.');
    }
    if (w.agg && item.frame === 'running' && item.wOrderCol) over.push('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW');
    if (w.id === 'LAST_VALUE') over.push('ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING');
    return call + ' OVER (' + over.join(' ') + ')';
  }

  function itemExpr(item, ctx, warnings) {
    switch (itemKind(item)) {
      case 'expr': return renameRaw(item.expr, ctx).trim();
      case 'case': return caseExpr(item, ctx);
      case 'window': return windowExpr(item, ctx, warnings);
      default: {
        const v = valueExpr(item, ctx);
        return item.agg ? aggregate(item.agg, v, item, ctx) : v;
      }
    }
  }

  // ---------- Statement assembly ----------

  function fromLines(ctx, warnings) {
    const q = ctx.query;
    const lines = ['FROM ' + tableRef(q.from.table, ctx.schema) + ' AS ' + aliasOf(q.from.alias, ctx)];
    (q.joins || []).forEach(j => {
      lines.push((j.type === 'INNER' ? 'INNER' : j.type === 'CROSS' ? 'CROSS' : j.type + ' OUTER') +
        ' JOIN ' + tableRef(j.table, ctx.schema) + ' AS ' + aliasOf(j.alias, ctx));
      if (j.type === 'CROSS') return;
      const ons = (j.on || []).filter(o => o.l && o.r).map(o => colExpr(o.l, ctx) + ' = ' + colExpr(o.r, ctx));
      if (!ons.length) {
        warnings.push('The join to ' + j.alias + ' has no ON condition yet.');
        lines.push(I + 'ON 1 = 1  -- TODO: add a join condition');
      }
      ons.forEach((o, i) => lines.push(I + (i ? 'AND ' : 'ON ') + o));
    });
    return lines;
  }

  function cleanVarName(name) {
    return String(name || '').replace(/^@+/, '').replace(/[^\w]/g, '');
  }

  function tempName(name) {
    const n = String(name || '').trim();
    return /^#{0,2}[A-Za-z_]\w*$/.test(n) ? n : quoteId(n);
  }

  function buildSql(query, schema) {
    const warnings = [];
    if (!query || !query.from || !query.from.table) {
      return { sql: '-- Pick a table to start: click one in the schema panel.', warnings };
    }
    const ctx = makeCtx(query, schema);
    const out = [];

    // Variables
    (query.vars || []).forEach(v => {
      const name = cleanVarName(v.name);
      if (!name) return;
      const type = cleanType(v.type || 'int');
      const base = type.replace(/\s*\(.*$/, '').toLowerCase();
      const hasValue = String(v.value == null ? '' : v.value).trim() !== '';
      out.push('DECLARE @' + name + ' ' + type + (hasValue ? ' = ' + literal(v.value, base) : '') + ';');
    });
    if (out.length) out.push('');

    const sel = (query.select || []).filter(isComplete);
    const filters = (query.where || []).map(w => ({ w, sql: condition(w, ctx) })).filter(x => x.sql);
    const whereRows = filters.filter(x => !x.w.agg);
    const havingRows = filters.filter(x => x.w.agg);
    const grouping = sel.some(isAggregate) || havingRows.length > 0;
    if (grouping) {
      sel.filter(it => !isAggregate(it) && itemKind(it) !== 'window').forEach(it => {
        if (isStar(it)) warnings.push('"' + colExpr(it.col) + '" cannot be combined with aggregates — pick individual columns instead.');
        else ctx.groupItems.push(it);
      });
    }

    const dd = query.dedupe && query.dedupe.on ? query.dedupe : null;
    const offset = parseInt(query.offset, 10) > 0 ? parseInt(query.offset, 10) : 0;
    const top = parseInt(query.top, 10) > 0 ? parseInt(query.top, 10) : 0;
    const into = String(query.into || '').trim();

    // Main SELECT … HAVING (wrapped in a CTE when keeping the first row per group).
    const body = [];
    let head = 'SELECT';
    if (query.distinct) head += ' DISTINCT';
    if (top && !offset && !dd) head += ' TOP (' + top + ')';
    body.push(head);
    const exprs = sel.map(it => {
      let e = itemExpr(it, ctx, warnings);
      if (it.as && it.as.trim()) e += ' AS ' + quoteId(it.as.trim());
      else if (itemKind(it) !== 'column') warnings.push('Give each calculated, CASE or window column a name (AS).');
      return e;
    });
    // Helper column for "keep first row per group", named so it can't clash with the user's columns.
    const taken = new Set(sel.map(outputName).filter(Boolean).map(n => n.toLowerCase()));
    let keepCol = '_KeepRow';
    for (let n = 2; taken.has(keepCol.toLowerCase()); n++) keepCol = '_KeepRow' + n;
    if (dd) {
      const part = (dd.partition || []).filter(Boolean);
      if (!part.length) warnings.push('"Keep first row per group": choose the column(s) that define a group.');
      if (!dd.orderCol) warnings.push('"Keep first row per group": choose which row to keep (sort column).');
      exprs.push('ROW_NUMBER() OVER (' + [
        part.length ? 'PARTITION BY ' + part.map(p => colExpr(p, ctx)).join(', ') : '',
        'ORDER BY ' + (dd.orderCol ? colExpr(dd.orderCol, ctx) + ' ' + (dd.orderDir || 'DESC') : '(SELECT NULL)'),
      ].filter(Boolean).join(' ') + ') AS ' + quoteId(keepCol));
    }
    if (!exprs.length) body.push(I + '*');
    exprs.forEach((e, i) => body.push(I + e + (i < exprs.length - 1 ? ',' : '')));
    if (into && !dd) body.push('INTO ' + tempName(into));
    fromLines(ctx, warnings).forEach(l => body.push(l));

    const emit = (keyword, rows) => {
      if (!rows.length) return;
      if (new Set(rows.slice(1).map(x => x.w.conj || 'AND')).size > 1) {
        warnings.push(keyword + ' mixes AND and OR. AND is evaluated first; use a "custom" filter with parentheses if you need a different grouping.');
      }
      rows.forEach((x, i) => body.push(i ? I + (x.w.conj || 'AND') + ' ' + x.sql : keyword + ' ' + x.sql));
    };
    emit('WHERE', whereRows);
    const groupExprs = ctx.groupItems.map(it => itemExpr(it, ctx));
    if (groupExprs.length) {
      if (query.rollup) {
        body.push('GROUP BY ROLLUP (');
        groupExprs.forEach((g, i) => body.push(I + g + (i < groupExprs.length - 1 ? ',' : '')));
        body.push(')');
      } else {
        body.push('GROUP BY');
        groupExprs.forEach((g, i) => body.push(I + g + (i < groupExprs.length - 1 ? ',' : '')));
      }
    } else if (query.rollup && grouping) {
      warnings.push('Subtotals (ROLLUP) need at least one non-aggregated column to group by.');
    }
    emit('HAVING', havingRows);

    // ORDER BY
    const orderItems = (query.orderBy || []).filter(o => o.col);
    const order = [];
    orderItems.forEach(o => {
      if (dd) {
        // Outside the CTE only output column names exist.
        if (o.col.startsWith('out:')) { order.push(quoteId(o.col.slice(4)) + ' ' + (o.dir || 'ASC')); return; }
        const match = sel.find(it => itemKind(it) === 'column' && it.col === o.col && (it.agg || '') === (o.agg || '') && !it.fn);
        const name = match && outputName(match);
        if (name) order.push(quoteId(name) + ' ' + (o.dir || 'ASC'));
        else warnings.push('With "keep first row per group", sort by an output column (it must be in the column list).');
        return;
      }
      if (!o.col.startsWith('out:')) {
        if (grouping && !o.agg && !ctx.groupItems.some(g => itemKind(g) === 'column' && g.col === o.col && !g.fn)) {
          warnings.push('ORDER BY ' + colExpr(o.col) + ' is not in the grouped columns; SQL Server will reject it.');
        }
        if (query.distinct && !sel.some(s => itemKind(s) === 'column' && s.col === o.col && (s.agg || '') === (o.agg || ''))) {
          warnings.push('With DISTINCT, ORDER BY ' + colExpr(o.col) + ' must also appear in the selected columns.');
        }
      }
      const e = o.agg ? aggregate(o.agg, colExpr(o.col, ctx), o, ctx) : colExpr(o.col, ctx);
      order.push(e + ' ' + (o.dir || 'ASC'));
    });
    if (offset && !order.length) {
      order.push('(SELECT NULL)');
      warnings.push('Skipping rows (OFFSET) needs a sort order to be predictable — add a sort.');
    }
    const tail = [];
    if (order.length) {
      tail.push('ORDER BY');
      order.forEach((e, i) => tail.push(I + e + (i < order.length - 1 ? ',' : '')));
    }
    if (offset) {
      tail.push('OFFSET ' + offset + ' ROWS' + (top ? ' FETCH NEXT ' + top + ' ROWS ONLY' : ''));
    }

    if (into && /^#/.test(tempName(into))) {
      const t = tempName(into);
      out.push(query.version === '2016'
        ? "IF OBJECT_ID('tempdb.." + t + "') IS NOT NULL DROP TABLE " + t + ';'
        : 'DROP TABLE IF EXISTS ' + t + ';');
      out.push('');
    }

    if (dd) {
      const names = sel.map(outputName);
      const listable = names.length && names.every(Boolean) && new Set(names.map(n => n.toLowerCase())).size === names.length;
      if (!listable) warnings.push('Name every column (AS) to hide the helper ' + keepCol + ' column from the output.');
      out.push('WITH Ranked AS (');
      body.join('\n').split('\n').forEach(l => out.push(I + l));
      out.push(')');
      out.push('SELECT' + (top && !offset ? ' TOP (' + top + ')' : ''));
      if (listable) names.forEach((n, i) => out.push(I + quoteId(n) + (i < names.length - 1 ? ',' : '')));
      else out.push(I + '*');
      if (into) out.push('INTO ' + tempName(into));
      out.push('FROM Ranked');
      out.push('WHERE ' + quoteId(keepCol) + ' = 1');
    } else {
      body.forEach(l => out.push(l));
    }
    tail.forEach(l => out.push(l));

    out[out.length - 1] += ';';
    return { sql: out.join('\n'), warnings: Array.from(new Set(warnings)) };
  }

  const api = {
    AGGREGATES, FILTER_AGGREGATES, JOIN_TYPES, OPERATORS, NO_VALUE_OPS, NO_COLUMN_OPS, RAW_VALUE_OPS,
    FUNCTIONS, WINDOW_FUNCTIONS, DATE_PARTS, DATE_STYLES,
    quoteId, colExpr, literal, condition, instances, columnType, itemKind, outputName, buildSql,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SqlGen = api;
})(this);
