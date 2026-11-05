import { Terminal } from './terminal.js';
import { EXAMPLES, WELCOME } from './examples.js';

// ===========================================================================
// Configuration
// ===========================================================================
const PYODIDE_VERSION = '0.29.3';
const params = new URLSearchParams(location.search);
let INDEX_URL = params.get('pyodide') || `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
if (!INDEX_URL.endsWith('/')) INDEX_URL += '/';

const TEXT_EXT = /\.(py|pyi|txt|md|rst|json|csv|tsv|toml|ya?ml|ini|cfg|conf|html?|css|js|mjs|ts|xml|svg|sql|sh|log|env|gitignore|tex|r|c|h|cpp|java|rs|go)$/i;
const $ = (sel) => document.querySelector(sel);

// ===========================================================================
// Cross-origin isolation (needed for SharedArrayBuffer → input() and Ctrl+C)
// ===========================================================================
async function ensureIsolation() {
  if (window.crossOriginIsolated) {
    sessionStorage.removeItem('pyide:coi-reload');
    return true;
  }
  if (!('serviceWorker' in navigator) || !window.isSecureContext || params.has('nocoi')) return true;
  try {
    await navigator.serviceWorker.register(new URL('../coi-sw.js', import.meta.url));
    if (!sessionStorage.getItem('pyide:coi-reload')) {
      sessionStorage.setItem('pyide:coi-reload', '1');
      await navigator.serviceWorker.ready;
      location.reload();
      return false;
    }
  } catch (err) {
    console.warn('Service worker registration failed; continuing without isolation', err);
  }
  return true; // continue in limited mode
}

// ===========================================================================
// Settings
// ===========================================================================
const DEFAULT_SETTINGS = { theme: 'auto', fontSize: 14, autoInstall: true, clearOnRun: false, wrap: false };
const settings = (() => {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('pyide:settings') || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
})();
function saveSettings() {
  try { localStorage.setItem('pyide:settings', JSON.stringify(settings)); } catch { /* private mode */ }
}
function applySettings() {
  const root = document.documentElement;
  if (settings.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  root.style.setProperty('--font-size', settings.fontSize + 'px');
  if (window.cm) {
    cm.setOption('lineWrapping', !!settings.wrap);
    cm.refresh();
  }
}

// ===========================================================================
// Persistent storage (IndexedDB, falling back to localStorage)
// ===========================================================================
const store = {
  dbp: null,
  db() {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('browser-python-ide', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbp;
  },
  async get(key) {
    try {
      const db = await this.db();
      return await new Promise((resolve, reject) => {
        const req = db.transaction('kv').objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch {
      try { return JSON.parse(localStorage.getItem('pyide:' + key)); } catch { return undefined; }
    }
  },
  async set(key, value) {
    try {
      const db = await this.db();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      try { localStorage.setItem('pyide:' + key, JSON.stringify(value)); } catch { /* quota */ }
    }
  },
};

// ===========================================================================
// Small helpers
// ===========================================================================
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function fmtBytes(n) {
  if (n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtTime(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function downloadBlob(data, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function tryDecodeText(bytes) {
  if (bytes.length > 2 * 1024 * 1024) return null;
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

function validName(name) {
  return name && !name.startsWith('/') && !name.split('/').some((p) => !p || p === '.' || p === '..') && !/[\\:*?"<>|]/.test(name);
}

// ===========================================================================
// Project model: text files are editor tabs, other files are binary blobs
// ===========================================================================
const project = { files: {}, order: [], active: null };
const docs = new Map(); // path -> CodeMirror.Doc
const dirty = new Set(); // paths to (re)send to the worker
const removed = new Set(); // paths to delete in the worker
let saveTimer = null;

function modeFor(path) {
  if (/\.pyi?$/i.test(path)) return { name: 'python', version: 3, singleLineStringErrors: false };
  return 'text/plain';
}

function snapshotFiles() {
  for (const [path, doc] of docs) project.files[path] = { text: doc.getValue() };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 350);
}

async function saveProject() {
  clearTimeout(saveTimer);
  snapshotFiles();
  await store.set('project', { files: project.files, order: project.order, active: project.active });
}

function uniqueName(base) {
  if (!project.files[base]) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 2; ; i++) {
    const name = `${stem}${i}${ext}`;
    if (!project.files[name]) return name;
  }
}

function addTextFile(path, text, { open = true, overwrite = false } = {}) {
  if (project.files[path] && !overwrite) path = uniqueName(path);
  project.files[path] = { text };
  if (docs.has(path)) {
    docs.get(path).setValue(text);
  } else {
    const doc = CodeMirror.Doc(text, modeFor(path));
    docs.set(path, doc);
    project.order.push(path);
  }
  dirty.add(path);
  removed.delete(path);
  if (open) openFile(path);
  else renderTabs();
  scheduleSave();
  return path;
}

function addBinaryFile(path, bytes) {
  project.files[path] = { b64: bytesToB64(bytes) };
  dirty.add(path);
  removed.delete(path);
  scheduleSave();
}

function deleteFile(path) {
  delete project.files[path];
  docs.delete(path);
  project.order = project.order.filter((p) => p !== path);
  dirty.delete(path);
  removed.add(path);
  if (project.active === path) {
    project.active = null;
    if (!project.order.length) addTextFile('main.py', '', { open: false });
    openFile(project.order[0]);
  }
  renderTabs();
  scheduleSave();
}

function renameFile(oldPath, newPath) {
  if (oldPath === newPath) return true;
  if (!validName(newPath)) { toast('Invalid file name'); return false; }
  if (project.files[newPath]) { toast(`${newPath} already exists`); return false; }
  const doc = docs.get(oldPath);
  project.files[newPath] = project.files[oldPath];
  delete project.files[oldPath];
  docs.delete(oldPath);
  docs.set(newPath, doc);
  if (cm.getDoc() === doc) cm.setOption('mode', modeFor(newPath));
  project.order = project.order.map((p) => (p === oldPath ? newPath : p));
  if (project.active === oldPath) project.active = newPath;
  removed.add(oldPath);
  dirty.delete(oldPath);
  dirty.add(newPath);
  removed.delete(newPath);
  renderTabs();
  scheduleSave();
  return true;
}

function openFile(path) {
  if (!docs.has(path)) return;
  project.active = path;
  const doc = docs.get(path);
  if (cm.getDoc() !== doc) cm.swapDoc(doc);
  cm.setOption('mode', modeFor(path));
  renderTabs();
  updateCursorStatus();
  cm.focus();
  scheduleSave();
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.textContent = '';
  for (const path of project.order) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (path === project.active ? ' active' : '');
    tab.setAttribute('role', 'tab');
    tab.tabIndex = 0;
    tab.title = `${path} — double-click to rename`;
    const label = document.createElement('span');
    label.textContent = path;
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Delete file';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = docs.get(path)?.getValue() || '';
      if (text.trim() && !confirm(`Delete ${path}? This cannot be undone.`)) return;
      deleteFile(path);
    });
    tab.append(label, close);
    tab.addEventListener('click', () => openFile(path));
    tab.addEventListener('keydown', (e) => { if (e.key === 'Enter') openFile(path); if (e.key === 'F2') startRename(tab, path); });
    tab.addEventListener('dblclick', () => startRename(tab, path));
    tabs.appendChild(tab);
    if (path === project.active) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
}

function startRename(tab, path) {
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = path;
  input.spellcheck = false;
  tab.textContent = '';
  tab.appendChild(input);
  input.focus();
  const dot = path.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : path.length);
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (commit && name && !renameFile(path, name)) { /* keep old name */ }
    renderTabs();
    cm.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function newFile() {
  const path = addTextFile(uniqueName('untitled.py'), '');
  const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith(path));
  if (tab) startRename(tab, path);
}

function collectDirty() {
  const files = {};
  for (const path of dirty) {
    if (docs.has(path)) files[path] = { text: docs.get(path).getValue() };
    else if (project.files[path]) files[path] = project.files[path];
  }
  dirty.clear();
  const gone = [...removed];
  removed.clear();
  return { files, removed: gone };
}

function allFiles() {
  snapshotFiles();
  dirty.clear();
  removed.clear();
  return { ...project.files };
}

// ===========================================================================
// Python worker client
// ===========================================================================
class Python {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.waitingInput = false;
  }

  start(files) {
    this.ready = false;
    this.version = null;
    this.shared = window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'
      ? { interrupt: new SharedArrayBuffer(1), stdin: new SharedArrayBuffer(8 + (1 << 20)) }
      : null;
    this.interruptView = this.shared ? new Uint8Array(this.shared.interrupt) : null;
    this.stdinCtrl = this.shared ? new Int32Array(this.shared.stdin, 0, 2) : null;
    this.stdinData = this.shared ? new Uint8Array(this.shared.stdin, 8) : null;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      onFatal(e.message || 'The Python worker failed to start.');
    };
    this.worker.postMessage({ type: 'init', indexURL: INDEX_URL, shared: this.shared, files });
  }

  call(type, payload = {}, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...payload, type, id }, transfer);
    });
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'stdout': term.write(msg.text, 'stdout'); break;
      case 'stderr': term.write(msg.text, 'stderr'); break;
      case 'display': term.rich(msg.mime, msg.data, msg.meta); break;
      case 'status': term.system(msg.text); break;
      case 'stdin-request': showStdinField(); break;
      case 'error-location': markError(msg.path, msg.line); break;
      case 'ready':
        this.ready = true;
        this.version = msg;
        onReady(msg);
        break;
      case 'fatal': onFatal(msg.error); break;
      case 'reply': {
        const p = this.pending.get(msg.id);
        if (!p) break;
        this.pending.delete(msg.id);
        if ('error' in msg) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
        break;
      }
    }
  }

  get canInterrupt() { return !!this.shared; }

  interrupt() {
    if (!this.shared) return false;
    this.interruptView[0] = 2;
    if (this.waitingInput) this.answerStdin(null, 2);
    return true;
  }

  answerStdin(text, state = 1) {
    this.waitingInput = false;
    if (!this.stdinCtrl) return;
    if (state === 1) {
      const bytes = new TextEncoder().encode(text);
      const n = Math.min(bytes.length, this.stdinData.length);
      this.stdinData.set(bytes.subarray(0, n));
      this.stdinCtrl[1] = n;
    }
    Atomics.store(this.stdinCtrl, 0, state);
    Atomics.notify(this.stdinCtrl, 0);
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.waitingInput = false;
    for (const p of this.pending.values()) p.reject(new Error('Python was restarted'));
    this.pending.clear();
  }
}

// ===========================================================================
// UI state
// ===========================================================================
let cm; // CodeMirror editor
let term; // Terminal
const py = new Python();
const ui = { busy: false, runStart: 0, timer: null, stopTimer: null, continuation: false, indent: '' };
let stdinField = null;

function setState(kind, text) {
  const el = $('#st-state');
  el.className = 'st-state ' + kind;
  el.lastElementChild.textContent = text;
}

function setBusy(busy, label = 'Running') {
  ui.busy = busy;
  $('#run-btn').disabled = busy || !py.ready;
  const stop = $('#stop-btn');
  stop.disabled = !busy;
  stop.classList.toggle('running', busy);
  stop.querySelector('span').textContent = 'Stop';
  clearTimeout(ui.stopTimer);
  clearInterval(ui.timer);
  $('#prompt-row').hidden = busy || !py.ready;
  if (busy) {
    ui.runStart = performance.now();
    const tick = () => {
      if (py.waitingInput) setState('input', 'Waiting for input…');
      else setState('busy', `${label}… ${fmtTime(performance.now() - ui.runStart)}`);
    };
    tick();
    ui.timer = setInterval(tick, 200);
  } else {
    removeStdinField();
    if (py.ready) setState('ready', 'Ready');
    focusRepl(false);
  }
}

function focusRepl(force = true) {
  if (ui.busy) return;
  const active = document.activeElement;
  if (!force && active && (active.closest('.CodeMirror') || active.matches('input, textarea, select'))) return;
  if ($('#panel-console').hidden) return;
  $('#repl').focus({ preventScroll: true });
}

// ===========================================================================
// Startup
// ===========================================================================
async function loadProject() {
  const saved = await store.get('project');
  if (saved && saved.files && Object.keys(saved.files).length) {
    project.files = saved.files;
    project.order = (saved.order || []).filter((p) => saved.files[p] && saved.files[p].text !== undefined);
    for (const [p, f] of Object.entries(saved.files)) if (f.text !== undefined && !project.order.includes(p)) project.order.push(p);
    project.active = saved.active;
  } else {
    project.files = { 'main.py': { text: WELCOME } };
    project.order = ['main.py'];
    project.active = 'main.py';
  }
  for (const path of project.order) docs.set(path, CodeMirror.Doc(project.files[path].text, modeFor(path)));
  if (!project.order.length) {
    project.files['main.py'] = { text: '' };
    project.order = ['main.py'];
    docs.set('main.py', CodeMirror.Doc('', modeFor('main.py')));
  }
  if (!docs.has(project.active)) project.active = project.order[0];
}

async function importSharedFromHash() {
  const m = location.hash.match(/^#code=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const data = JSON.parse(await decodeShare(m[1]));
    const names = Object.keys(data.files || {});
    if (!names.length) return;
    const clash = names.filter((n) => project.files[n]);
    const msg = `Open the shared code (${names.join(', ')})?` + (clash.length ? `\n\nThis will replace your current: ${clash.join(', ')}` : '');
    if (!confirm(msg)) return;
    for (const [name, text] of Object.entries(data.files)) {
      if (validName(name) && typeof text === 'string') addTextFile(name, text, { open: false, overwrite: true });
    }
    openFile(data.active && docs.has(data.active) ? data.active : names[0]);
    toast('Shared code loaded');
  } catch (err) {
    console.error(err);
    toast('Could not read the shared link');
  }
}

function createEditor() {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
  cm = CodeMirror($('#editor'), {
    value: '',
    mode: modeFor('main.py'),
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    lineWrapping: !!settings.wrap,
    keyMap: CodeMirror.keyMap.sublime ? 'sublime' : 'default',
    extraKeys: {
      [`${mod}-Enter`]: () => runFile(),
      'Shift-Enter': () => runSelection(),
      'Ctrl-Space': () => editorComplete(),
      [`${mod}-S`]: () => { saveProject().then(() => toast('Saved in this browser')); },
      [`${mod}-/`]: 'toggleComment',
      'Alt-G': 'jumpToLine',
      Tab: (ed) => {
        if (ed.somethingSelected()) ed.indentSelection('add');
        else ed.replaceSelection(' '.repeat(4 - (ed.getCursor().ch % 4)), 'end', '+input');
      },
      'Shift-Tab': (ed) => ed.indentSelection('subtract'),
      'Ctrl-L': false,
    },
  });
  window.cm = cm;
  cm.on('changes', (ed) => {
    const path = project.active;
    dirty.add(path);
    clearErrorMarks(path);
    scheduleSave();
  });
  cm.on('cursorActivity', updateCursorStatus);
  cm.on('inputRead', (ed, change) => {
    if (change.text.length === 1 && change.text[0] === '.' && py.ready && !ui.busy && /\.pyi?$/.test(project.active)) {
      setTimeout(() => editorComplete(), 0);
    }
  });
}

function updateCursorStatus() {
  if (!cm) return;
  const c = cm.getCursor();
  $('#st-cursor').textContent = `Ln ${c.line + 1}, Col ${c.ch + 1}`;
}

async function main() {
  applySettings();
  if (!(await ensureIsolation())) return;
  if (!window.CodeMirror) {
    document.body.innerHTML = '<p style="padding:24px">Could not load the code editor from cdnjs.cloudflare.com. Check your connection and reload.</p>';
    return;
  }
  term = new Terminal($('#output'), $('#panel-console'));
  createEditor();
  await loadProject();
  cm.swapDoc(docs.get(project.active));
  renderTabs();
  updateCursorStatus();
  await importSharedFromHash();
  wireUi();
  renderExamples();
  restoreSplit();

  const iso = $('#st-iso');
  if (window.crossOriginIsolated) {
    iso.textContent = 'input() & interrupt enabled';
    iso.title = 'Cross-origin isolated: input() blocks, Stop interrupts running code.';
  } else {
    iso.textContent = '⚠ limited mode';
    iso.classList.add('warn');
    iso.title = 'This page is not cross-origin isolated, so input() and Ctrl+C are unavailable. Open it over https (e.g. GitHub Pages) and reload.';
  }
  bootPython();
}

function bootPython() {
  setState('busy', 'Loading Python…');
  $('#run-btn').disabled = true;
  $('#prompt-row').hidden = true;
  term.system(`Loading Python (Pyodide ${PYODIDE_VERSION}, ~10 MB on first visit, then cached)…`);
  ui.bootStart = performance.now();
  py.start(allFiles());
}

function onReady(info) {
  const secs = ((performance.now() - ui.bootStart) / 1000).toFixed(1);
  term.write(`Python ${info.python} (Pyodide ${info.version}) on WebAssembly/Emscripten — ready in ${secs}s\n`, 'banner');
  term.write('Type Python below, or press Ctrl/⌘+Enter in the editor to run the current file.\n', 'banner');
  if (!info.isolated) {
    term.system('Note: input() and interrupting running code need cross-origin isolation, which is unavailable here.');
  }
  $('#st-version').textContent = `Python ${info.python} · Pyodide ${info.version}`;
  ui.continuation = false;
  setPrompt();
  setBusy(false);
  // Warm up the completion engine in the background.
  setTimeout(() => { if (py.ready && !ui.busy) py.call('complete', { source: 'im', line: 1, column: 2, mode: 'editor', path: 'main.py' }).catch(() => {}); }, 2500);
}

function onFatal(error) {
  setState('error', 'Python failed to load');
  term.write(`\nPython failed to start:\n${error}\n`, 'stderr');
  term.system('Check your internet connection (Pyodide is loaded from cdn.jsdelivr.net), then press Restart.');
  ui.busy = false;
  $('#stop-btn').disabled = true;
}

// ===========================================================================
// Running code
// ===========================================================================
function runTarget() {
  if (/\.py$/.test(project.active)) return project.active;
  return project.order.find((p) => p === 'main.py') || project.order.find((p) => p.endsWith('.py'));
}

async function runFile() {
  if (!py.ready || ui.busy) return;
  const path = runTarget();
  if (!path) { toast('No .py file to run'); return; }
  saveProject();
  if (settings.clearOnRun) term.clear();
  showPanel('console');
  clearErrorMarks();
  term.rule(`python ${path}`);
  setBusy(true);
  const t0 = performance.now();
  let status = 'ok';
  try {
    status = await py.call('run', { ...collectDirty(), main: path, autoInstall: settings.autoInstall });
  } catch (err) {
    status = 'error';
    if (py.worker) term.write(String(err.message || err) + '\n', 'stderr');
  }
  if (py.worker && py.ready) {
    const label = status === 'interrupted' ? 'Interrupted' : status === 'error' ? 'Exited with an error' : 'Finished';
    term.done(`${label} in ${fmtTime(performance.now() - t0)}`, status !== 'ok');
    setBusy(false);
    if (!$('#panel-files').hidden) refreshFiles();
  }
}

async function runSelection() {
  if (!py.ready || ui.busy) return;
  let code = cm.getSelection();
  if (!code.trim()) {
    const line = cm.getCursor().line;
    code = cm.getLine(line);
    if (line < cm.lastLine()) cm.setCursor({ line: line + 1, ch: 0 });
  }
  code = dedent(code).replace(/\s+$/, '');
  if (!code.trim()) return;
  await syncFiles();
  await replExecute(code, true);
}

function dedent(text) {
  const lines = text.split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join('\n');
}

async function syncFiles() {
  const payload = collectDirty();
  if (Object.keys(payload.files).length || payload.removed.length) await py.call('writeFiles', payload);
}

function stop() {
  if (!ui.busy) return;
  const btn = $('#stop-btn');
  if (btn.dataset.force === '1' || !py.canInterrupt) {
    if (!py.canInterrupt && !confirm('This browser session cannot interrupt Python, so it must be restarted (all variables are lost). Restart now?')) return;
    btn.dataset.force = '';
    restart('Python was stopped and restarted.');
    return;
  }
  if (py.waitingInput && stdinField) {
    const typed = stdinField.value;
    removeStdinField();
    term.endInputLine(typed + '^C');
  }
  py.interrupt();
  clearTimeout(ui.stopTimer);
  ui.stopTimer = setTimeout(() => {
    if (!ui.busy) return;
    btn.dataset.force = '1';
    btn.querySelector('span').textContent = 'Force stop';
    btn.title = 'Python is not responding to the interrupt; force-restart it';
  }, 2000);
}

function restart(message = 'Restarting Python…') {
  py.terminate();
  clearInterval(ui.timer);
  ui.busy = false;
  const btn = $('#stop-btn');
  btn.dataset.force = '';
  btn.title = 'Interrupt (Ctrl+C in the console)';
  removeStdinField();
  clearErrorMarks();
  term.rule(message);
  bootPython();
  $('#stop-btn').disabled = true;
  $('#stop-btn').classList.remove('running');
  $('#stop-btn').querySelector('span').textContent = 'Stop';
}

// ===========================================================================
// Error markers in the editor
// ===========================================================================
const errorMarks = []; // {path, handle}

function markError(path, line) {
  const doc = docs.get(path);
  if (!doc) return;
  const handle = doc.addLineClass(line - 1, 'background', 'cm-error-line');
  errorMarks.push({ path, doc, handle });
}

function clearErrorMarks(path) {
  for (let i = errorMarks.length - 1; i >= 0; i--) {
    const m = errorMarks[i];
    if (path && m.path !== path) continue;
    m.doc.removeLineClass(m.handle, 'background', 'cm-error-line');
    errorMarks.splice(i, 1);
  }
}

function jumpTo(path, line) {
  if (!docs.has(path)) return;
  openFile(path);
  cm.setCursor({ line: line - 1, ch: 0 });
  cm.scrollIntoView({ line: line - 1, ch: 0 }, 80);
  cm.focus();
}

// ===========================================================================
// Console (REPL) and stdin
// ===========================================================================
const replHistory = (() => {
  try { return JSON.parse(localStorage.getItem('pyide:replHistory') || '[]'); } catch { return []; }
})();
let histPos = replHistory.length;
let histDraft = '';

function pushHistory(text) {
  if (!text.trim()) return;
  if (replHistory[replHistory.length - 1] !== text) replHistory.push(text);
  while (replHistory.length > 500) replHistory.shift();
  try { localStorage.setItem('pyide:replHistory', JSON.stringify(replHistory)); } catch { /* ignore */ }
  histPos = replHistory.length;
}

function setPrompt() {
  $('#ps').textContent = ui.continuation ? '...' : '>>>';
}

function autosizeRepl() {
  const ta = $('#repl');
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

async function replExecute(text, asCell = false) {
  const prompt = ui.continuation ? '...' : '>>>';
  term.echo(prompt, text);
  pushHistory(text);
  setBusy(true, 'Running');
  let result = 'complete';
  try {
    if (asCell || (!ui.continuation && text.includes('\n'))) {
      result = await py.call('repl', { line: text, cell: true, autoInstall: settings.autoInstall });
    } else {
      const lines = text.split('\n');
      for (const line of lines) {
        result = await py.call('repl', { line: /^\s+$/.test(line) ? '' : line, autoInstall: settings.autoInstall });
      }
      if (result === 'incomplete' && lines.length > 1) {
        result = await py.call('repl', { line: '', autoInstall: settings.autoInstall });
      }
    }
  } catch (err) {
    if (py.worker) term.write(String(err.message || err) + '\n', 'stderr');
    result = 'error';
  }
  if (!py.worker || !py.ready) return;
  ui.continuation = result === 'incomplete';
  const lastLine = text.split('\n').pop();
  if (ui.continuation) {
    const indent = lastLine.match(/^\s*/)[0];
    ui.indent = /:\s*(#.*)?$/.test(lastLine) ? indent + '    ' : indent;
  } else {
    ui.indent = '';
  }
  setPrompt();
  setBusy(false);
  const ta = $('#repl');
  ta.value = ui.indent;
  autosizeRepl();
  focusRepl(true);
  if (!$('#panel-files').hidden) refreshFiles();
}

function commonPrefix(words) {
  if (!words.length) return '';
  let p = words[0];
  for (const w of words) while (!w.startsWith(p)) p = p.slice(0, -1);
  return p;
}

async function replComplete() {
  const ta = $('#repl');
  const before = ta.value.slice(0, ta.selectionStart);
  const lines = before.split('\n');
  try {
    const r = await withTimeout(py.call('complete', {
      source: ta.value, line: lines.length, column: lines[lines.length - 1].length, mode: 'console', path: '',
    }), 4000);
    const typed = before.slice(before.length - r.prefix);
    const all = r.items.map((i) => i[0]);
    const exact = all.filter((w) => w.startsWith(typed));
    const items = exact.length ? exact : all;
    if (!items.length) return;
    const common = items.length === 1 ? items[0] : commonPrefix(items);
    const insert = common.slice(r.prefix);
    if (insert) {
      ta.setRangeText(insert, ta.selectionStart, ta.selectionEnd, 'end');
      autosizeRepl();
    } else if (items.length > 1) {
      term.echo(ui.continuation ? '...' : '>>>', ta.value);
      term.write(items.slice(0, 120).join('  ') + (items.length > 120 ? `  … (${items.length} total)` : '') + '\n', 'completions');
    }
  } catch { /* busy or timed out */ }
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function showStdinField() {
  py.waitingInput = true;
  showPanel('console');
  removeStdinField();
  const line = term.currentLine();
  const input = document.createElement('input');
  input.className = 'stdin-field';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Program input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = input.value;
      removeStdinField();
      term.endInputLine(value);
      py.answerStdin(value);
    } else if ((e.key === 'c' || e.key === 'C') && e.ctrlKey && input.selectionStart === input.selectionEnd) {
      e.preventDefault();
      removeStdinField();
      term.endInputLine(input.value + '^C');
      py.interrupt();
    } else if ((e.key === 'd' || e.key === 'D') && e.ctrlKey && !input.value) {
      e.preventDefault();
      removeStdinField();
      term.endInputLine('');
      py.answerStdin(null, 3);
    }
  });
  line.appendChild(input);
  stdinField = input;
  term.scrollToEnd(true);
  input.focus({ preventScroll: true });
}

function removeStdinField() {
  if (stdinField) {
    stdinField.remove();
    stdinField = null;
  }
}

// ===========================================================================
// Editor completion (jedi in the worker)
// ===========================================================================
function editorComplete() {
  if (!py.ready || ui.busy) return;
  const hint = (ed, callback) => {
    const cur = ed.getCursor();
    withTimeout(py.call('complete', {
      source: ed.getValue(), line: cur.line + 1, column: cur.ch, mode: 'editor', path: project.active,
    }), 6000).then((r) => {
      if (!r.items.length) return callback(null);
      callback({
        list: r.items.map(([text, type]) => ({
          text,
          render(el) {
            el.textContent = text;
            if (type) {
              const t = document.createElement('span');
              t.className = 'ht';
              t.textContent = type;
              el.appendChild(t);
            }
          },
        })),
        from: CodeMirror.Pos(cur.line, cur.ch - r.prefix),
        to: cur,
      });
    }).catch(() => callback(null));
  };
  hint.async = true;
  cm.showHint({ hint, completeSingle: false });
}

// ===========================================================================
// Side panels
// ===========================================================================
function showPanel(name) {
  for (const tab of document.querySelectorAll('.ptab')) tab.classList.toggle('active', tab.dataset.panel === name);
  for (const p of ['console', 'files', 'packages']) $(`#panel-${p}`).hidden = p !== name;
  $('#clear-btn').hidden = name !== 'console';
  if (name === 'files') refreshFiles();
  if (name === 'packages') refreshPackages();
}

