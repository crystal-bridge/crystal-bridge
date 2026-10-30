"""Composite LPC heroes from the generator's sheet definitions.

Usage: python compose.py <repo> <heroes.json> <out_dir>
heroes.json: {"id": {"body": "male", "layers": [["torso/shirts/torso_clothes_robe.json", "blue"], ...]}}
Writes <out_dir>/<id>.json: {anim: {"frames": n, "png": "<base64 strip of south-facing 64x64 frames>"}} and
<out_dir>/credits.json with the credits of every definition used.
"""

import base64
import io
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image

ANIMS = ["idle", "walk", "spellcast", "emote", "hurt", "slash", "thrust", "shoot"]
SIZE = 64


def load_def(repo: Path, rel: str) -> dict:
    return json.loads((repo / "sheet_definitions" / rel).read_text())


def layer_files(repo: Path, definition: dict, variant, body: str, anim: str):
    """(zPos, path) for every layer of a definition that has this animation for this body type."""
    out = []
    for key, layer in definition.items():
        if not key.startswith("layer_") or body not in layer or "custom_animation" in layer:
            continue
        base = repo / "spritesheets" / layer[body].strip("/").replace("//", "/") / anim
        candidates = []
        if variant:
            candidates += [base / f"{variant}.png", base / f"{variant.replace(' ', '_')}.png"]
        candidates += [base.with_suffix(".png")]
        out.append((layer.get("zPos", 0), candidates))
    return out


def shift(image: Image.Image, hue: float, value: float) -> Image.Image:
    """Rotates hue by `hue` degrees and scales brightness by `value`, keeping alpha."""
    if not hue and value == 1:
        return image
    alpha = image.getchannel("A")
    h, s, v = image.convert("RGB").convert("HSV").split()
    h = h.point(lambda x: (x + int(hue / 360 * 255)) % 256)
    v = v.point(lambda x: min(255, int(x * value)))
    out = Image.merge("HSV", (h, s, v)).convert("RGBA")
    out.putalpha(alpha)
    return out


def shadow_face(image: Image.Image) -> Image.Image:
    """A shadowed face: the head in shadow, the whites of the eyes glowing yellow."""
    px = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = px[x, y]
            if not a:
                continue
            bright = min(r, g, b) > 200
            px[x, y] = (255, 214, 64, a) if bright else (22, 18, 34, a)
    return image


