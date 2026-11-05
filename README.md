# Browser Python

A Python IDE where the real CPython 3.13 interpreter runs **entirely inside your browser tab**. Nothing is installed on your computer and no server runs your code. Python is compiled to WebAssembly via [Pyodide](https://pyodide.org).

## Use it

Open the published page (see *Hosting* below), e.g. `https://<user>.github.io/friendly-spoon/`. The first visit downloads about 10 MB; after that it is cached.

## Features

- **Full CPython 3.13 standard library**: `sqlite3`, `json`, `csv`, `re`, `datetime`, `asyncio`, `dataclasses`, `decimal` and more.
- **Editor**: syntax highlighting, autocompletion (jedi, Ctrl+Space, or automatic after `.`), bracket matching, find/replace, multi-cursor, and comment toggling.
- **Multiple files**: create, rename and delete tabs. Files can `import` each other, and edits are picked up on each run.
- **Interactive console** (`>>>`):
  - continuation lines, history (↑/↓) and tab completion
  - top-level `await`
  - it shares the namespace of the last run (like `python -i`)
  - Shift+Enter in the editor sends the selection or current line to the console
- **`input()` works**: the program pauses and an input field appears inline in the console.
- **Stop / Ctrl+C** raises `KeyboardInterrupt` in running code, including infinite loops, `time.sleep` and `input()`. If Python doesn't respond, Force stop restarts it.
- **Rich output**:
  - matplotlib plots render inline
  - pandas DataFrames render as HTML tables
  - `display()` works on any object with `_repr_html_`, `_repr_png_` or `_repr_svg_` (`from ide import HTML, SVG, Image`)
  - ANSI colours and `\r` progress bars work (e.g. `rich`)
- **Packages**:
  - imports are installed automatically: Pyodide ships numpy, pandas, scipy, scikit-learn, matplotlib, sympy and 300+ others, and anything pure-Python comes from PyPI via micropip
  - you can also type `pip install x` in the console or use the Packages tab
- **Files**:
  - browse the virtual filesystem; upload (or drag and drop) data files
  - download files your program creates, or the whole project as a .zip
  - in Chrome or Edge, mount a real folder from your computer
- **Saved automatically** in your browser (IndexedDB). **Share** copies a link with your code compressed into the URL.
- Light and dark themes; works on tablets and phones.

## Hosting (no install needed)

The IDE is just static files, so any static web host works. With **GitHub Pages**:

1. On GitHub, open the repository → **Settings** → **Pages**.
2. Under *Build and deployment*, choose **Deploy from a branch**. Pick the branch with these files and the `/ (root)` folder, then **Save**.
3. After a minute the site is live at `https://<user>.github.io/<repo>/`.

Pages on a private repository needs a paid GitHub plan; on a public repository it is free.

Blocking `input()` and interrupting code rely on `SharedArrayBuffer`, which browsers enable only for *cross-origin isolated* pages. GitHub Pages cannot set the required headers, so the small service worker in `coi-sw.js` adds them; the page reloads itself once on the first visit to switch this on. If isolation is unavailable (for example when opening `index.html` straight from disk), the status bar shows "limited mode". Everything else still works, but `input()` raises an error and Stop has to restart Python.

### Self-hosting Pyodide

By default Pyodide loads from the jsDelivr CDN. To use another copy, add `?pyodide=<url-of-pyodide-folder>/` to the page URL.

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html`, `css/style.css` | Page layout and theme |
| `js/app.js` | Editor, console, panels, persistence and sharing |
| `js/terminal.js` | Console renderer (ANSI colours, `\r`, images, HTML) |
| `js/worker.js` | Web Worker hosting Pyodide, plus stdin/interrupt plumbing |
| `py/ide.py` | Python-side runtime: run/REPL, display, input, pip, completion |
| `py/ide_mpl.py` | Matplotlib backend that renders figures inline |
| `coi-sw.js` | Service worker that enables cross-origin isolation |
| `js/examples.js` | Example programs |

## Limitations

These come from running Python in a browser sandbox:

- No `subprocess` or `threading`-based parallelism, and `multiprocessing` doesn't work.
- No raw sockets. Use `pyodide.http.pyfetch`, or `requests` for CORS-enabled URLs.
- `tkinter` and `turtle` are unavailable; use matplotlib or `display(SVG(...))` instead.
- Packages with C extensions work only if Pyodide has built them.
