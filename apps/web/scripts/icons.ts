/**
 * Copies the app's icons out of the Iconify packs into `src/theme/iconData.ts`, per `src/theme/iconSources.ts`.
 * Usage: pnpm icons
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { drawing, type IconDrawing, iconModule, type IconifyPack } from '../src/theme/iconBuild.js';
import { ICON_PACKS, ICON_SOURCES, type IconPack, type IconSource } from '../src/theme/iconSources.js';

const packs = Object.fromEntries(
  Object.keys(ICON_PACKS).map((id) => {
    const url = new URL(`../node_modules/@iconify-json/${id}/icons.json`, import.meta.url);
    return [id, JSON.parse(readFileSync(url, 'utf8')) as IconifyPack];
  }),
) as Record<IconPack, IconifyPack>;

const drawings: Record<string, IconDrawing> = {};
for (const [name, source] of Object.entries(ICON_SOURCES) as [string, IconSource][]) {
  drawings[name] = drawing(packs[source.pack], source);
}
writeFileSync(new URL('../src/theme/iconData.ts', import.meta.url), iconModule(drawings));
console.log(`icons: wrote ${Object.keys(drawings).length} icons to src/theme/iconData.ts`);
