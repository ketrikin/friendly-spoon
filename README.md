# Browser Python

A Python IDE where the real CPython 3.13 interpreter runs **entirely inside your browser tab**. Nothing is installed on your computer and no server runs your code. Python is compiled to WebAssembly via [Pyodide](https://pyodide.org).

## Use it

Everything is in **one file, `index.html`** (about 130 KB). Use it in any of these ways:

- **Open it directly**: download `index.html` and double-click it. No server is needed.
- **Host it** anywhere static files can live, such as GitHub Pages (see *Hosting* below).
- Optionally, put `coi-sw.js` next to it on the web host. This enables full Ctrl+C support (see below).

The page fetches Python itself (Pyodide, about 10 MB, cached after the first visit) and the code editor from public CDNs, so it needs an internet connection.

## Features

Everything is listed in the **command palette** (Ctrl/⌘+Shift+P or F1), and **Settings → Shortcuts** lists the keys.

**Running code**
- Full CPython 3.13 with its standard library: `sqlite3`, `json`, `csv`, `re`, `datetime`, `asyncio`, `dataclasses`, `decimal` and more.
- The **Run ▾** menu offers: Run file, Run with arguments (`sys.argv`), Debug, Profile (cProfile table), Run tests (pytest, with a unittest fallback), and Run cell.
- **Code cells**: put `# %%` between sections and run one with Ctrl/⌘+Shift+Enter, notebook-style.
- **`input()`** pauses the program and shows an input field inline in the console.
- **Stop / Ctrl+C** raises `KeyboardInterrupt`, including during `time.sleep`, `input()` and async code. Infinite loops can also be interrupted when hosted with `coi-sw.js`; otherwise Force stop restarts Python.

**Notebooks (.ipynb)**
- Create one with **+ → Notebook**, open the *Notebook tour* example, or upload/drag in any Jupyter notebook. Files are standard nbformat 4.5, so they open in Jupyter, VS Code or Colab, and outputs are saved inside them.
- Code and markdown cells, with outputs inline under each cell: text, tables, plots, images, `input()` prompts and tracebacks.
- Markdown cells render headings, lists, tables, code and math (`$…$`, `$$…$$`, via KaTeX). sympy results and `display(Latex(...))` are typeset too.
- Cells share one Python session with each other and with the console.
- Jupyter keys:
  - Shift+Enter runs a cell and moves on; Ctrl/⌘+Enter runs it in place; Alt+Enter runs it and inserts a cell below.
  - Esc leaves the editor (command mode). Then A/B insert a cell, M/Y switch markdown/code, D D deletes, Z undoes a delete, I I interrupts and 0 0 restarts and runs all.
- **Run all** stops at the first error. Also available: run above/below, restart & run all, clear outputs, move cells, and format all cells with Black.
- IPython syntax in cells:
  - line magics (`%timeit`, `%pip install …`, `!pip install …`, `%matplotlib inline`, …)
  - cell magics (`%%writefile`, `%%time`, `%%timeit`, `%%capture`, `%%html`, `%%markdown`, `%%latex`)
- Export a notebook as a `# %%` Python script, or convert such a script into a notebook (command palette). Share links include notebooks without their outputs.

**Debugger**
- Click left of a line number (or press F9) to set a breakpoint, then press **F5**. With no breakpoints, it pauses on the first line.
- Step over, into and out (F10 / F11 / Shift+F11), continue and stop.
- The Debug panel shows the call stack (click a frame to switch to it), local and global variables, watch expressions, and an evaluate box that runs code in the paused frame.
- Hovering a name while paused shows its value.
- Uncaught errors pause at the failing line so you can inspect the variables (post-mortem). In the console, `%debug` inspects the last error.

**Editor and code intelligence**
- Syntax highlighting, code folding, bracket matching, multi-cursor (sublime keys), find/replace and an optional 79-column ruler.
- Autocomplete (jedi): Ctrl+Space, or automatic after `.`. Hover docs, signature help as you type `(`, and go to definition (F12 or Ctrl/⌘+click, across files).
- Find references (Shift+F12) and rename a symbol across the project (F2).
- **Linting as you type** (syntax errors and pyflakes) with underlines, gutter marks, a Problems panel and a status-bar count.
- **Format with Black** (Shift+Alt+F), optionally on save.
- **Navigation**: go to file (Ctrl/⌘+P), go to symbol (Ctrl/⌘+Shift+O), go to line (Ctrl+G), an Outline panel (classes, functions, cells) and find & replace in all files.

**Console**
- A `>>>` prompt with history, tab completion, continuation lines and top-level `await`. It shares the namespace of the last run (like `python -i`).
- Magics: `%timeit`, `%time`, `%who`/`%whos`, `%reset`, `%run file.py args`, `%debug`, `%pip`, `%cd`/`%ls`/`%pwd`, `%env`, `%clear` and `%lsmagic`.
- Help: `obj?` shows help and `obj??` shows source.
- **Variables panel**: a live table of everything defined; click a row to display it.
- **Rich output**:
  - matplotlib plots and pandas tables render inline
  - `display()` shows any object with `_repr_html_`, `_repr_png_` or `_repr_svg_` (`from ide import HTML, SVG, Image`)
  - ANSI colours and `\r` progress bars work
  - click an image to download it
- **Turtle graphics**: `import turtle` draws an animated picture in the console. Keyboard/mouse events aren't supported.

**Packages, files and projects**
- Imports install automatically. Pyodide ships 300+ prebuilt packages (numpy, pandas, scipy, scikit-learn, matplotlib, sympy and more), and pure-Python packages come from PyPI. You can also use `pip install x` in the console or the Packages panel.
- Multiple files and folders that can `import` each other, with tabs you can create, rename (double-click) and delete.
- Upload or drag in files. A `.zip` can be extracted into the project.
- Download single files or the whole project as a .zip; files your program writes appear in the Files panel.
- In Chrome or Edge you can mount a real folder.
- Everything is **saved automatically** in your browser, including breakpoints and watches. **Share** copies a link with the code inside it.
- Light and dark themes, adjustable font size (Ctrl/⌘ + = / −); works on tablets and phones.

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
| `index.html` | The whole IDE. Besides the styles and UI script, it embeds `<script type="text/plain">` blocks: the Web Worker (`#worker-src`) and the Python modules written into Pyodide at startup (`ide.py` runtime, `ide_tools.py` debugger/lint/format/intel/tests/magics, `ide_mpl.py` matplotlib backend, `turtle.py`). Markdown/math rendering for notebooks (marked, DOMPurify, KaTeX) loads from cdnjs the first time it is needed |
| `coi-sw.js` | Optional service worker that enables cross-origin isolation when hosted |

Black, pyflakes and pytest are fetched on first use (from PyPI or Pyodide's CDN), so the first lint or format takes a few seconds longer.

## Limitations

These come from running Python in a browser sandbox:

- No `subprocess` or `threading`-based parallelism, and `multiprocessing` doesn't work.
- No raw sockets. Use `pyodide.http.pyfetch`, or `requests` for CORS-enabled URLs.
- `tkinter` is unavailable. `turtle` works, but draws when the program finishes rather than live, and has no keyboard/mouse events.
- The debugger steps through your project's files; it doesn't step into installed libraries.
- Packages with C extensions work only if Pyodide has built them.
