// Console output renderer: a small terminal emulator that understands ANSI
// SGR colours, carriage returns (progress bars), and rich outputs (images,
// sandboxed HTML). Writes are batched per animation frame for speed.

const ANSI_16 = [
  '#000000', '#cd3131', '#0dbc79', '#c4a000', '#2472c8', '#bc3fbc', '#11a8cd', '#a0a0a0',
  '#666666', '#f14c4c', '#23d18b', '#e5c400', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5',
];

function ansi256(n) {
  if (n < 16) return ANSI_16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  n -= 16;
  const c = (x) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
}

const MAX_LINES = 5000;
const SEQ = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\r\n|\n|\r|\x08|\t/g;

export class Terminal {
  constructor(output, scroller) {
    this.output = output;
    this.scroller = scroller;
    this.queue = [];
    this.scheduled = false;
    this.line = null; // current line element
    this.crPending = false;
    this.style = {}; // current SGR state
    this.partial = ''; // incomplete escape sequence carried between writes
    this.lineCount = 0;
    this.trimmedNotice = null;
  }

  // ---- public API -------------------------------------------------------
  write(text, cls = 'stdout') { this.push({ kind: 'text', text, cls }); }
  system(text) { this.push({ kind: 'block', cls: 'sys', text }); }
  rule(text) { this.push({ kind: 'block', cls: 'rule', text }); }
  done(text, fail) { this.push({ kind: 'block', cls: fail ? 'done fail' : 'done', text }); }
  echo(prompt, text) { this.push({ kind: 'echo', prompt, text }); }
  rich(mime, data, meta) { this.push({ kind: 'rich', mime, data, meta: meta || {} }); }
  clear() {
    this.queue = [];
    this.output.textContent = '';
    this.line = null;
    this.lineCount = 0;
    this.crPending = false;
    this.style = {};
    this.partial = '';
    this.trimmedNotice = null;
  }

  // Ensure everything queued has been rendered (e.g. before inserting a field).
  flush() {
    if (this.queue.length) this.render();
  }

  // Return the current (last) line, creating it if needed; used to place
  // the inline input() field right after the prompt text.
  currentLine() {
    this.flush();
    if (!this.line) this.newLine();
    return this.line;
  }

  // Called after an inline input is answered: the echoed text ends the line.
  endInputLine(text) {
    this.flush();
    if (!this.line) this.newLine();
    const span = document.createElement('span');
    span.className = 'stdin';
    span.textContent = text;
    this.line.appendChild(span);
    this.line = null;
    this.crPending = false;
    this.scrollToEnd(true);
  }

  isNearBottom() {
    const s = this.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 60;
  }

