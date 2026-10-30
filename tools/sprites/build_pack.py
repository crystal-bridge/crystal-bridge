"""Build the Hero art pack the web app serves, from classes.json.

Usage: python build_pack.py <lpc-generator-clone> [out_dir]   (out_dir defaults to apps/web/public/heroes)

For each Class it composites the look (compose.py), keeps the animations the app plays, and writes:
  <out_dir>/<class>/<anim>.png   south-facing strips (64px frames; an arming-sword slash is 128px)
  <out_dir>/manifest.json        Classes, matching keywords, leader, fallback, frame counts and sizes
  <out_dir>/CREDITS.csv          the generator's credits rows for exactly the layers used
  <out_dir>/LICENSE-ART.md       the art's licences, which the code's licence does not cover
"""

import base64
import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

LICENSE_ART = """# Hero art licence

The images in this folder are not covered by Crystal Bridge's code licence. They are composited from layers of the
[Universal LPC Spritesheet Character Generator](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator).
Each layer's authors and licences are listed per file in `CREDITS.csv`.

Many layers are offered under several licences, of which a user follows only one
([OpenGameArt's FAQ](https://opengameart.org/content/faq)). Every layer here offers an attribution-only licence, and
that is the one this pack uses: **OGA-BY 3.0** where offered, otherwise **CC-BY 3.0/4.0**, or **CC0**. No layer is used
under CC-BY-SA or the GPL. The in-app Credits (Config menu) name the licence each layer is used under.

In practice that means:

- **Credit the authors.** Keep `CREDITS.csv` next to the images wherever they are redistributed, and keep the credits
  reachable from within the app.
- **No share-alike.** Modified or redistributed images don't have to be shared under the same terms. OGA-BY also
  allows DRM-protected distribution; the CC-BY layers ask that you don't add technical restrictions to them.
- **Swap freely.** The app reads `manifest.json` at runtime, so a fork can replace this whole folder with its own art
  (built with `tools/sprites/build_pack.py` from its own `classes.json`, or drawn by hand) without code changes.
"""

# Attribution-only licences: every credited layer must offer one of these, so the pack never needs share-alike.
ATTRIBUTION_ONLY = ("OGA-BY", "CC-BY ", "CC0")


def attribution_only(licences: str) -> bool:
    return any(f"{lic.strip()} ".startswith(ATTRIBUTION_ONLY) for lic in licences.split(","))


def main() -> None:
    lpc = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else ROOT / "apps/web/public/heroes"
    classes = json.loads((HERE / "classes.json").read_text())

    with tempfile.TemporaryDirectory() as tmp:
        heroes = {cid: c["look"] for cid, c in classes["classes"].items()}
        (Path(tmp) / "heroes.json").write_text(json.dumps(heroes))
        subprocess.run(
            [sys.executable, str(HERE / "compose.py"), str(lpc), str(Path(tmp) / "heroes.json"), str(Path(tmp) / "out")],
            check=True,
        )
        manifest = {"leader": classes["leader"], "fallback": classes["fallback"], "classes": {}}
        for cid, c in classes["classes"].items():
            look = c["look"]
            data = json.loads((Path(tmp) / "out" / f"{cid}.json").read_text())
            anims = {"idle", "spellcast", "hurt", look["work"]}
            victory = look.get("victory", "emote")
            anims.add(victory)
            (out / cid).mkdir(parents=True, exist_ok=True)
            frames = {}
            for anim in sorted(anims):
                strip = data[anim]
                (out / cid / f"{anim}.png").write_bytes(base64.b64decode(strip["png"]))
                frames[anim] = {"frames": strip["frames"], "size": strip.get("size", 64)}
            manifest["classes"][cid] = {
                "name": c["name"],
                "match": c["match"],
                "work": look["work"],
                "verb": look["verb"],
                "victory": victory,
                "anims": frames,
            }
        (out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")

        used = set(json.loads((Path(tmp) / "out" / "used.json").read_text()))
        with open(lpc / "CREDITS.csv", newline="") as src, open(out / "CREDITS.csv", "w", newline="") as dst:
            reader = csv.reader(src)
            header = next(reader)
            rows = {row[0].strip(): [cell.strip() for cell in row] for row in reader if row}
            keep = {}
            for path in sorted(used):
                if path in rows:
                    keep[path] = rows[path]
                    continue
                # No row for this exact file: credit the nearest row from the same folder (or a parent folder).
                folder = path.rsplit("/", 1)[0]
                while folder and not any(name.startswith(folder + "/") for name in keep):
                    match = next((name for name in sorted(rows) if name.startswith(folder + "/")), None)
                    if match:
                        keep[match] = rows[match]
                        break
                    folder = folder.rsplit("/", 1)[0] if "/" in folder else ""
            share_alike = sorted(name for name, row in keep.items() if not attribution_only(row[3]))
            if share_alike:
                sys.exit("these layers offer no attribution-only licence; swap them in classes.json:\n  " + "\n  ".join(share_alike))
            writer = csv.writer(dst)
            writer.writerow(header)
            for name in sorted(keep):
                writer.writerow(keep[name])
    (out / "LICENSE-ART.md").write_text(LICENSE_ART)
    print(f"wrote {len(manifest['classes'])} Classes to {out}")


if __name__ == "__main__":
    main()
