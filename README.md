# Browser Python

A Python IDE where the real CPython 3.13 interpreter runs **entirely inside your browser tab**. Nothing is installed on your computer and no server runs your code. Python is compiled to WebAssembly via [Pyodide](https://pyodide.org).

## Use it

Everything is in **one file, `index.html`** (about 130 KB). Use it in any of these ways:

- **Open it directly**: download `index.html` and double-click it. No server is needed.
- **Host it** anywhere static files can live, such as GitHub Pages (see *Hosting* below).
- Optionally, put `coi-sw.js` next to it on the web host. This enables full Ctrl+C support (see below).

The page fetches Python itself (Pyodide, about 10 MB, cached after the first visit) and the code editor from public CDNs, so it needs an internet connection.

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
- **Stop / Ctrl+C** raises `KeyboardInterrupt` in running code, including `time.sleep`, `input()` and async code. Infinite loops can be interrupted too when hosted with `coi-sw.js` (see below); otherwise Force stop restarts Python.
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

### `input()` and the Stop button

Python runs in a background Web Worker, so pausing it for `input()` takes some help from the browser. There are two mechanisms:

| Setup | `input()` | Stop / Ctrl+C |
| --- | --- | --- |
| Hosted with `coi-sw.js` alongside (cross-origin isolated) | ✓ | ✓ everywhere, including busy loops |
| `index.html` alone: local file or any host (uses WebAssembly JSPI, available in current Chrome/Edge) | ✓ | ✓ during `input()`, `time.sleep()` and `await`; busy loops need **Force stop**, which restarts Python |

The status bar shows which mode is active. `coi-sw.js` is a tiny service worker that adds the COOP/COEP headers static hosts can't send; the page reloads itself once on the first visit to switch it on.

### Self-hosting Pyodide

By default Pyodide loads from the jsDelivr CDN. To use another copy, add `?pyodide=<url-of-pyodide-folder>/` to the page URL.

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html` | The whole IDE: styles, UI code, console renderer, and embedded `<script type="text/plain">` blocks holding the Web Worker (`#worker-src`) and the Python runtime (`#py-ide`, `#py-ide-mpl`) |
| `coi-sw.js` | Optional service worker that enables cross-origin isolation when hosted |

## Limitations

These come from running Python in a browser sandbox:

- No `subprocess` or `threading`-based parallelism, and `multiprocessing` doesn't work.
- No raw sockets. Use `pyodide.http.pyfetch`, or `requests` for CORS-enabled URLs.
- `tkinter` and `turtle` are unavailable; use matplotlib or `display(SVG(...))` instead.
- Packages with C extensions work only if Pyodide has built them.
