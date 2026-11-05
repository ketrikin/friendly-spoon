// Web Worker that hosts the Pyodide (CPython → WebAssembly) interpreter.
// Running Python off the main thread keeps the UI responsive, and lets us
// block for input() / time.sleep() using SharedArrayBuffer + Atomics.

let pyodide = null;
let ide = null; // the `ide` Python module (py/ide.py)
let interrupt = null; // Uint8Array(1) shared with the page: 2 = SIGINT
let stdinCtrl = null; // Int32Array [state, length]; state 0 wait,1 data,2 cancel,3 EOF
let stdinData = null; // Uint8Array payload
let sleepCell = null; // private Int32Array used only for Atomics.wait timeouts
let initPromise = null;
const mounts = new Map(); // mount point -> NativeFS handle (File System Access API)

const HOME = '/home/pyodide';
const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const status = (text) => post({ type: 'status', text: String(text) });

function makeWriter(stream) {
  const decoder = new TextDecoder();
  return {
    isatty: true,
    write(buf) {
      const text = decoder.decode(buf, { stream: true });
      if (text) post({ type: stream, text });
      return buf.length;
    },
  };
}

// Block until the page sends a line of input. Returns a string, or a number:
// 1 = interrupted (Ctrl+C), 2 = unsupported (no SharedArrayBuffer), 3 = EOF.
function readLine(consumeInterrupt) {
  if (!stdinCtrl) return 2;
  Atomics.store(stdinCtrl, 0, 0);
  post({ type: 'stdin-request' });
  while (Atomics.load(stdinCtrl, 0) === 0) Atomics.wait(stdinCtrl, 0, 0, 1000);
  const state = Atomics.load(stdinCtrl, 0);
  if (state === 1) {
    const len = stdinCtrl[1];
    return new TextDecoder().decode(stdinData.slice(0, len));
  }
  if (state === 2) {
    if (consumeInterrupt && interrupt) interrupt[0] = 0;
    return 1;
  }
  return 3;
}

// Interruptible sleep: returns 1 if interrupted, 0 otherwise.
function sleep(seconds) {
  const end = performance.now() + seconds * 1000;
  for (;;) {
    const remaining = end - performance.now();
    if (remaining <= 0) return 0;
    if (interrupt && interrupt[0]) {
      interrupt[0] = 0;
      return 1;
    }
    const slice = Math.min(remaining, 50);
    if (sleepCell) Atomics.wait(sleepCell, 0, 0, slice);
    else {
      const until = performance.now() + slice;
      while (performance.now() < until) { /* busy wait (no SharedArrayBuffer) */ }
    }
  }
}

async function init({ indexURL, shared, files }) {
  const { loadPyodide } = await import(indexURL + 'pyodide.mjs');
  pyodide = await loadPyodide({
    indexURL,
    env: { HOME, MPLBACKEND: 'module://ide_mpl' },
    stdout: (t) => post({ type: 'stdout', text: t + '\n' }),
    stderr: (t) => post({ type: 'stderr', text: t + '\n' }),
  });
  pyodide.setStdout(makeWriter('stdout'));
  pyodide.setStderr(makeWriter('stderr'));

  if (shared) {
    interrupt = new Uint8Array(shared.interrupt);
    pyodide.setInterruptBuffer(interrupt);
    stdinCtrl = new Int32Array(shared.stdin, 0, 2);
    stdinData = new Uint8Array(shared.stdin, 8);
    sleepCell = new Int32Array(new SharedArrayBuffer(4));
  }
  pyodide.setStdin({
    stdin: () => {
      const r = readLine(false);
      return typeof r === 'string' ? r + '\n' : null;
    },
  });

  pyodide.registerJsModule('_ide_js', {
    display: (mime, data, meta) => post({ type: 'display', mime, data, meta: JSON.parse(meta) }),
    read_line: () => readLine(true),
    sleep,
    status,
    // Load packages that ship with Pyodide (numpy, pandas, ...) for imports in `src`.
    load_imports: (src) =>
      pyodide.loadPackagesFromImports(src, { messageCallback: status, errorCallback: status }),
    error_location: (path, line) => post({ type: 'error-location', path, line }),
  });

  // Install the runtime modules.
  pyodide.FS.mkdirTree('/ide');
  for (const name of ['ide.py', 'ide_mpl.py']) {
    const res = await fetch(new URL('../py/' + name, import.meta.url));
    if (!res.ok) throw new Error(`Failed to fetch ${name}: ${res.status}`);
    pyodide.FS.writeFile('/ide/' + name, await res.text());
  }
  pyodide.runPython("import sys; sys.path.insert(0, '/ide')");
  ide = pyodide.pyimport('ide');
  ide.setup();
  if (files) syncFiles(files, []);

  const python = pyodide.runPython('import sys; sys.version.split()[0]');
  post({ type: 'ready', version: pyodide.version, python, isolated: !!shared });
}