  scrollToEnd(force) {
    if (force || this.stick) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  // ---- internals --------------------------------------------------------
  push(item) {
    this.queue.push(item);
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.render());
    }
  }

  render() {
    this.scheduled = false;
    if (!this.queue.length) return;
    this.stick = this.isNearBottom();
    const items = this.queue;
    this.queue = [];
    for (const item of items) {
      if (item.kind === 'text') this.renderText(item.text, item.cls);
      else if (item.kind === 'block') this.renderBlock(item);
      else if (item.kind === 'echo') this.renderEcho(item);
      else if (item.kind === 'rich') this.renderRich(item);
    }
    this.trim();
    this.scrollToEnd();
  }

  newLine() {
    const div = document.createElement('div');
    div.className = 'ln';
    this.output.appendChild(div);
    this.line = div;
    this.lineCount++;
    return div;
  }

  breakLine() {
    this.line = null;
    this.crPending = false;
  }

  appendSpan(text, cls) {
    if (!text) return;
    if (!this.line) this.newLine();
    if (this.crPending) {
      // Carriage return: overwrite the current line (good enough for progress bars).
      this.line.textContent = '';
      this.crPending = false;
    }
    const st = this.style;
    const styled = st.fg || st.bg || st.bold || st.dim || st.italic || st.underline || st.inverse || st.strike;
    const last = this.line.lastChild;
    if (!styled && last && last.nodeType === 1 && last.dataset.plain === cls) {
      last.textContent += text;
      return;
    }
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    if (styled) {
      let fg = st.fg, bg = st.bg;
      if (st.inverse) [fg, bg] = [bg || 'var(--console-bg)', fg || 'var(--text)'];
      if (fg) span.style.color = fg;
      if (bg) span.style.background = bg;
      if (st.bold) span.style.fontWeight = '700';
      if (st.dim) span.style.opacity = '.65';
      if (st.italic) span.style.fontStyle = 'italic';
      if (st.underline || st.strike) span.style.textDecoration = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
    } else {
      span.dataset.plain = cls;
    }
    this.line.appendChild(span);
  }

  sgr(params) {
    const p = params === '' ? [0] : params.split(';').map((x) => parseInt(x || '0', 10));
    let st = this.style;
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if (n === 0) st = this.style = {};
      else if (n === 1) st.bold = true;
      else if (n === 2) st.dim = true;
      else if (n === 3) st.italic = true;
      else if (n === 4) st.underline = true;
      else if (n === 7) st.inverse = true;
      else if (n === 9) st.strike = true;
      else if (n === 22) st.bold = st.dim = false;
      else if (n === 23) st.italic = false;
      else if (n === 24) st.underline = false;
      else if (n === 27) st.inverse = false;
      else if (n === 29) st.strike = false;
      else if (n >= 30 && n <= 37) st.fg = ANSI_16[n - 30];
      else if (n >= 90 && n <= 97) st.fg = ANSI_16[n - 90 + 8];
      else if (n >= 40 && n <= 47) st.bg = ANSI_16[n - 40];
      else if (n >= 100 && n <= 107) st.bg = ANSI_16[n - 100 + 8];
      else if (n === 39) st.fg = null;
      else if (n === 49) st.bg = null;
      else if (n === 38 || n === 48) {
        let color = null;
        if (p[i + 1] === 5) { color = ansi256(p[i + 2] || 0); i += 2; }
        else if (p[i + 1] === 2) { color = `rgb(${p[i + 2] || 0},${p[i + 3] || 0},${p[i + 4] || 0})`; i += 4; }
        if (n === 38) st.fg = color; else st.bg = color;
      }
    }
  }

  renderText(text, cls) {
    // Start tracebacks on a fresh line (e.g. after a progress bar or input prompt).
    if (cls === 'stderr' && text.startsWith('Traceback') && this.line && this.line.textContent) this.breakLine();
    text = this.partial + text;
    this.partial = '';
    const tail = text.match(/\x1b(\[[0-9;?]*|\][^\x07]*|[()])?$/);
    if (tail) {
      this.partial = tail[0];
      text = text.slice(0, tail.index);
    }
    SEQ.lastIndex = 0;
    let last = 0, m;
    while ((m = SEQ.exec(text))) {
      if (m.index > last) this.appendSpan(text.slice(last, m.index), cls);
      last = SEQ.lastIndex;
      const tok = m[0];
      if (tok === '\n' || tok === '\r\n') {
        if (!this.line) this.newLine();
        else if (this.crPending) this.crPending = false;
        this.line = null;
      } else if (tok === '\r') {
        this.crPending = true;
      } else if (tok === '\t') {
        this.appendSpan('    '.slice(0, 4 - ((this.line?.textContent.length || 0) % 4)), cls);
      } else if (tok === '\x08') {
        if (this.line && this.line.lastChild) {
          const t = this.line.lastChild;
          t.textContent = t.textContent.slice(0, -1);
        }
      } else if (m[2] === 'm') {
        this.sgr(m[1]);
      } else if (m[2] === 'K') {
        // Erase in line: if a CR is pending this clears the line.
        if (this.crPending && this.line) { this.line.textContent = ''; this.crPending = false; }
      } else if (m[2] === 'J' && (m[1] === '2' || m[1] === '3')) {
        this.clear();
      }
      // Other control sequences (cursor movement etc.) are ignored.
    }
    if (last < text.length) this.appendSpan(text.slice(last), cls);
  }

  renderBlock(item) {
    this.breakLine();
    const div = document.createElement('div');
    div.className = item.cls;
    div.textContent = item.text;
    this.output.appendChild(div);
    this.lineCount++;
  }

  renderEcho({ prompt, text }) {
    this.breakLine();
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      const div = document.createElement('div');
      div.className = 'ln echo';
      const p = document.createElement('span');
      p.className = 'p';
      p.textContent = (i === 0 ? prompt : '...') + ' ';
      div.append(p, document.createTextNode(l));
      this.output.appendChild(div);
      this.lineCount++;
    });
  }

  renderRich({ mime, data, meta }) {
    this.breakLine();
    let el;
    if (mime === 'image/png' || mime === 'image/jpeg') {
      el = document.createElement('img');
      el.src = `data:${mime};base64,${data}`;
      if (meta.width) el.style.width = `min(${meta.width}px, 100%)`;
      el.alt = 'Image output';
    } else if (mime === 'image/svg+xml') {
      el = document.createElement('img');
      el.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data);
      el.alt = 'SVG output';
      el.style.background = 'transparent';
    } else if (mime === 'text/html') {
      // Sandboxed (no scripts) but same-origin so we can size it to its content.
      el = document.createElement('iframe');
      el.setAttribute('sandbox', 'allow-same-origin');
      el.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{margin:8px;font:13px/1.4 system-ui,sans-serif;color:#1d2330;background:#fff}
        table{border-collapse:collapse;font-size:12.5px}
        th,td{border:1px solid #dde1e7;padding:3px 8px;text-align:right}
        thead th{background:#f0f2f5} tbody tr:nth-child(even){background:#f8f9fb}
        img,svg{max-width:100%}
      </style></head><body>${data}</body></html>`;
      el.style.height = '40px';
      const fit = () => {
        try {
          const doc = el.contentDocument;
          if (doc && doc.documentElement) el.style.height = Math.min(doc.documentElement.scrollHeight + 2, 600) + 'px';
        } catch { /* ignore */ }
      };
      el.addEventListener('load', () => { fit(); setTimeout(fit, 150); this.scrollToEnd(this.stick); });
    } else {
      el = document.createElement('div');
      el.textContent = String(data);
    }
    el.classList.add('rich');
    this.output.appendChild(el);
    this.lineCount += 10;
  }

  trim() {
    if (this.lineCount <= MAX_LINES) return;
    let excess = this.lineCount - MAX_LINES + 500;
    let node = this.output.firstChild;
    if (node === this.trimmedNotice) node = node.nextSibling;
    while (node && excess > 0 && node !== this.line) {
      const next = node.nextSibling;
      excess -= node.classList && node.classList.contains('rich') ? 10 : 1;
      this.lineCount -= node.classList && node.classList.contains('rich') ? 10 : 1;
      node.remove();
      node = next;
    }
    if (!this.trimmedNotice) {
      this.trimmedNotice = document.createElement('div');
      this.trimmedNotice.className = 'trimmed';
      this.trimmedNotice.textContent = '… earlier output trimmed …';
    }
    this.output.prepend(this.trimmedNotice);
  }
}
