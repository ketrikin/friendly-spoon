"""Runtime support for the in-browser Python IDE.

This module is loaded into Pyodide inside the Web Worker. It provides:

* running project files as ``__main__`` (like ``python file.py``) and keeping
  the namespace around for the interactive console (like ``python -i``)
* an interactive console with continuation lines and top-level ``await``
* rich output: ``display()``, ``_repr_html_``/``_repr_png_``/``_repr_svg_``
  objects (pandas, PIL, ...) and inline matplotlib figures
* blocking ``input()`` / ``sys.stdin`` and an interruptible ``time.sleep``
* on-demand installation of missing packages via micropip
* code completion (jedi when available, rlcompleter otherwise)

The public helpers (``display``, ``HTML``, ``SVG``, ``Image``) can be imported
by user code with ``from ide import display, HTML, Image``.
"""

import ast
import base64
import builtins
import codeop
import importlib
import importlib.metadata
import importlib.util
import inspect
import io
import json
import linecache
import os
import re
import sys
import time
import traceback
import types

import _ide_js

HOME = "/home/pyodide"
_TLA = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT

__all__ = ["display", "HTML", "SVG", "Image"]

# --------------------------------------------------------------------------
# Rich display
# --------------------------------------------------------------------------


def _flush():
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass


def _emit(mime, data, meta=None):
    _flush()
    _ide_js.display(mime, data, json.dumps(meta or {}))


def _b64(data):
    if isinstance(data, str):
        return data  # IPython convention: already base64 encoded
    return base64.b64encode(bytes(data)).decode("ascii")