function fullPath(path) {
  return path.startsWith('/') ? path : `${HOME}/${path}`;
}

function syncFiles(files, removed) {
  const FS = pyodide.FS;
  for (const [path, file] of Object.entries(files)) {
    const full = fullPath(path);
    FS.mkdirTree(full.slice(0, full.lastIndexOf('/')) || '/');
    if (file.b64 !== undefined) {
      const bin = atob(file.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      FS.writeFile(full, bytes);
    } else {
      FS.writeFile(full, file.text);
    }
  }
  for (const path of removed || []) {
    try { FS.unlink(fullPath(path)); } catch { /* already gone */ }
  }
}

async function syncMounts() {
  for (const m of mounts.values()) {
    try { await m.syncfs(); } catch (e) { status(`Could not sync mounted folder: ${e.message}`); }
  }
}

const handlers = {
  async run({ files, removed, main, autoInstall }) {
    syncFiles(files, removed);
    ide.auto_install = autoInstall;
    const sources = Object.entries(files)
      .filter(([p, f]) => p.endsWith('.py') && f.text !== undefined)
      .map(([, f]) => f.text);
    const mainSrc = pyodide.FS.readFile(fullPath(main), { encoding: 'utf8' });
    if (!sources.includes(mainSrc)) sources.push(mainSrc);
    await ide.ensure_installed(sources);
    const result = await ide.run_file(main);
    await syncMounts();
    return result;
  },
  async repl({ line, cell, autoInstall }) {
    ide.auto_install = autoInstall;
    const result = await (cell ? ide.repl_cell(line) : ide.repl_push(line));
    await syncMounts();
    return result;
  },
  replReset() { ide.repl_reset(); },
  async complete({ source, line, column, mode, path }) {
    if (!pyodide.loadedPackages.jedi) {
      try { await pyodide.loadPackage('jedi', { messageCallback: () => {} }); } catch { /* offline */ }
    }
    return JSON.parse(ide.complete(source, line, column, mode, path));
  },
  async install({ names }) {
    await ide.pip('install ' + names.join(' '));
  },
  listPackages() { return JSON.parse(ide.list_packages()); },
  listFiles({ root }) { return JSON.parse(ide.list_files(root || HOME)); },
  readFile({ path }) {
    const data = pyodide.FS.readFile(fullPath(path));
    return data;
  },
  writeFiles({ files, removed }) { syncFiles(files, removed); },
  deleteFile({ path }) { pyodide.FS.unlink(fullPath(path)); },
  zip() {
    const target = ide.zip_dir();
    return pyodide.FS.readFile(target);
  },
  async mount({ handle }) {
    const point = `/mnt/${handle.name}`;
    if (mounts.has(point)) return point;
    pyodide.FS.mkdirTree(point);
    const m = await pyodide.mountNativeFS(point, handle);
    mounts.set(point, m);
    return point;
  },
};

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    initPromise = init(msg).catch((err) => {
      post({ type: 'fatal', error: String(err && err.stack ? err.stack : err) });
      throw err;
    });
    return;
  }
  try {
    await initPromise;
    const handler = handlers[msg.type];
    if (!handler) throw new Error('Unknown request ' + msg.type);
    const result = await handler(msg);
    const transfer = result instanceof Uint8Array ? [result.buffer] : [];
    post({ type: 'reply', id: msg.id, result }, transfer);
  } catch (err) {
    post({ type: 'reply', id: msg.id, error: String(err && err.message ? err.message : err) });
  }
};
