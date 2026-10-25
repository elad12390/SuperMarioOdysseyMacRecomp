# /// script
# requires-python = ">=3.12"
# dependencies = ["fonttools[woff]==4.60.1"]
# ///
"""Build redistributable shared-font stand-ins from the pinned OFL Nunito face."""
import argparse
import runpy
from pathlib import Path

from fontTools.ttLib import TTFont

parser = argparse.ArgumentParser()
parser.add_argument("--nxnative", type=Path, required=True)
parser.add_argument("--font", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
font = TTFont(args.font)
font.flavor = None
standard = args.output / "standard.ttf"
font.save(standard)
generator = runpy.run_path(str(args.nxnative / "dm/tools/make_ext_font.py"))
generator["build"](str(args.output / "nintendo_ext.ttf"), str(standard))
icons = TTFont(args.output / "nintendo_ext.ttf")
assert all(point in icons.getBestCmap() for point in (0xE0E0, 0xE0E1, 0xE0E2, 0xE0E3, 0xE0EF))
print("Verified public OFL stand-ins: A/B/X/Y and Plus code points present.")
