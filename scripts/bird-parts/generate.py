"""Regenerate the Parts of a Bird drawings (td-9c9655).

    python3 -m venv /tmp/bird-parts-venv && /tmp/bird-parts-venv/bin/pip install -r requirements.txt
    /tmp/bird-parts-venv/bin/python generate.py          # all four birds
    /tmp/bird-parts-venv/bin/python render.py /tmp/qa    # QA renders (rsvg-convert + ImageMagick)

Each bird script traces a simplified side view from openly licensed reference photos (used
for proportions only; never published; listed in each data module's model.sources). Rough part
shapes are clipped to the silhouette and painter-subtracted so parts never overlap, then
written to src/lib/bird-parts/geometry/{bird}.json. Tracing coordinates are the photo's
pixels; build() mirrors (flip_x) and translates them so every bird faces right.
"""
import runpy, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
for bird in sys.argv[1:] or ["songbird", "shorebird", "duck", "gull"]:
    runpy.run_path(str(HERE / f"{bird}.py"), run_name="__main__")