async function refreshFiles() {
  const list = $('#file-list');
  if (!py.ready) { list.innerHTML = '<li class="empty">Python is loading…</li>'; return; }
  let files;
  try {
    await syncFiles();
    files = await withTimeout(py.call('listFiles'), 5000);
  } catch {
    list.innerHTML = '<li class="empty">Busy — refresh when the program finishes.</li>';
    return;
  }
  list.textContent = '';
  if (!files.length) list.innerHTML = '<li class="empty">No files yet.</li>';
  for (const [path, size] of files) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = path;
    name.title = '/home/pyodide/' + path;
    const sz = document.createElement('span');
    sz.className = 'size';
    sz.textContent = fmtBytes(size);
    const acts = document.createElement('span');
    acts.className = 'acts';
    const saved = !!project.files[path];
    const btn = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      acts.appendChild(b);
    };
    if (docs.has(path)) btn('Edit', 'Show in editor', () => openFile(path));
    else if (TEXT_EXT.test(path) && size < 2 * 1024 * 1024) btn('Open', 'Open in the editor (and keep it)', () => openFromFs(path));
    btn('Download', 'Download to your computer', () => downloadFromFs(path));
    if (!saved) btn('Keep', 'Save this file in the browser so it survives restarts', () => keepFromFs(path));
    btn('Delete', 'Delete', async () => {
      if (!confirm(`Delete ${path}?`)) return;
      if (project.files[path]) deleteFile(path);
      try { await py.call('deleteFile', { path }); } catch { /* already gone */ }
      refreshFiles();
    });
    if (saved) {
      const s = document.createElement('span');
      s.className = 'saved';
      s.textContent = '●';
      s.title = 'Saved in this browser';
      li.append(s);
    }
    li.append(name, sz, acts);
    list.appendChild(li);
  }
}

