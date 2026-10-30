# Hero sprites

`classes.json` is the source of truth for Hero Classes: each Class's name, the agent-name keywords that select it
(case-insensitive substrings, first match wins, `fallback` otherwise; the Quest's main agent is `leader`), and its
look as a stack of layers from the Universal LPC Spritesheet Generator.

A layer is `[sheet definition, variant, hue shift°, brightness, effect]`; effect is `"shadow"` (a shadowed face:
shadow with glowing eyes) or a `#rrggbb` tint for layers drawn in white. A `sword` key composites the arming sword's
128px slash around the 64px body frames; `work` and `verb` name the Class's working animation and its label.

`compose.py` builds them (needs Pillow) from a sparse clone of the generator:

```sh
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator.git lpc
git -C lpc sparse-checkout set --no-cone '/sheet_definitions/*' '/CREDITS.csv'
python compose.py lpc heroes.json out/   # heroes.json: {"<id>": <look>}; fetches only the layers it uses
```

It writes one JSON per Hero (south-facing strips for idle, walk, spellcast, emote, hurt, slash, thrust, shoot),
`credits.json` for every definition used and `used.json` listing the exact sheets composited.

To rebuild the art pack the web app serves (`apps/web/public/heroes`) after changing `classes.json`:

```sh
python build_pack.py lpc   # writes <class>/<anim>.png, manifest.json, CREDITS.csv and LICENSE-ART.md
```

A look may set `"victory": "spellcast"` when its outfit has no cheer (`emote`) animation; the app then holds a raised
cast with a sparkle instead. LPC layers list one or more licences (CC-BY-SA, GPL, OGA-BY, CC-BY, CC0), and a layer
may be used under any one of them. The pack uses each under an attribution-only one, so `build_pack.py` stops if a
layer offers none (share-alike only): swap it for another. The pack ships with its credits, separate from the code's
licence. See `docs/THEME.md`.
