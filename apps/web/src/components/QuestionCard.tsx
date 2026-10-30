import { useState } from 'react';

interface Option {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: Option[];
  multiSelect?: boolean;
}

export interface QuestionCardProps {
  /** AskUserQuestion's input, as the CLI sent it through the permission tool. */
  input: unknown;
  pending: boolean;
  behavior?: 'allow' | 'deny' | undefined;
  /** Allow carries the answers keyed by question text; deny skips the questions. */
  onAnswer: (behavior: 'allow' | 'deny', answers?: Record<string, string>) => void;
}

function questionsOf(input: unknown): Question[] {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((q): q is Question => typeof q?.question === 'string' && Array.isArray(q.options));
}

/** A question Claude asked (AskUserQuestion), answered with its options or a typed answer. */
export function QuestionCard({ input, pending, behavior, onAnswer }: QuestionCardProps) {
  const questions = questionsOf(input);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  function answerFor(q: Question): string {
    const other = typed[q.question]?.trim();
    return other || (picked[q.question] ?? []).join(', ');
  }

  function toggle(q: Question, label: string) {
    setPicked((prev) => {
      const current = prev[q.question] ?? [];
      const next = q.multiSelect
        ? current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
        : [label];
      return { ...prev, [q.question]: next };
    });
    setTyped((prev) => ({ ...prev, [q.question]: '' }));
  }

  const complete = questions.length > 0 && questions.every((q) => answerFor(q) !== '');
  const button = 'rounded px-3 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="cb-window space-y-3 p-3">
      {questions.map((q) => (
        <fieldset key={q.question} className="space-y-1.5">
          <legend className="text-sm font-medium">
            {q.header && <span className="mr-2 text-xs uppercase text-gold-bright">{q.header}</span>}
            {q.question}
          </legend>
          <div className="flex flex-wrap gap-2">
            {q.options.map((option) => {
              const on = (picked[q.question] ?? []).includes(option.label) && !typed[q.question]?.trim();
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={on}
                  disabled={!pending}
                  onClick={() => toggle(q, option.label)}
                  className={`${button} border text-left ${
                    on
                      ? 'border-gold-bright bg-gold-bright text-neutral-950'
                      : 'border-neutral-300 bg-white text-neutral-800 hover:enabled:border-gold-bright dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200'
                  }`}
                >
                  <span className="block">{option.label}</span>
                  {option.description && <span className="block text-xs opacity-75">{option.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            placeholder="Other…"
            disabled={!pending}
            value={typed[q.question] ?? ''}
            onChange={(e) => setTyped((prev) => ({ ...prev, [q.question]: e.target.value }))}
            className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </fieldset>
      ))}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!pending || !complete}
          onClick={() => onAnswer('allow', Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])))}
          className={`${button} bg-gold-bright text-neutral-950 hover:enabled:bg-gold`}
        >
          Answer
        </button>
        <button
          type="button"
          disabled={!pending}
          onClick={() => onAnswer('deny')}
          className={`${button} bg-neutral-500 text-white hover:enabled:bg-neutral-600`}
        >
          Skip
        </button>
        {behavior && <span className="text-sm text-white/75">{behavior === 'allow' ? 'Answered' : 'Skipped'}</span>}
      </div>
    </div>
  );
}
