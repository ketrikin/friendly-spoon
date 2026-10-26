// Read-only check for SQL sent from the app. This is a first line of defence: the
// server also runs every query inside a transaction that is always rolled back.
'use strict';

const BLOCKED = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'INTO',
  'EXEC', 'EXECUTE', 'SP_EXECUTESQL', 'GRANT', 'REVOKE', 'DENY', 'BACKUP', 'RESTORE', 'DBCC',
  'SHUTDOWN', 'KILL', 'USE', 'SET', 'BULK', 'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE',
  'OPENXML', 'RECONFIGURE', 'GO', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE', 'WAITFOR', 'CHECKPOINT',
];

// Replace comments, string literals and quoted identifiers with spaces so that keywords
// inside them (e.g. WHERE Note = 'please delete') don't trigger the check.
function stripSql(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('The query has an unclosed /* comment.');
      out += ' ';
    } else if (c === "'" || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < n) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) { i += 2; continue; } // escaped '' "" ]]
          break;
        }
        i++;
      }
      if (i >= n) throw new Error('The query has an unclosed ' + (c === "'" ? 'string' : 'quoted name') + '.');
      i++;
      out += c === "'" ? " '' " : ' x ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Returns null when the SQL is a single read-only SELECT, otherwise a reason string.
function readOnlyProblem(sql) {
  let body;
  try {
    body = stripSql(String(sql || '')).trim().replace(/;\s*$/, '');
  } catch (e) {
    return e.message;
  }
  if (!body) return 'The query is empty.';
  if (body.includes(';')) return 'Only a single statement can be run from the app.';
  const words = body.toUpperCase().match(/[A-Z_@#][A-Z0-9_@#$]*/g) || [];
  if (words[0] !== 'SELECT' && words[0] !== 'WITH') return 'Only SELECT queries can be run from the app.';
  const bad = words.find(w => BLOCKED.includes(w));
  if (bad) return `"${bad}" is not allowed — the app only runs read-only SELECT queries.`;
  return null;
}

module.exports = { stripSql, readOnlyProblem };