async function readFromFs(path) {
  return await py.call('readFile', { path });
}

async function openFromFs(path) {
  const bytes = await readFromFs(path);
  const text = tryDecodeText(bytes);
  if (text === null) { toast('That file is not UTF-8 text'); return; }
  addTextFile(path, text, { overwrite: true });
  refreshFiles();
}

async function keepFromFs(path) {
  const bytes = await readFromFs(path);
  const text = TEXT_EXT.test(path) ? tryDecodeText(bytes) : null;
  if (text !== null) addTextFile(path, text, { open: false, overwrite: true });
  else addBinaryFile(path, bytes);
  dirty.delete(path);
  toast(`${path} will be kept in this browser`);
  refreshFiles();
}

async function downloadFromFs(path) {
  try {
    await syncFiles();
    const bytes = await readFromFs(path);
    downloadBlob(bytes, path.split('/').pop());
  } catch (err) {
    toast('Download failed: ' + err.message);
  }
}

async function uploadFiles(fileList) {
  let count = 0;
  for (const file of fileList) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = TEXT_EXT.test(file.name) || !/\.[a-z0-9]+$/i.test(file.name) ? tryDecodeText(bytes) : null;
    if (text !== null && bytes.length < 1024 * 1024) {
      addTextFile(file.name, text, { open: /\.pyi?$/i.test(file.name), overwrite: true });
    } else {
      addBinaryFile(file.name, bytes);
    }
    count++;
  }
  if (py.ready) {
    try { await syncFiles(); } catch { /* will sync on next run */ }
  }
  toast(`Added ${count} file${count === 1 ? '' : 's'}`);
  if (!$('#panel-files').hidden) refreshFiles();
}

