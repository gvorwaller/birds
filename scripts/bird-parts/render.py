"""QA renders of the generated geometry (not used by the app).

    python render.py OUTDIR [bird ...]

For each bird writes {bird}-pair.png (main | feathers) and {bird}-sheet.png (every part
highlighted on its own), to check boundaries for gaps, leaks and overlaps.
Needs rsvg-convert and ImageMagick (`magick`).
"""
import json, os, subprocess, sys
from common import OUT

TONES = {"pale": "#f4efe6", "light": "#e6dccb", "mid": "#b9a68a", "wing": "#a18c6f", "dark": "#7a6650",
         "darker": "#4a3d30", "bill": "#8c8172", "leg": "#c49a7a", "legyellow": "#e0b23a", "billyellow": "#d9c05a",
         "accent2": "#5b5fa8", "water": "#6c8fb0", "gullgray": "#a9b1ba", "legpink": "#d9a79b", "eye": "#1c1c1c",
         "perch": "#9b9286", "accent": "#c0392b", "orbital": "#e08a2c",
         "mallardgreen": "#3c5f45", "chestnut": "#7a4a35", "gullpale": "#d3d8de", "linegray": "#6f7780", "orange": "#e0893a"}


def svg(d, layer, highlight=None, width=900, title=None):
    x0, y0, w, h = d["viewBox"]
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0} {y0} {w} {h}" width="{width}" '
           f'height="{int(width * h / w)}" font-family="Helvetica">',
           f'<rect x="{x0}" y="{y0}" width="{w}" height="{h}" fill="#fbfaf7"/>']
    for i in d["insets"]:
        out.append(f'<circle cx="{i["cx"]}" cy="{i["cy"]}" r="{i["r"]}" fill="#f7f7f5" stroke="#8a7d6c" '
                   f'stroke-width="0.8" stroke-dasharray="3 2"/>')
    for b in d["under"]:
        out.append(f'<path d="{b["d"]}" fill="{TONES[b["tone"]]}" stroke="#2a2a2a" stroke-width="0.6"/>')
    order = {pid: i for i, pid in enumerate(d["drawOrder"])}
    for p in sorted((p for p in d["parts"] if layer in p["layers"]), key=lambda p: order[p["id"]]):
        fill = "#f6c344" if p["id"] == highlight else TONES[p["tone"]]
        out.append(f'<path d="{p["d"]}" fill="{fill}" fill-rule="evenodd" stroke="#8a7d6c" stroke-width="0.6"/>')
        if p["id"] != highlight:
            out += [f'<path d="{m["d"]}" fill="{TONES[m["tone"]]}"/>' for m in p.get("marks", [])]
    if d["outline"]:
        out.append(f'<path d="{d["outline"]}" fill="none" stroke="#2a2a2a" stroke-width="1.4" stroke-linejoin="round"/>')
    for b in d["over"]:
        out.append(f'<path d="{b["d"]}" fill="{TONES[b["tone"]]}"/>')
    hp = next((p for p in d["parts"] if p["id"] == highlight), None)
    if hp:   # a selected part is drawn again on top, so overlapping rows never hide it
        out.append(f'<path d="{hp["d"]}" fill="#f6c344" fill-rule="evenodd" stroke="#8e1b10" stroke-width="1.5" stroke-dasharray="5 3"/>')
    if title:
        out.append(f'<text x="{x0 + 6}" y="{y0 + 22}" font-size="22">{title}</text>')
    return "\n".join(out + ["</svg>"])


def png(svg_text, path):
    with open(path[:-4] + ".svg", "w") as f: f.write(svg_text)
    subprocess.run(["rsvg-convert", path[:-4] + ".svg", "-o", path], check=True)


def main(outdir, birds):
    os.makedirs(outdir, exist_ok=True)
    for b in birds:
        d = json.load(open(OUT / f"{b}.json"))
        pair = [os.path.join(outdir, f"{b}-{layer}.png") for layer in ("main", "feathers")]
        for layer, p in zip(("main", "feathers"), pair): png(svg(d, layer), p)
        subprocess.run(["magick", *pair, "+append", os.path.join(outdir, f"{b}-pair.png")], check=True)
        cells = []
        for p in d["parts"]:
            layer = "main" if "main" in p["layers"] else "feathers"
            cell = os.path.join(outdir, f"{b}--{p['id']}.png")
            png(svg(d, layer, highlight=p["id"], width=300, title=f"{p['id']} ({layer})"), cell)
            cells.append(cell)
        subprocess.run(["magick", "montage", *cells, "-tile", "6x", "-geometry", "+4+4",
                        os.path.join(outdir, f"{b}-sheet.png")], check=True)
        print(f"{b}: {outdir}/{b}-pair.png, {b}-sheet.png")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:] or ["songbird", "shorebird", "duck", "gull", "raptor", "heron"])
