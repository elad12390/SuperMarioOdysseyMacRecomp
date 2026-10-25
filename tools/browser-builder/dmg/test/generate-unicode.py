"""Generate frozen HFS+ BMP normalization data from CPython's Unicode 3.2 DB.

Run from repository root with uv run --no-project python and this script.
No CPython code is incorporated; output contains Unicode data only.
"""
import json
import pathlib
import unicodedata

db = unicodedata.ucd_3_2_0
decomposition = {}
combining = {}
for code in range(0x10000):
    char = chr(code)
    if db.combining(char):
        combining[code] = db.combining(char)
    if 0x2000 <= code <= 0x2FFF or 0xF900 <= code <= 0xFAFF or 0xAC00 <= code <= 0xD7A3:
        continue
    dec = db.decomposition(char)
    if dec and not dec.startswith("<"):
        decomposition[code] = [int(c, 16) for c in dec.split()]

dest = pathlib.Path(__file__).resolve().parent.parent / "unicode-3.2.json"
dest.write_text(json.dumps({"decomposition": decomposition, "combining": combining}, separators=(",", ":")) + "\n")
print(f"{len(decomposition)} decomposition entries, {len(combining)} combining classes; {dest.stat().st_size} bytes")