let lockPackages = null;
async function refreshPackages() {
  const list = $('#pkg-list');
  if (py.ready) {
    try {
      const pkgs = await withTimeout(py.call('listPackages'), 5000);
      ui.installed = new Map(pkgs.map(([n, v]) => [n.toLowerCase(), v]));
      $('#pkg-count').textContent = `(${pkgs.length})`;
      renderPkgList(list, pkgs, $('#pkg-filter').value, false);
    } catch {
      list.innerHTML = '<li class="muted">Busy — try again when the program finishes.</li>';
    }
  }
  if (!lockPackages) {
    try {
      const lock = await (await fetch(INDEX_URL + 'pyodide-lock.json')).json();
      lockPackages = Object.values(lock.packages)
        .filter((p) => p.package_type === 'package' || !p.package_type)
        .map((p) => [p.name, p.version])
        .sort((a, b) => a[0].localeCompare(b[0]));
    } catch {
      lockPackages = [];
    }
  }
  $('#avail-count').textContent = `(${lockPackages.length})`;
  renderPkgList($('#avail-list'), lockPackages, $('#avail-filter').value, true);
}

function renderPkgList(list, pkgs, filter, installable) {
  list.textContent = '';
  const f = (filter || '').toLowerCase().trim();
  const shown = pkgs.filter(([n]) => !f || n.toLowerCase().includes(f)).slice(0, 400);
  for (const [name, version] of shown) {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    const v = document.createElement('span');
    v.className = 'ver';
    v.textContent = version;
    li.append(n, v);
    if (installable) {
      const installed = ui.installed && ui.installed.has(name.toLowerCase());
      const b = document.createElement('button');
      b.textContent = installed ? 'Installed' : 'Install';
      b.disabled = installed;
      b.addEventListener('click', () => installPackages([name]));
      li.appendChild(b);
    }
    list.appendChild(li);
  }
  if (!shown.length) list.innerHTML = '<li class="muted">No matches</li>';
}