def _png_size(data):
    if isinstance(data, (bytes, bytearray)) and data[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    return None


def show_figure(fig):
    """Render a matplotlib figure inline as a (high-dpi) PNG."""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=fig.dpi * 2, bbox_inches="tight")
    png = buf.getvalue()
    size = _png_size(png)
    meta = {"width": size[0] // 2} if size else {}
    _emit("image/png", _b64(png), meta)
    fig._ide_shown = True


def _flush_figures():
    """Show any matplotlib figures that were created but never shown."""
    helpers = sys.modules.get("matplotlib._pylab_helpers")
    if helpers is None:
        return
    try:
        managers = helpers.Gcf.get_all_fig_managers()
        for manager in managers:
            if not getattr(manager.canvas.figure, "_ide_shown", False):
                show_figure(manager.canvas.figure)
        if managers:
            helpers.Gcf.destroy_all()
    except Exception:
        traceback.print_exc()


_RICH = (
    ("_repr_html_", "text/html"),
    ("_repr_svg_", "image/svg+xml"),
    ("_repr_png_", "image/png"),
    ("_repr_jpeg_", "image/jpeg"),
)


def _display_one(obj):
    fig_mod = sys.modules.get("matplotlib.figure")
    if fig_mod is not None and isinstance(obj, fig_mod.Figure):
        show_figure(obj)
        return
    if not inspect.isclass(obj) and not isinstance(obj, types.ModuleType):
        for attr, mime in _RICH:
            try:
                method = getattr(obj, attr, None)
            except Exception:
                method = None
            if not callable(method):
                continue
            try:
                data = method()
            except Exception:
                continue
            meta = {}
            if isinstance(data, tuple):
                data, meta = data[0], (data[1] if len(data) > 1 else {}) or {}
            if data is None:
                continue
            if mime in ("image/png", "image/jpeg"):
                size = _png_size(data)
                if size and "width" not in meta:
                    meta = dict(meta, width=size[0])
                data = _b64(data)
            elif isinstance(data, bytes):
                data = data.decode("utf-8", "replace")
            try:
                _emit(mime, str(data), dict(meta))
            except TypeError:
                _emit(mime, str(data))
            return
    print(repr(obj))


def display(*objs):
    """Display objects with their richest available representation."""
    for obj in objs:
        _display_one(obj)


class HTML:
    """Wrap a string of HTML so that ``display()`` renders it."""

    def __init__(self, html):
        self.data = str(html)

    def _repr_html_(self):
        return self.data

    def __repr__(self):
        return f"<HTML {len(self.data)} chars>"


class SVG:
    """Wrap SVG markup so that ``display()`` renders it."""

    def __init__(self, svg):
        self.data = str(svg)

    def _repr_svg_(self):
        return self.data

    def __repr__(self):
        return f"<SVG {len(self.data)} chars>"


class Image:
    """Display a PNG/JPEG image given as bytes or a file path."""

    def __init__(self, data=None, filename=None, width=None):
        if filename is None and isinstance(data, (str, os.PathLike)):
            filename, data = data, None
        if filename is not None:
            with open(filename, "rb") as f:
                data = f.read()
        self.data = bytes(data)
        self.width = width

    def _repr_png_(self):
        if self.data[:3] == b"\xff\xd8\xff":
            return None
        return (self.data, {"width": self.width} if self.width else {})

    def _repr_jpeg_(self):
        if self.data[:3] != b"\xff\xd8\xff":
            return None
        return (self.data, {"width": self.width} if self.width else {})

    def __repr__(self):
        return f"<Image {len(self.data)} bytes>"


def _displayhook(value):
    if value is None:
        return
    builtins._ = None
    _display_one(value)
    builtins._ = value


# --------------------------------------------------------------------------
# stdin / sleep
# --------------------------------------------------------------------------

_INTERRUPTED, _UNSUPPORTED, _EOF = 1, 2, 3


def _input(prompt=""):
    if prompt:
        sys.stdout.write(str(prompt))
    _flush()
    result = _ide_js.read_line()
    if isinstance(result, str):
        return result
    if result == _INTERRUPTED:
        raise KeyboardInterrupt
    if result == _UNSUPPORTED:
        raise RuntimeError(
            "input() is unavailable because this page is not cross-origin "
            "isolated (SharedArrayBuffer is missing). Serve the IDE over "
            "http(s) so its service worker can enable isolation, then reload."
        )
    raise EOFError("EOF when reading a line")


def _sleep(secs):
    secs = float(secs)
    if secs < 0:
        raise ValueError("sleep length must be non-negative")
    _flush()
    if _ide_js.sleep(secs):
        raise KeyboardInterrupt


# --------------------------------------------------------------------------
# Package installation
# --------------------------------------------------------------------------

auto_install = True
_failed = set()
# import name -> PyPI distribution name (only for names not in Pyodide's lockfile)
_PYPI_ALIASES = {
    "bs4": "beautifulsoup4",
    "cv2": "opencv-python",
    "dateutil": "python-dateutil",
    "dotenv": "python-dotenv",
    "jwt": "PyJWT",
    "sklearn": "scikit-learn",
    "skimage": "scikit-image",
    "yaml": "pyyaml",
    "PIL": "pillow",
    "Crypto": "pycryptodome",
    "attr": "attrs",
    "google.protobuf": "protobuf",
    "serial": "pyserial",
    "magic": "python-magic",
    "docx": "python-docx",
    "pptx": "python-pptx",
}
_NEVER = {"tkinter", "turtle", "turtledemo", "curses", "readline", "idlelib", "msvcrt", "winreg", "_winapi"}


def _status(msg):
    _ide_js.status(str(msg))


def _module_available(name):
    if name in sys.modules:
        return True
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return True  # something odd; let the real import report it


def _missing_imports(sources):
    from pyodide.code import find_imports

    names = set()
    for src in sources:
        try:
            names.update(n.split(".")[0] for n in find_imports(str(src)))
        except Exception:
            pass
    if HOME not in sys.path:
        sys.path.insert(0, HOME)
    importlib.invalidate_caches()
    return sorted(
        n
        for n in names
        if n
        and n not in _failed
        and n not in _NEVER
        and n not in sys.stdlib_module_names
        and not _module_available(n)
    )


async def _micropip():
    try:
        import micropip
    except ImportError:
        import pyodide_js

        await pyodide_js.loadPackage("micropip")
        import micropip
    return micropip


async def ensure_installed(sources):
    """Load/install any imported top-level modules that are missing.

    Packages that ship with Pyodide (numpy, pandas, matplotlib, ...) are loaded
    from its CDN; anything else is installed from PyPI with micropip.
    """
    if not auto_install:
        return
    sources = [str(s) for s in sources]
    for src in sources:
        await _ide_js.load_imports(src)
    missing = _missing_imports(sources)
    if not missing:
        return
    micropip = await _micropip()
    for name in missing:
        pkg = _PYPI_ALIASES.get(name, name)
        _status(f"Installing {pkg} from PyPI…")
        try:
            await micropip.install(pkg)
            importlib.invalidate_caches()
            _status(f"Installed {pkg}")
        except Exception as e:
            _failed.add(name)
            first = (str(e).strip().splitlines() or [type(e).__name__])[0]
            _status(f"Could not install '{pkg}': {first[:200]}")


async def pip(args):
    """Very small ``pip`` command line: install / uninstall / list / show."""
    argv = args.split()
    if not argv:
        print("usage: pip install|uninstall|list|show <package> ...")
        return
    cmd, rest = argv[0], [a for a in argv[1:] if not a.startswith("-")]
    try:
        await _pip(cmd, rest)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)


