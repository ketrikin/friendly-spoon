// T-SQL generation from the query-builder model.
//
// Query model (column references are "alias.Column", "alias.*" or "*"):
// {
//   from:    { table: "schema.table", alias },
//   joins:   [{ type: "INNER"|"LEFT"|"RIGHT"|"FULL"|"CROSS", table, alias, on: [{ l, r }] }],
//   select:  [{ col, agg, as }],
//   where:   [{ conj: "AND"|"OR", agg, col, op, value, value2 }],   // rows with agg go to HAVING
//   orderBy: [{ col, agg, dir: "ASC"|"DESC" }],
//   distinct: bool, top: number|""
// }
(function (root) {
  'use strict';

  const NUMERIC_TYPES = new Set(['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney', 'bit']);
  const UNICODE_TYPES = new Set(['nchar', 'nvarchar', 'ntext', 'sysname']);

  const AGGREGATES = [
    ['', '—'], ['COUNT', 'COUNT'], ['COUNT_DISTINCT', 'COUNT DISTINCT'],
    ['SUM', 'SUM'], ['AVG', 'AVG'], ['MIN', 'MIN'], ['MAX', 'MAX'],
  ];
  const JOIN_TYPES = ['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'];
  const OPERATORS = ['=', '<>', '>', '>=', '<', '<=', 'contains', 'starts with', 'ends with', 'LIKE', 'NOT LIKE',
    'IN', 'NOT IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'custom'];
  const NO_VALUE_OPS = new Set(['IS NULL', 'IS NOT NULL']);

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

  function colExpr(ref) {
    if (!ref || ref === '*') return '*';
    const { alias, column } = splitRef(ref);
    if (column === '*') return alias + '.*';
    return (alias ? alias + '.' : '') + quoteId(column);
  }

  function aggExpr(ref, agg) {
    if (!agg) return colExpr(ref);
    const isStar = !ref || ref === '*' || ref.endsWith('.*');
    if (agg === 'COUNT') return 'COUNT(' + (isStar ? '*' : colExpr(ref)) + ')';
    if (agg === 'COUNT_DISTINCT') return 'COUNT(DISTINCT ' + colExpr(ref) + ')';
    return agg + '(' + colExpr(ref) + ')';
  }

  function instances(query) {
    if (!query.from || !query.from.table) return [];
    return [{ alias: query.from.alias, table: query.from.table }]
      .concat((query.joins || []).map(j => ({ alias: j.alias, table: j.table })));
  }

  function columnType(ref, query, schema) {
    if (!ref || !schema) return '';
    const { alias, column } = splitRef(ref);
    const inst = instances(query).find(i => i.alias === alias);
    const table = inst && schema.tables[inst.table];
    const col = table && table.columns.find(c => c.name === column);
    return col ? col.type : '';
  }

  function literal(raw, type) {
    const v = String(raw == null ? '' : raw).trim();
    if (/^@[A-Za-z_]\w*$/.test(v)) return v;          // @variable / parameter
    if (/^null$/i.test(v)) return 'NULL';
    if (type === 'bit' && /^(true|false)$/i.test(v)) return /^true$/i.test(v) ? '1' : '0';
    if (/^-?\d+(\.\d+)?$/.test(v) && (!type || NUMERIC_TYPES.has(type))) return v;
    return (UNICODE_TYPES.has(type) ? 'N' : '') + "'" + v.replace(/'/g, "''") + "'";
  }

  function escapeLike(v) {
    return String(v == null ? '' : v).replace(/[[%_]/g, '[$&]');
  }

  function condition(w, query, schema) {
    if (w.op === 'custom') return String(w.value || '').trim();
    if (!w.col) return '';
    const isCount = w.agg === 'COUNT' || w.agg === 'COUNT_DISTINCT';
    const type = isCount ? 'int' : columnType(w.col, query, schema);
    const lhs = aggExpr(w.col, w.agg);
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

  function buildSql(query, schema) {
    const warnings = [];
    if (!query || !query.from || !query.from.table) {
      return { sql: '-- Pick a table to start: click one in the schema panel.', warnings };
    }
    const I = '    ';
    const lines = [];

    const sel = (query.select || []).filter(s => s.col);
    const hasAgg = sel.some(s => s.agg);

    let head = 'SELECT';
    if (query.distinct) head += ' DISTINCT';
    const top = parseInt(query.top, 10);
    if (top > 0) head += ' TOP (' + top + ')';
    lines.push(head);
    if (!sel.length) lines.push(I + '*');
    sel.forEach((s, i) => {
      let e = aggExpr(s.col, s.agg);
      if (s.as && s.as.trim()) e += ' AS ' + quoteId(s.as.trim());
      lines.push(I + e + (i < sel.length - 1 ? ',' : ''));
    });

    lines.push('FROM ' + tableRef(query.from.table, schema) + ' AS ' + query.from.alias);
    (query.joins || []).forEach(j => {
      lines.push((j.type === 'INNER' ? 'INNER' : j.type === 'CROSS' ? 'CROSS' : j.type + ' OUTER') +
        ' JOIN ' + tableRef(j.table, schema) + ' AS ' + j.alias);
      if (j.type === 'CROSS') return;
      const ons = (j.on || []).filter(o => o.l && o.r).map(o => colExpr(o.l) + ' = ' + colExpr(o.r));
      if (!ons.length) {
        warnings.push('The join to ' + j.alias + ' has no ON condition yet.');
        lines.push(I + 'ON 1 = 1  -- TODO: add a join condition');
      }
      ons.forEach((o, i) => lines.push(I + (i ? 'AND ' : 'ON ') + o));
    });

    const filters = (query.where || []).map(w => ({ w, sql: condition(w, query, schema) })).filter(x => x.sql);
    const emit = (keyword, rows) => {
      if (!rows.length) return;
      if (new Set(rows.slice(1).map(x => x.w.conj || 'AND')).size > 1) {
        warnings.push(keyword + ' mixes AND and OR. AND is evaluated first; use a "custom" filter with parentheses if you need a different grouping.');
      }
      rows.forEach((x, i) => lines.push(i ? I + (x.w.conj || 'AND') + ' ' + x.sql : keyword + ' ' + x.sql));
    };
    const whereRows = filters.filter(x => !x.w.agg);
    const havingRows = filters.filter(x => x.w.agg);
    emit('WHERE', whereRows);

    const grouping = hasAgg || havingRows.length > 0;
    const groupCols = [];
    if (grouping) {
      sel.filter(s => !s.agg).forEach(s => {
        if (s.col === '*' || s.col.endsWith('.*')) {
          warnings.push('"' + colExpr(s.col) + '" cannot be combined with aggregates — pick individual columns instead.');
        } else if (!groupCols.includes(s.col)) {
          groupCols.push(s.col);
        }
      });
      if (groupCols.length) {
        lines.push('GROUP BY');
        groupCols.forEach((c, i) => lines.push(I + colExpr(c) + (i < groupCols.length - 1 ? ',' : '')));
      }
    }
    emit('HAVING', havingRows);

    const order = (query.orderBy || []).filter(o => o.col);
    if (order.length) {
      lines.push('ORDER BY');
      order.forEach((o, i) => {
        if (grouping && !o.agg && !groupCols.includes(o.col)) {
          warnings.push('ORDER BY ' + colExpr(o.col) + ' is not in the grouped columns; SQL Server will reject it.');
        }
        if (query.distinct && !sel.some(s => s.col === o.col && (s.agg || '') === (o.agg || ''))) {
          warnings.push('With DISTINCT, ORDER BY ' + aggExpr(o.col, o.agg) + ' must also appear in the selected columns.');
        }
        lines.push(I + aggExpr(o.col, o.agg) + ' ' + (o.dir || 'ASC') + (i < order.length - 1 ? ',' : ''));
      });
    }

    lines[lines.length - 1] += ';';
    return { sql: lines.join('\n'), warnings };
  }

  const api = {
    AGGREGATES, JOIN_TYPES, OPERATORS, NO_VALUE_OPS,
    quoteId, colExpr, aggExpr, literal, condition, instances, columnType, buildSql,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SqlGen = api;
})(this);
