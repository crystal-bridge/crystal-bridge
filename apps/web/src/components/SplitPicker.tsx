import { useEffect, useRef, useContext } from 'react';
import type { KingdomLook } from '../appearance.js';
import { type HeroManifest, type HeroState, LeaderContext } from '../heroes.js';
import { hint, w } from '../theme/words.js';
import { HeroSprite } from './HeroSprite.js';
import { KingdomIcon } from './KingdomIcon.js';

export interface SplitCandidate {
  id: string;
  label: string;
  /** This device's name for the Quest's Kingdom. */
  kingdom: string;
  /** The Quest's project; left out for a Discreet Kingdom. */
  project?: string;
  look: KingdomLook;
  state?: HeroState;
}

export interface SplitPickerProps {
  candidates: SplitCandidate[];
  /** With the art pack loaded: each Quest's party leader in its state. */
  heroes?: HeroManifest;
  onPick: (session: string) => void;
  onCancel: () => void;
}

/** Picks the Quest for the second pane of Split View, from any Kingdom this device shows. */
export function SplitPicker({ candidates, heroes, onPick, onCancel }: SplitPickerProps) {
  const leaderOf = useContext(LeaderContext);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.querySelector('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 pt-24" onClick={onCancel}>
      <div
        ref={dialog}
        role="dialog"
        aria-label={w('splitView')}
        title={hint('splitView')}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
          <h2 className="cb-display text-xl">{w('splitView')}</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="rounded px-2 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800"
          >
            ×
          </button>
        </div>
        {candidates.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-500">{`No other active ${w('quests')} to show beside this one.`}</p>
        ) : (
          <ul className="max-h-96 overflow-y-auto py-1">
            {candidates.map((quest) => (
              <li key={quest.id}>
                <button
                  type="button"
                  onClick={() => onPick(quest.id)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <KingdomIcon icon={quest.look.icon} colour={quest.look.colour} size={20} />
                  {heroes && quest.state && (
                    <HeroSprite
                      manifest={heroes}
                      classId={leaderOf(quest.id) ?? heroes.leader}
                      state={quest.state}
                      size={24}
                      decorative
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{quest.label}</span>
                    <span className="flex gap-2 text-xs text-neutral-500">
                      <span className="truncate">{quest.kingdom}</span>
                      {quest.project && (
                        <span data-project className="truncate font-mono">
                          {quest.project}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
