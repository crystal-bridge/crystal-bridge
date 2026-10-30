import { type FormEvent, useState } from 'react';
import { w } from '../theme/words.js';
import { AddKingdom } from './AddKingdom.js';

const NEXT = 'rounded-md bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700';
const SKIP = 'rounded-md px-4 py-2 text-sm hover:bg-black/10';

/** What a new hub still needs after its first login. Both steps can wait: Config has them too. */
export function FirstRunSteps({
  onName,
  onCreateJoinCode,
  onDone,
}: {
  onName: (name: string) => Promise<void>;
  onCreateJoinCode: (node: string) => Promise<{ code: string; expiresAt: number }>;
  onDone: () => void;
}) {
  const [step, setStep] = useState<'name' | 'kingdom'>('name');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await onName(name);
      setStep('kingdom');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  if (step === 'name') {
    return (
      <form onSubmit={(event) => void submit(event)} className="w-full max-w-sm space-y-3">
        <h1 className="cb-display text-4xl leading-none">Name this hub</h1>
        <p className="text-sm">It shows in the app bar and the page title.</p>
        <input
          aria-label="Hub name"
          placeholder="Hub name"
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="cb-field w-full"
        />
        <div className="flex gap-2">
          <button type="submit" className={NEXT}>
            Next
          </button>
          <button type="button" onClick={() => setStep('kingdom')} className={SKIP}>
            Skip
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </form>
    );
  }
  return (
    <div className="w-full max-w-sm space-y-3">
      <h1 className="cb-display text-4xl leading-none">{`Add your first ${w('kingdom')}`}</h1>
      <p className="text-sm">{`A ${w('kingdom')} is a machine your ${w('quests')} run on. Name one, then run the command it gives you there.`}</p>
      <AddKingdom hub={window.location.origin} onCreate={onCreateJoinCode} />
      <button type="button" onClick={onDone} className={NEXT}>
        Finish
      </button>
    </div>
  );
}