async function installPackages(names) {
  if (!py.ready || ui.busy || !names.length) return;
  term.echo('$', `pip install ${names.join(' ')}`);
  setBusy(true, 'Installing');
  try {
    await py.call('install', { names });
  } catch (err) {
    term.write(String(err.message || err) + '\n', 'stderr');
  }
  if (py.ready) {
    setBusy(false);
    refreshPackages();
    toast(`pip install ${names.join(' ')} finished — see Console for details`);
  }
}

// ===========================================================================
// Sharing
// ===========================================================================
async function encodeShare(text) {
  const bytes = new TextEncoder().encode(text);
  let out;
  if (window.CompressionStream) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    out = new Uint8Array(await new Response(stream).arrayBuffer());
    out = new Uint8Array([1, ...out]);
  } else {
    out = new Uint8Array([0, ...bytes]);
  }
  return bytesToB64(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decodeShare(s) {
  const bytes = b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/'));
  const body = bytes.subarray(1);
  if (bytes[0] === 1) {
    const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  }
  return new TextDecoder().decode(body);
}

async function share() {
  snapshotFiles();
  const files = {};
  for (const p of project.order) files[p] = docs.get(p).getValue();
  const encoded = await encodeShare(JSON.stringify({ files, active: project.active }));
  const url = `${location.origin}${location.pathname}#code=${encoded}`;
  if (url.length > 100000) toast('Warning: this link is very long and may not work everywhere', 4000);
  try {
    await navigator.clipboard.writeText(url);
    toast('Share link copied to the clipboard');
  } catch {
    prompt('Copy this link:', url);
  }
}

// ===========================================================================
// Examples menu, splitter, wiring
// ===========================================================================
function renderExamples() {
  const menu = $('#examples-menu');
  for (const ex of EXAMPLES) {
    const b = document.createElement('button');
    b.className = 'item';
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `<span></span><small></small>`;
    b.firstChild.textContent = ex.title;
    b.lastChild.textContent = ex.desc;
    b.addEventListener('click', () => {
      closeMenus();
      if (project.files[ex.name] && docs.get(ex.name).getValue() === ex.code) openFile(ex.name);
      else addTextFile(ex.name, ex.code);
      toast(`Opened ${ex.name} — press Run`);
    });
    menu.appendChild(b);
  }
}

function closeMenus() {
  for (const m of document.querySelectorAll('.menu')) m.hidden = true;
  for (const b of document.querySelectorAll('[aria-haspopup]')) b.setAttribute('aria-expanded', 'false');
}

function toggleMenu(btn, menu) {
  const open = menu.hidden;
  closeMenus();
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}

const narrow = window.matchMedia('(max-width: 820px)');
function applySplit(frac) {
  frac = Math.min(0.85, Math.max(0.15, frac));
  const a = Math.round(frac * 1000), b = 1000 - a;
  const layout = $('#layout');
  if (narrow.matches) {
    layout.style.gridTemplateColumns = '';
    layout.style.gridTemplateRows = `minmax(0, ${a}fr) 6px minmax(0, ${b}fr)`;
  } else {
    layout.style.gridTemplateRows = '';
    layout.style.gridTemplateColumns = `minmax(0, ${a}fr) 6px minmax(0, ${b}fr)`;
  }
  cm?.refresh();
  return frac;
}

function restoreSplit() {
  const key = () => (narrow.matches ? 'pyide:split-v' : 'pyide:split-h');
  const load = () => {
    const v = parseFloat(localStorage.getItem(key()) || '');
    if (v) applySplit(v);
    else { $('#layout').style.gridTemplateColumns = ''; $('#layout').style.gridTemplateRows = ''; cm?.refresh(); }
  };
  load();
  narrow.addEventListener('change', load);
  const splitter = $('#splitter');
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    const rect = $('#layout').getBoundingClientRect();
    let frac = 0.5;
    const move = (ev) => {
      frac = narrow.matches ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
      frac = applySplit(frac);
    };
    const up = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      try { localStorage.setItem(key(), String(frac)); } catch { /* ignore */ }
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
  splitter.addEventListener('keydown', (e) => {
    const cur = parseFloat(localStorage.getItem(key()) || '0.55');
    const delta = { ArrowLeft: -0.03, ArrowUp: -0.03, ArrowRight: 0.03, ArrowDown: 0.03 }[e.key];
    if (!delta) return;
    e.preventDefault();
    const f = applySplit(cur + delta);
    try { localStorage.setItem(key(), String(f)); } catch { /* ignore */ }
  });
}

function wireUi() {
  $('#run-btn').addEventListener('click', runFile);
  $('#stop-btn').addEventListener('click', stop);
  $('#restart-btn').addEventListener('click', () => restart());
  $('#share-btn').addEventListener('click', share);
  $('#new-file-btn').addEventListener('click', newFile);
  $('#download-file-btn').addEventListener('click', () => {
    const path = project.active;
    downloadBlob(docs.get(path).getValue(), path.split('/').pop(), 'text/plain;charset=utf-8');
  });
  $('#clear-btn').addEventListener('click', () => { term.clear(); focusRepl(); });
  $('#examples-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(e.currentTarget, $('#examples-menu')); });
  $('#settings-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(e.currentTarget, $('#settings-menu')); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

  for (const tab of document.querySelectorAll('.ptab')) tab.addEventListener('click', () => showPanel(tab.dataset.panel));

  // Settings
  const theme = $('#set-theme'), font = $('#set-font');
  theme.value = settings.theme;
  font.value = String(settings.fontSize);
  $('#set-autoinstall').checked = settings.autoInstall;
  $('#set-clear').checked = settings.clearOnRun;
  $('#set-wrap').checked = settings.wrap;
  theme.addEventListener('change', () => { settings.theme = theme.value; saveSettings(); applySettings(); });
  font.addEventListener('change', () => { settings.fontSize = +font.value; saveSettings(); applySettings(); });
  $('#set-autoinstall').addEventListener('change', (e) => { settings.autoInstall = e.target.checked; saveSettings(); });
  $('#set-clear').addEventListener('change', (e) => { settings.clearOnRun = e.target.checked; saveSettings(); });
  $('#set-wrap').addEventListener('change', (e) => { settings.wrap = e.target.checked; saveSettings(); applySettings(); });
  $('#shortcuts-btn').addEventListener('click', () => { closeMenus(); $('#shortcuts-dialog').showModal(); });
  $('#reset-project').addEventListener('click', async () => {
    if (!confirm('Delete all files in this project and start over? This cannot be undone.')) return;
    await store.set('project', null);
    location.reload();
  });

  // Console input
  const ta = $('#repl');
  ta.addEventListener('input', autosizeRepl);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      return; // handled globally: run the current file
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (ui.busy || !py.ready) return;
      const text = ta.value;
      ta.value = '';
      autosizeRepl();
      replExecute(text);
    } else if (e.key === 'ArrowUp' && !ta.value.slice(0, ta.selectionStart).includes('\n')) {
      if (histPos === 0) return;
      e.preventDefault();
      if (histPos === replHistory.length) histDraft = ta.value;
      ta.value = replHistory[--histPos];
      autosizeRepl();
    } else if (e.key === 'ArrowDown' && !ta.value.slice(ta.selectionEnd).includes('\n')) {
      if (histPos >= replHistory.length) return;
      e.preventDefault();
      ta.value = ++histPos === replHistory.length ? histDraft : replHistory[histPos];
      autosizeRepl();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const before = ta.value.slice(0, ta.selectionStart);
      const lineBefore = before.split('\n').pop();
      if (!lineBefore.trim()) ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
      else replComplete();
    } else if ((e.key === 'c' || e.key === 'C') && e.ctrlKey && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault();
      term.echo(ui.continuation ? '...' : '>>>', ta.value + '^C');
      term.write('KeyboardInterrupt\n', 'stderr');
      ta.value = '';
      ui.continuation = false;
      setPrompt();
      if (py.ready) py.call('replReset').catch(() => {});
    } else if ((e.key === 'l' || e.key === 'L') && e.ctrlKey) {
      e.preventDefault();
      term.clear();
    }
  });
  ta.addEventListener('paste', () => setTimeout(autosizeRepl, 0));

  // Global shortcuts
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter' && !e.target.closest('.CodeMirror')) { e.preventDefault(); runFile(); }
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && ui.busy && !window.getSelection().toString() && !e.target.matches('input, textarea')) {
      e.preventDefault();
      stop();
    }
    if (mod && (e.key === 's' || e.key === 'S') && !e.target.closest('.CodeMirror')) {
      e.preventDefault();
      saveProject().then(() => toast('Saved in this browser'));
    }
  });

  // Clicking the console focuses the input (unless selecting text); clicking a
  // traceback line jumps to it in the editor.
  $('#panel-console').addEventListener('click', (e) => {
    if (window.getSelection().toString()) return;
    const ln = e.target.closest('.ln');
    if (ln) {
      const m = ln.textContent.match(/File "\/home\/pyodide\/([^"]+)", line (\d+)/);
      if (m && docs.has(m[1])) { jumpTo(m[1], +m[2]); return; }
    }
    if (e.target.closest('iframe, img, a')) return;
    if (stdinField) stdinField.focus();
    else focusRepl(true);
  });

  // Files panel
  $('#upload-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
  $('#refresh-files').addEventListener('click', refreshFiles);
  $('#zip-btn').addEventListener('click', async () => {
    if (!py.ready) return;
    try {
      await syncFiles();
      downloadBlob(await py.call('zip'), 'python-project.zip', 'application/zip');
    } catch (err) { toast('Could not create zip: ' + err.message); }
  });
  if (window.showDirectoryPicker) {
    const mb = $('#mount-btn');
    mb.hidden = false;
    mb.addEventListener('click', async () => {
      if (!py.ready) return;
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        const point = await py.call('mount', { handle });
        term.system(`Mounted your folder "${handle.name}" at ${point} — changes made by Python are written back after each run.`);
        toast(`Mounted at ${point}`);
      } catch (err) {
        if (err.name !== 'AbortError') toast('Mount failed: ' + err.message);
      }
    });
  }

  // Packages panel
  $('#pip-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const names = $('#pip-input').value.split(/[\s,]+/).filter(Boolean);
    $('#pip-input').value = '';
    installPackages(names);
  });
  $('#pkg-filter').addEventListener('input', refreshPackages);
  $('#avail-filter').addEventListener('input', () => renderPkgList($('#avail-list'), lockPackages || [], $('#avail-filter').value, true));

  // Drag and drop files anywhere
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth++;
    document.body.classList.add('drop-target');
  });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drop-target'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drop-target');
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  });

  // Save on leave
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveProject(); });
  window.addEventListener('pagehide', () => saveProject());
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;bottom:30px;left:16px;right:16px;color:#c62828;background:#fff;padding:12px;border-radius:8px;z-index:999;white-space:pre-wrap">Startup error: ${String(err && err.stack || err).replace(/</g, '&lt;')}</pre>`);
});