async def _pip(cmd, rest):
    if cmd == "install":
        if not rest:
            print("pip install: no packages given")
            return
        micropip = await _micropip()
        for pkg in rest:
            _status(f"Installing {pkg}…")
            try:
                await micropip.install(pkg)
                print(f"Successfully installed {pkg}")
            except Exception as e:
                print(f"ERROR: could not install {pkg}: {e}", file=sys.stderr)
        importlib.invalidate_caches()
        _failed.clear()
    elif cmd == "uninstall":
        micropip = await _micropip()
        for pkg in rest:
            try:
                micropip.uninstall(pkg)
                print(f"Successfully uninstalled {pkg}")
            except Exception as e:
                print(f"ERROR: {e}", file=sys.stderr)
    elif cmd in ("list", "freeze"):
        for name, version in json.loads(list_packages()):
            print(f"{name}=={version}" if cmd == "freeze" else f"{name:<32} {version}")
    elif cmd == "show":
        for pkg in rest:
            try:
                meta = importlib.metadata.metadata(pkg)
                for key in ("Name", "Version", "Summary", "Home-page", "Author", "License"):
                    if meta.get(key):
                        print(f"{key}: {meta[key]}")
            except importlib.metadata.PackageNotFoundError:
                print(f"WARNING: Package(s) not found: {pkg}", file=sys.stderr)
    else:
        print(f"pip: unsupported command '{cmd}' (try install, uninstall, list, show)")


def list_packages():
    seen = {}
    for dist in importlib.metadata.distributions():
        try:
            name = dist.metadata["Name"]
        except Exception:
            continue
        if name and name.lower() not in seen:
            seen[name.lower()] = (name, dist.version)
    return json.dumps(sorted(seen.values(), key=lambda p: p[0].lower()))


# --------------------------------------------------------------------------
# Running code
# --------------------------------------------------------------------------

_main = types.ModuleType("__main__")
_main.__dict__["__builtins__"] = builtins
_cell = 0


def _ns():
    return _main.__dict__


def _purge_project_modules():
    """Forget modules imported from the project so edits are picked up."""
    prefix = HOME + "/"
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None)
        if isinstance(f, str) and f.startswith(prefix):
            del sys.modules[name]
    importlib.invalidate_caches()


def _strip_internal(tb):
    """Drop traceback entries that belong to this module (the IDE plumbing)."""
    keep = []
    while tb is not None:
        if tb.tb_frame.f_code.co_filename != __file__:
            keep.append(tb)
        tb = tb.tb_next
    for a, b in zip(keep, keep[1:] + [None]):
        a.tb_next = b
    return keep[0] if keep else None


