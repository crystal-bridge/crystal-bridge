import { useId } from 'react';
import { Icon, type IconName } from '../theme/icons.js';

export interface LayoutOption<M extends string> {
  mode: M;
  label: string;
  icon: IconName;
  hint: string;
}

/**
 * A switch between a view's layouts: native radios, so arrow keys move between them. The chosen one is a neutral
 * shade, never blue, which only means "needs you".
 */
export function LayoutSwitch<M extends string>({
  mode,
  onMode,
  options,
}: {
  mode: M;
  onMode: (mode: M) => void;
  options: readonly LayoutOption<M>[];
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label="Layout"
      className="inline-flex rounded-md border border-(--prompt-border) bg-(--prompt-bg) p-0.5"
    >
      {options.map((layout) => (
        <label
          key={layout.mode}
          title={layout.hint}
          className="cb-display flex cursor-pointer items-center gap-1.5 rounded px-2.5 py-1 text-lg leading-6 text-(--prompt-muted) hover:text-(--prompt-ink) has-checked:bg-white has-checked:text-neutral-950 has-checked:shadow-sm has-checked:ring-1 has-checked:ring-neutral-300 dark:has-checked:bg-neutral-700 dark:has-checked:text-white dark:has-checked:ring-neutral-600 has-focus-visible:ring-2 has-focus-visible:ring-sky-500"
        >
          <input
            type="radio"
            name={name}
            value={layout.mode}
            checked={mode === layout.mode}
            onChange={() => onMode(layout.mode)}
            className="sr-only"
          />
          <Icon name={layout.icon} size={16} />
          {layout.label}
        </label>
      ))}
    </div>
  );
}
