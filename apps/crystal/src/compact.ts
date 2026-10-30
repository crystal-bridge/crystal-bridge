import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const MIN_WINDOW = 100_000;
const MAX_WINDOW = 1_000_000;
const SUFFIX: Record<string, number> = { '': 1, k: 1_000, m: 1_000_000 };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A configured size as a token count, in the range the CLI enforces; `null` for `auto`, undefined if unreadable. */
function size(value: unknown): number | null | undefined {
  if (value === 'auto') return null;
  const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(value.trim()) : null;
  const tokens = typeof value === 'number' ? value : match ? Number(match[1]) * SUFFIX[match[2]!.toLowerCase()]! : NaN;
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
  return Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.round(tokens)));
}

function settingsFile(path: string): Obj {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The file's own setting for this model, then its top-level one. */
function fromSettings(settings: Obj, model: string | undefined): unknown {
  const perModel = isObj(settings.modelSettings) ? settings.modelSettings : {};
  const own = model !== undefined ? perModel[model.replace(/\[.*\]$/, '')] : undefined;
  return (isObj(own) ? own.autoCompactWindow : undefined) ?? settings.autoCompactWindow;
}

/**
 * The size this session's context is held to, as the CLI documents the setting (code.claude.com/docs/en/model-config),
 * or undefined when it's automatic: the environment, then local, project and user settings. The CLI reports none of
 * this, and compacts a little before the size, by a margin it doesn't document. Managed settings and a model alias
 * as a `modelSettings` key aren't read. Only ever reads settings files, never credentials.
 */
export function compactWindow(options: {
  env: Record<string, string | undefined>;
  cwd: string;
  configDir: string;
  model: string | undefined;
}): number | undefined {
  const { env, cwd, configDir, model } = options;
  const files = [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(configDir, 'settings.json'),
  ].map(settingsFile);
  // A settings file's `env` block reaches the CLI's environment, not Crystal's.
  const fromEnv = [env[ENV_KEY], ...files.map((file) => (isObj(file.env) ? file.env[ENV_KEY] : undefined))];
  for (const value of [...fromEnv, ...files.map((file) => fromSettings(file, model))]) {
    const tokens = size(value);
    if (tokens !== undefined) return tokens ?? undefined;
  }
  return undefined;
}
