// Example programs offered in the Examples menu.
export const EXAMPLES = [
  {
    name: 'hello.py',
    title: 'Hello, input()',
    desc: 'Interactive input and f-strings',
    code: `# input() pauses the program and waits for you to type in the console.
name = input("What's your name? ")
age = int(input("How old are you? "))
print(f"Hello, {name}! In 10 years you'll be {age + 10}.")
`,
  },
  {
    name: 'plot.py',
    title: 'Matplotlib chart',
    desc: 'numpy + matplotlib, shown inline',
    code: `import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 4 * np.pi, 400)
fig, ax = plt.subplots(figsize=(7, 3.5))
ax.plot(x, np.sin(x), label="sin(x)")
ax.plot(x, np.cos(x) * np.exp(-x / 8), label="damped cos(x)")
ax.set_title("Plots render right in the console")
ax.legend()
ax.grid(alpha=.3)
plt.show()
`,
  },
  {
    name: 'dataframe.py',
    title: 'pandas DataFrame',
    desc: 'Tables render as HTML',
    code: `import pandas as pd
import numpy as np

rng = np.random.default_rng(0)
df = pd.DataFrame({
    "city": ["Lisbon", "Oslo", "Kyoto", "Lima", "Accra"],
    "temp_c": rng.normal(18, 6, 5).round(1),
    "rain_mm": rng.integers(0, 120, 5),
})
display(df.sort_values("temp_c", ascending=False))
print(df.describe())
`,
  },
  {
    name: 'game.py',
    title: 'Guess the number',
    desc: 'A loop with input() and random',
    code: `import random

secret = random.randint(1, 100)
print("I'm thinking of a number between 1 and 100.")
for tries in range(1, 8):
    guess = int(input(f"Guess #{tries}: "))
    if guess == secret:
        print(f"Correct! You got it in {tries} tries.")
        break
    print("Too low." if guess < secret else "Too high.")
else:
    print(f"Out of guesses. It was {secret}.")
`,
  },
  {
    name: 'progress.py',
    title: 'Progress & Ctrl+C',
    desc: 'time.sleep, \\r progress, interrupt',
    code: `import time

# Press Stop (or Ctrl+C in the console) to interrupt.
for i in range(101):
    bar = "#" * (i // 4)
    print(f"\\r[{bar:<25}] {i:3d}%", end="", flush=True)
    time.sleep(0.05)
print("\\nDone!")
`,
  },
  {
    name: 'async_demo.py',
    title: 'asyncio',
    desc: 'Top-level await and tasks',
    code: `import asyncio

async def worker(name, delay):
    for i in range(3):
        await asyncio.sleep(delay)
        print(f"{name} tick {i}")
    return name

results = await asyncio.gather(worker("fast", 0.2), worker("slow", 0.35))
print("finished:", results)
`,
  },
  {
    name: 'files_demo.py',
    title: 'Files & sqlite',
    desc: 'Write files, use sqlite3',
    code: `import csv, sqlite3, json, os

with open("people.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerows([["name", "score"], ["Ada", 95], ["Linus", 88], ["Grace", 99]])

db = sqlite3.connect("scores.db")
db.execute("CREATE TABLE IF NOT EXISTS s (name TEXT, score INT)")
with open("people.csv") as f:
    rows = list(csv.DictReader(f))
db.executemany("INSERT INTO s VALUES (:name, :score)", rows)
print(db.execute("SELECT name, score FROM s ORDER BY score DESC").fetchall())

print("Files in the working directory:", os.listdir("."))
print("See the Files tab to download them.")
`,
  },
  {
    name: 'rich_demo.py',
    title: 'Colours with rich',
    desc: 'Installs a package from PyPI',
    code: `# Packages that are not built in are installed automatically from PyPI.
from rich.console import Console
from rich.table import Table

table = Table(title="Planets")
table.add_column("Name", style="cyan")
table.add_column("Moons", justify="right", style="magenta")
for name, moons in [("Earth", 1), ("Mars", 2), ("Jupiter", 95), ("Saturn", 146)]:
    table.add_row(name, str(moons))
Console(force_terminal=True, width=60).print(table)
`,
  },
  {
    name: 'modules_demo.py',
    title: 'Multiple files',
    desc: 'Import your own modules',
    code: `# Create a file named shapes.py (with the + button) containing, e.g.:
#
#     import math
#     def circle_area(r):
#         return math.pi * r ** 2
#
# Then run this file. Edits to shapes.py are picked up on every run.
try:
    from shapes import circle_area
    print(circle_area(2))
except ImportError:
    print("Create shapes.py first (see the comment at the top).")
`,
  },
  {
    name: 'turtle_svg.py',
    title: 'SVG drawing',
    desc: 'Generate graphics with display()',
    code: `from ide import SVG
import math

points = []
for i in range(361):
    t = math.radians(i)
    r = 90 * math.sin(5 * t)
    points.append(f"{110 + r * math.cos(t):.1f},{110 + r * math.sin(t):.1f}")

display(SVG(f'''<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220">
  <polyline points="{' '.join(points)}" fill="none" stroke="#4f8cff" stroke-width="2"/>
</svg>'''))
`,
  },
];

export const WELCOME = `# Welcome! This is real CPython running entirely in your browser
# (via Pyodide / WebAssembly). Nothing is installed on your computer.
#
#   Ctrl/Cmd+Enter   run this file
#   Shift+Enter      run the selection (or current line) in the console
#   Console panel    an interactive Python prompt that sees your variables
#
# Try the Examples menu for plots, pandas, input(), asyncio and more.

import sys
import platform

print("Hello from Python", sys.version.split()[0], "on", platform.system())

name = input("What's your name? ")
squares = {n: n * n for n in range(1, 6)}
print(f"Nice to meet you, {name}. Some squares: {squares}")
`;
