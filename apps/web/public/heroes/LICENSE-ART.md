# Hero art licence

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