def _report_exception(e):
    sys.last_exc, sys.last_type, sys.last_value = e, type(e), e
    tb = _strip_internal(e.__traceback__)
    sys.last_traceback = tb
    _flush()
    traceback.print_exception(type(e), e, tb)
    # Tell the editor where things went wrong (innermost frame in a project file)
    loc = None
    if isinstance(e, SyntaxError) and e.filename and e.lineno:
        loc = (e.filename, e.lineno)
    for frame, lineno in traceback.walk_tb(tb):
        fname = frame.f_code.co_filename
        if fname.startswith(HOME + "/"):
            loc = (fname, lineno)
    if loc and str(loc[0]).startswith(HOME + "/"):
        _ide_js.error_location(os.path.relpath(loc[0], HOME), int(loc[1]))


def _handle_system_exit(e):
    code = e.code
    if code is None or code == 0:
        return
    if isinstance(code, int):
        print(f"[process exited with code {code}]", file=sys.stderr)
    else:
        print(code, file=sys.stderr)


async def _execute(code, ns):
    result = eval(code, ns)
    if inspect.iscoroutine(result):
        result = await result
    return result


async def run_file(path):
    """Run a project file as ``__main__``; its namespace becomes the console's."""
    global _main
    _purge_project_modules()
    os.chdir(HOME)
    full = os.path.join(HOME, path)
    if os.path.dirname(full) not in sys.path:
        sys.path.insert(0, os.path.dirname(full))
    if HOME not in sys.path:
        sys.path.insert(0, HOME)
    with open(full, encoding="utf-8") as f:
        src = f.read()
    _main = types.ModuleType("__main__")
    _main.__dict__.update(__file__=full, __builtins__=builtins)
    sys.modules["__main__"] = _main
    sys.argv = [full]
    linecache.checkcache(full)
    status = "ok"
    try:
        code = compile(src, full, "exec", flags=_TLA, dont_inherit=True)
        await _execute(code, _ns())
    except SystemExit as e:
        _handle_system_exit(e)
        if e.code not in (None, 0):
            status = "error"
    except KeyboardInterrupt as e:
        _report_exception(e)
        status = "interrupted"
    except BaseException as e:
        _report_exception(e)
        status = "error"
    finally:
        _flush_figures()
        _flush()
    return status


_compiler = codeop.CommandCompiler()
_compiler.compiler.flags |= _TLA
_buffer = []
_PIP = re.compile(r"^\s*[%!]?\s*pip3?\s+(.*)$")


def _cell_name(src):
    global _cell
    _cell += 1
    name = f"<input-{_cell}>"
    linecache.cache[name] = (len(src), None, src.splitlines(True), name)
    return name


async def _run_code(code):
    try:
        await _execute(code, _ns())
    except SystemExit as e:
        if e.code not in (None, 0):
            _handle_system_exit(e)
        print("(exit() has no effect in the browser console; use Restart to reset Python)")
    except BaseException as e:
        _report_exception(e)
    finally:
        _flush_figures()
        _flush()


async def repl_push(line):
    """Push one console line. Returns 'incomplete', 'complete' or 'error'."""
    line = str(line)
    if not _buffer:
        m = _PIP.match(line)
        if m:
            await pip(m.group(1))
            return "complete"
    if not _buffer and not line.strip():
        return "complete"
    _buffer.append(line)
    source = "\n".join(_buffer)
    try:
        code = _compiler(source, "<console>", "single")
    except (SyntaxError, OverflowError, ValueError) as e:
        _buffer.clear()
        _flush()
        sys.stderr.write("".join(traceback.format_exception_only(type(e), e)))
        return "error"
    if code is None:
        return "incomplete"
    _buffer.clear()
    name = _cell_name(source)
    code = compile(source, name, "single", flags=_TLA, dont_inherit=True)
    await ensure_installed([source])
    await _run_code(code)
    return "complete"


