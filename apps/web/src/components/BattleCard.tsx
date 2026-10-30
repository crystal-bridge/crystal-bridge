import type { ReactNode } from 'react';
import type { BattleOutcome, BattleResult } from '../battle.js';
import { duration, money, tokens } from '../format.js';
import { type HeroManifest, type HeroState, matchClass } from '../heroes.js';
import { type Concept, hint, w } from '../theme/words.js';
import { HeroSprite } from './HeroSprite.js';

const OUTCOME: Record<BattleOutcome, Concept> = { victory: 'victory', retreat: 'retreat', ko: 'defeat' };
const POSE: Record<BattleOutcome, HeroState> = { victory: 'victory', retreat: 'resting', ko: 'ko' };

function Row({ concept, children }: { concept: Concept; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-0.5">
      <span title={hint(concept)} className="w-28 shrink-0 text-neutral-500">
        {w(concept)}
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

/** Up to eight files, then how many more: the full list is in the side panel's Loot. */
function Loot({ files }: { files: string[] }) {
  if (files.length === 0) return <>none</>;
  const shown = files.slice(0, 8);
  return (
    <>
      {shown.map((file) => (
        <span key={file} className="mr-2 inline-block font-mono">
          {file}
        </span>
      ))}
      {files.length > shown.length && <span className="text-neutral-500">+{files.length - shown.length} more</span>}
    </>
  );
}

function Heroes({ types, manifest }: { types: string[]; manifest?: HeroManifest }) {
  if (types.length === 0) return <>none</>;
  return (
    <span className="inline-flex flex-wrap gap-2">
      {types.map((type, i) => {
        const classId = manifest ? matchClass(manifest, type) : undefined;
        return (
          <span key={`${type}-${i}`} className="inline-flex items-center gap-1">
            {manifest && classId && (
              <HeroSprite manifest={manifest} classId={classId} state="victory" size={20} decorative />
            )}
            <span>{type || 'agent'}</span>
            {manifest && classId && <span className="text-neutral-500">({manifest.classes[classId]?.name})</span>}
          </span>
        );
      })}
    </span>
  );
}

function Details({ result, manifest }: { result: BattleResult; manifest?: HeroManifest }) {
  const t = result.tokens;
  return (
    <div className="mt-1 text-xs">
      <Row concept="workingTime">{duration(result.durationMs)}</Row>
      <Row concept="gold">{money(result.costUsd)}</Row>
      <Row concept="tokens">
        {tokens(t.input)} in · {tokens(t.output)} out · {tokens(t.cacheRead)} cached
      </Row>
      {result.mpUsedPct !== undefined && <Row concept="mp">{result.mpUsedPct}% used</Row>}
      <Row concept="loot">
        <Loot files={result.loot} />
      </Row>
      <Row concept="heroes">
        <Heroes types={result.heroes} manifest={manifest} />
      </Row>
      <Row concept="sideQuests">{result.sideQuests}</Row>
    </div>
  );
}

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/**
 * Battle results (docs/THEME.md): a one-line, folded card under each turn's result, and an open summary when the
 * Quest closes, with the party leader's victory pose when the art pack is loaded. The latest turn of a Quest between
 * turns shows open, so the chat ends on how the turn went, and says the Quest goes on: only the closing summary may
 * read as an ending.
 */
export function BattleCard({
  result,
  kind,
  manifest,
  latest = false,
}: {
  result: BattleResult;
  kind: 'turn' | 'quest';
  manifest?: HeroManifest;
  /** The Quest's latest turn, with nothing after it yet. */
  latest?: boolean;
}) {
  if (kind === 'turn' && latest) {
    const won = result.outcome === 'victory';
    return (
      <section
        aria-label={w(OUTCOME[result.outcome])}
        className={`cb-battle rounded border p-3 ${
          won
            ? 'border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900'
            : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950'
        }`}
      >
        <details open>
          <summary className="flex cursor-pointer select-none items-center gap-3">
            {manifest && (
              <HeroSprite manifest={manifest} classId={manifest.leader} state={POSE[result.outcome]} size={32} />
            )}
            <span>
              <span
                title={hint(OUTCOME[result.outcome])}
                className={`cb-display block text-lg leading-none ${won ? '' : 'text-amber-700 dark:text-amber-400'}`}
              >
                {w(OUTCOME[result.outcome])}
              </span>
              <span className="block text-xs text-neutral-500">
                {duration(result.durationMs)} · {money(result.costUsd)} · {files(result.loot.length)}
              </span>
              <span title={hint('questGoesOn')} className="block text-xs text-neutral-500">
                {w('questGoesOn')}
              </span>
            </span>
          </summary>
          <Details result={result} manifest={manifest} />
        </details>
      </section>
    );
  }
  if (kind === 'turn') {
    const tone = result.outcome === 'victory' ? 'text-neutral-500' : 'text-amber-700 dark:text-amber-400';
    return (
      <details className={`cb-battle text-xs ${tone}`}>
        <summary title={hint(OUTCOME[result.outcome])} className="cursor-pointer select-none">
          <span className="cb-display text-sm">{w(OUTCOME[result.outcome])}</span> · {duration(result.durationMs)} ·{' '}
          {money(result.costUsd)} · {files(result.loot.length)}
        </summary>
        <div className="text-neutral-700 dark:text-neutral-300">
          <Details result={result} manifest={manifest} />
        </div>
      </details>
    );
  }
  return (
    <section
      aria-label={w('questComplete')}
      className="rounded border-2 border-neutral-400 bg-neutral-50 p-3 dark:border-neutral-600 dark:bg-neutral-900"
    >
      <div className="flex items-center gap-3">
        {manifest && <HeroSprite manifest={manifest} classId={manifest.leader} state="victory" size={48} />}
        <div>
          <h3 title={hint('questComplete')} className="cb-display text-xl leading-none">
            {w('questComplete')}
          </h3>
          <div className="text-xs text-neutral-500">
            {result.turns} {w('turns').toLowerCase()} · {files(result.loot.length)}
          </div>
        </div>
      </div>
      <Details result={result} manifest={manifest} />
    </section>
  );
}