def tint(image: Image.Image, colour: str) -> Image.Image:
    """Multiplies the layer by a colour, for layers drawn in white or grey (e.g. '#3a4fa8')."""
    r0, g0, b0 = (int(colour[i : i + 2], 16) for i in (1, 3, 5))
    px = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (r * r0 // 255, g * g0 // 255, b * b0 // 255, a)
    return image


def fetch(repo: Path, paths):
    rels = sorted({str(p.relative_to(repo)) for p in paths})
    if rels:
        subprocess.run(["git", "-C", str(repo), "sparse-checkout", "add", *rels], check=True, capture_output=True)


def main() -> None:
    repo, heroes_file, out_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)
    heroes = json.loads(heroes_file.read_text())
    credits = {}
    used = set()

    plan = {}
    wanted = []
    for hero_id, hero in heroes.items():
        for entry in hero["layers"]:
            rel, variant = entry[0], entry[1]
            hue = entry[2] if len(entry) > 2 else 0
            value = entry[3] if len(entry) > 3 else 1
            effect = entry[4] if len(entry) > 4 else None
            definition = load_def(repo, rel)
            for c in definition.get("credits", []):
                credits[c["file"]] = c
            for anim in ANIMS:
                files = layer_files(repo, definition, variant, hero["body"], anim)
                walks = layer_files(repo, definition, variant, hero["body"], "walk")
                for (z, candidates), (_, walk) in zip(files, walks):
                    plan.setdefault((hero_id, anim), []).append((z, candidates, hue, value, walk if anim == "idle" else [], effect))
                    wanted += candidates + walk
    fetch(repo, wanted)

    for hero_id in heroes:
        result = {}
        for anim in ANIMS:
            layers = sorted(plan.get((hero_id, anim), []), key=lambda item: item[0])
            images = []
            idle_size = None
            missing = 0
            for _, candidates, hue, value, walk, effect in layers:
                found = next((p for p in candidates if p.exists()), None)
                if found:
                    used.add(str(found.relative_to(repo / "spritesheets")))
                    image = Image.open(found).convert("RGBA")
                    idle_size = idle_size or image.size
                    image = shift(image, hue, value)
                    if effect == "shadow":
                        image = shadow_face(image)
                    elif effect and effect.startswith("#"):
                        image = tint(image, effect)
                    images.append(image)
                    continue
                if anim != "idle":
                    missing += 1
                stand = next((p for p in walk if p.exists()), None)
                if stand and idle_size:
                    used.add(str(stand.relative_to(repo / "spritesheets")))
                    # No idle sheet (e.g. weapons): hold the walk sheet's standing frame for every idle frame.
                    walk_image = Image.open(stand).convert("RGBA")
                    tiled = Image.new("RGBA", idle_size)
                    for row in range(idle_size[1] // SIZE):
                        frame = walk_image.crop((0, row * SIZE, SIZE, (row + 1) * SIZE))
                        for col in range(idle_size[0] // SIZE):
                            tiled.alpha_composite(frame, (col * SIZE, row * SIZE))
                    images.append(shift(tiled, hue, value))
            if not images:
                continue
            width, height = images[0].size
            canvas = Image.new("RGBA", (width, height))
            for image in images:
                if image.size == (width, height):
                    canvas.alpha_composite(image)
            rows = height // SIZE
            row = 2 if rows >= 4 else 0  # south-facing; single-row sheets (hurt) face south already
            strip = canvas.crop((0, row * SIZE, width, (row + 1) * SIZE))
            frames = width // SIZE
            # Trim empty trailing frames.
            while frames > 1 and strip.crop(((frames - 1) * SIZE, 0, frames * SIZE, SIZE)).getbbox() is None:
                frames -= 1
            strip = strip.crop((0, 0, frames * SIZE, SIZE))
            buffer = io.BytesIO()
            strip.save(buffer, "PNG", optimize=True)
            result[anim] = {
                "frames": frames,
                "complete": missing == 0,
                "png": base64.b64encode(buffer.getvalue()).decode(),
            }
        sword = heroes[hero_id].get("sword")
        if sword and "slash" in result:
            # Arming-sword slash: the 64px body frames sit centred in the sword's 128px frames.
            body = Image.open(io.BytesIO(base64.b64decode(result["slash"]["png"])))
            frames = result["slash"]["frames"]
            base = repo / "spritesheets/weapon/sword/arming/attack_slash"
            fetch(repo, [base / "fg" / f"{sword}.png", base / "bg" / f"{sword}.png"])
            used.update(str((base / part / f"{sword}.png").relative_to(repo / "spritesheets")) for part in ("fg", "bg"))
            fg = Image.open(base / "fg" / f"{sword}.png").convert("RGBA").crop((0, 256, frames * 128, 384))
            bg = Image.open(base / "bg" / f"{sword}.png").convert("RGBA").crop((0, 256, frames * 128, 384))
            big = Image.new("RGBA", (frames * 128, 128))
            big.alpha_composite(bg)
            for f in range(frames):
                big.alpha_composite(body.crop((f * 64, 0, f * 64 + 64, 64)), (f * 128 + 32, 32))
            big.alpha_composite(fg)
            buffer = io.BytesIO()
            big.save(buffer, "PNG", optimize=True)
            result["slash"] = {"frames": frames, "size": 128, "complete": True, "png": base64.b64encode(buffer.getvalue()).decode()}
        (out_dir / f"{hero_id}.json").write_text(json.dumps(result))
        print(hero_id, {a: v["frames"] for a, v in result.items()})
    (out_dir / "credits.json").write_text(json.dumps(list(credits.values()), indent=1))
    (out_dir / "used.json").write_text(json.dumps(sorted(used), indent=1))


if __name__ == "__main__":
    main()
