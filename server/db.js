// SQL Server connection handling and query execution.
'use strict';

const { SCHEMA_QUERY } = require('../js/schema.js');
const { readOnlyProblem } = require('./guard.js');

let pool = null;      // current mssql ConnectionPool
let driver = null;    // the mssql module the pool was created with
let config = null;    // last successful connection settings (kept in memory only)
let info = null;      // { server, database, login, version }

// "host\instance", "host,port" or "host"
function parseServer(server) {
  const s = String(server || '').trim() || 'localhost';
  const comma = s.lastIndexOf(',');
  if (comma > 0) return { host: s.slice(0, comma).trim(), port: parseInt(s.slice(comma + 1), 10) };
  const slash = s.indexOf('\\');
  if (slash > 0) return { host: s.slice(0, slash), instanceName: s.slice(slash + 1) };
  return { host: s };
}

function loadDriver(auth) {
  if (auth !== 'windows') return require('mssql');
  try {
    return require('mssql/msnodesqlv8');
  } catch (e) {
    const err = new Error('Windows authentication needs the optional "msnodesqlv8" package. ' +
      'Stop the server, run "npm install msnodesqlv8", and start it again. ' +
      '(Alternatively use "Windows (NTLM)" or a SQL Server login.)');
    err.status = 400;
    throw err;
  }
}

function buildConfig(c) {
  const encrypt = c.encrypt !== false;
  const trust = c.trustServerCertificate !== false;
  const base = {
    database: c.database || undefined,
    connectionTimeout: 15000,
    requestTimeout: (parseInt(c.timeoutSeconds, 10) || 120) * 1000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 60000 },
  };
  if (c.auth === 'windows') {
    // Integrated security through the ODBC driver (msnodesqlv8), as SSMS does.
    const parts = [
      `Driver={${c.odbcDriver || 'ODBC Driver 18 for SQL Server'}}`,
      `Server=${c.server || 'localhost'}`,
      c.database ? `Database=${c.database}` : '',
      'Trusted_Connection=Yes',
      `Encrypt=${encrypt ? 'Yes' : 'No'}`,
      `TrustServerCertificate=${trust ? 'Yes' : 'No'}`,
    ].filter(Boolean);
    return Object.assign(base, { connectionString: parts.join(';') + ';' });
  }
  const s = parseServer(c.server);
  const cfg = Object.assign(base, {
    server: s.host,
    port: s.port,
    options: { encrypt, trustServerCertificate: trust, instanceName: s.instanceName, appName: 'SQL Query Builder' },
  });
  if (c.auth === 'ntlm') {
    cfg.authentication = { type: 'ntlm', options: { domain: c.domain || '', userName: c.user || '', password: c.password || '' } };
  } else {
    cfg.user = c.user;
    cfg.password = c.password;
  }
  return cfg;
}

async function connect(c) {
  const mssql = loadDriver(c.auth);
  const next = new mssql.ConnectionPool(buildConfig(c));
  await next.connect();
  let details;
  try {
    const r = await next.request().query(
      "SELECT @@SERVERNAME AS server, DB_NAME() AS [database], SUSER_SNAME() AS login, " +
      "CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version, " +
      "CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition");
    details = r.recordset[0];
  } catch (e) {
    await next.close().catch(() => {});
    throw e;
  }
  await disconnect();
  pool = next;
  info = details;
  driver = mssql;
  config = Object.assign({}, c);
  return status();
}

async function disconnect() {
  const old = pool;
  pool = null;
  info = null;
  // Don't let a stuck connection block reconnecting or switching databases.
  if (old) await Promise.race([old.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
}

async function useDatabase(database) {
  if (!config) throw httpError(400, 'Not connected.');
  return connect(Object.assign({}, config, { database }));
}

function status() {
  return pool ? Object.assign({ connected: true, auth: config.auth }, info) : { connected: false };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function requirePool() {
  if (!pool) throw httpError(409, 'Not connected to a database. Click "Connect" first.');
  return pool;
}

async function databases() {
  const r = await requirePool().request().query(
    'SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name');
  return r.recordset.map(x => x.name);
}

async function schemaRows() {
  const r = await requirePool().request().query(SCHEMA_QUERY);
  return r.recordset;
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

// Turn driver values into something JSON-friendly that reads like SSMS output.
function formatValue(v, typeName) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) {
    const hex = v.subarray(0, 64).toString('hex').toUpperCase();
    return '0x' + hex + (v.length > 64 ? '…' : '');
  }
  if (v instanceof Date) {
    if (isNaN(v)) return String(v);
    // The driver reads date/time values as UTC, so UTC parts are the stored values.
    const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    const time = `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}.${pad(v.getUTCMilliseconds(), 3)}`;
    if (typeName === 'date') return date;
    if (typeName === 'time') return time;
    if (typeName === 'datetimeoffset') return v.toISOString();
    return date + ' ' + time;
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function typeNameOf(col) {
  const t = col.type;
  const name = (t && (t.declaration || t.name)) || '';
  return String(name).toLowerCase();
}

// Runs a read-only SELECT, returning at most maxRows rows. The work happens inside a
// transaction that is always rolled back. `onCancel(fn)` registers a cancel callback.
async function runQuery(sqlText, { maxRows = 1000, onCancel } = {}) {
  const problem = readOnlyProblem(sqlText);
  if (problem) throw httpError(400, problem);
  const p = requirePool();
  const limit = Math.max(1, Math.min(parseInt(maxRows, 10) || 1000, 100000));

  const tx = new driver.Transaction(p);
  await tx.begin();
  const started = Date.now();
  const columns = [];
  const types = [];
  const rows = [];
  let truncated = false;
  let cancelled = false;
  const messages = [];

  try {
    await new Promise((resolve, reject) => {
      let failure = null;
      const req = new driver.Request(tx);
      req.stream = true;
      req.arrayRowMode = true;
      if (onCancel) onCancel(() => { cancelled = true; req.cancel(); });
      req.on('info', m => messages.push(m.message));
      req.on('recordset', cols => {
        if (columns.length) return; // only the first result set is shown
        cols.forEach(c => { columns.push({ name: c.name, type: typeNameOf(c) }); types.push(typeNameOf(c)); });
      });
      req.on('row', row => {
        if (truncated || cancelled) return;
        if (rows.length >= limit) {
          truncated = true;
          req.cancel();
          return;
        }
        rows.push(row.map((v, i) => formatValue(v, types[i])));
      });
      // Settle only on 'done': the transaction can't be rolled back (which releases the
      // connection) while the driver is still finishing the request.
      req.on('error', err => {
        if ((truncated || cancelled) && (err.code === 'ECANCEL' || /cancel/i.test(err.message))) return;
        if (!failure) failure = err;
      });
      req.on('done', () => (failure ? reject(failure) : resolve()));
      req.query(sqlText);
    });
  } finally {
    await tx.rollback().catch(() => {});
  }
  if (cancelled && !truncated) throw httpError(499, 'Query cancelled.');
  return { columns, rows, rowCount: rows.length, truncated, elapsedMs: Date.now() - started, messages };
}

module.exports = { connect, disconnect, useDatabase, status, databases, schemaRows, runQuery, parseServer, formatValue };