async def repl_cell(source):
    """Run a multi-line block (like a notebook cell); show the last expression."""
    source = str(source)
    _buffer.clear()
    if not source.strip():
        return "complete"
    if "\n" not in source.strip():
        m = _PIP.match(source)
        if m:
            await pip(m.group(1))
            return "complete"
    name = _cell_name(source)
    try:
        tree = ast.parse(source, name, "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        body = compile(tree, name, "exec", flags=_TLA, dont_inherit=True)
        tail = compile(last, name, "eval", flags=_TLA, dont_inherit=True) if last else None
    except (SyntaxError, OverflowError, ValueError) as e:
        _flush()
        sys.stderr.write("".join(traceback.format_exception_only(type(e), e)))
        return "error"
    await ensure_installed([source])
    try:
        await _execute(body, _ns())
        if tail is not None:
            _displayhook(await _execute(tail, _ns()))
    except SystemExit as e:
        _handle_system_exit(e)
    except BaseException as e:
        _report_exception(e)
    finally:
        _flush_figures()
        _flush()
    return "complete"


def repl_reset():
    _buffer.clear()


# --------------------------------------------------------------------------
# Completion
# --------------------------------------------------------------------------


def _rl_complete(text):
    import rlcompleter

    word = re.search(r"[\w.]*$", text).group(0)
    completer = rlcompleter.Completer(_ns())
    out, i = [], 0
    while i < 500:
        r = completer.complete(word, i) if word else None
        if r is None:
            break
        out.append(r)
        i += 1
    prefix = word.rsplit(".", 1)[-1] if word else ""
    names = []
    for r in out:
        tail = r.rsplit(".", 1)[-1] if "." in word else r
        names.append([tail, "function" if tail.endswith("(") else ""])
    return {"items": names, "prefix": len(prefix)}


def complete(source, line, column, mode, path):
    """Return completions as JSON: {"items": [[text, type], ...], "prefix": n}."""
    source = str(source)
    try:
        import jedi
    except ImportError:
        jedi = None
    if jedi is not None:
        try:
            if mode == "console":
                script = jedi.Interpreter(source, [_ns()])
            else:
                script = jedi.Script(source, path=os.path.join(HOME, str(path)))
            comps = script.complete(int(line), int(column))
            items, prefix = [], 0
            for c in comps[:300]:
                if c.name.startswith("__") and not c.complete.startswith("_") and len(comps) > 50:
                    continue
                items.append([c.name, c.type])
            if comps:
                prefix = len(comps[0].name) - len(comps[0].complete)
            return json.dumps({"items": items, "prefix": prefix})
        except Exception:
            pass
    lines = source.split("\n")
    text = "\n".join(lines[: int(line) - 1] + [lines[int(line) - 1][: int(column)]])
    return json.dumps(_rl_complete(text))


# --------------------------------------------------------------------------
# Files
# --------------------------------------------------------------------------


def list_files(root=HOME):
    out = []
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "__pycache__")
        for name in sorted(files):
            full = os.path.join(base, name)
            try:
                size = os.path.getsize(full)
            except OSError:
                size = -1
            out.append([os.path.relpath(full, root), size])
    return json.dumps(out)


def zip_dir(root=HOME, target="/tmp/project.zip"):
    import zipfile

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, _ in json.loads(list_files(root)):
            zf.write(os.path.join(root, rel), rel)
    return target


# --------------------------------------------------------------------------
# Setup
# --------------------------------------------------------------------------


def setup():
    os.makedirs(HOME, exist_ok=True)
    os.chdir(HOME)
    if HOME not in sys.path:
        sys.path.insert(0, HOME)
    builtins.input = _input
    builtins.display = display
    time.sleep = _sleep
    sys.displayhook = _displayhook
    sys.modules["__main__"] = _main
    os.environ.setdefault("MPLBACKEND", "module://ide_mpl")
    os.environ.setdefault("TERM", "xterm-256color")
    os.environ.setdefault("COLUMNS", "100")
    return f"Python {sys.version.split()[0]}"
