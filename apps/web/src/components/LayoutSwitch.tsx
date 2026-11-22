import { useId } from 'react';
import { Icon, type IconName } from '../theme/icons.js';

export interface LayoutOption<M extends string> {
  mode: M;
  label: string;
  icon: IconName;
  hint: string;
}

/** Each size's look for an option: the Board's banner size in the display face, or small sans text for a panel's header. */
const SIZES = {
  normal: { label: 'cb-display gap-1.5 px-2.5 py-1 text-lg leading-6', icon: 16 },
  compact: { label: 'gap-1 px-1.5 py-0.5 text-xs font-bold leading-5', icon: 14 },
} as const;

/**
 * A switch between a view's layouts: native radios, so arrow keys move between them. The chosen one is a neutral
 * shade, never blue, which only means "needs you". `compact` fits beside a panel's heading.
 */
export function LayoutSwitch<M extends string>({
  mode,
  onMode,
  options,
  size = 'normal',
}: {
  mode: M;
  onMode: (mode: M) => void;
  options: readonly LayoutOption<M>[];
  size?: keyof typeof SIZES;
}) {
  const name = useId();
  const look = SIZES[size];
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
          className={`${look.label} flex cursor-pointer items-center rounded text-(--prompt-muted) hover:text-(--prompt-ink) has-checked:bg-white has-checked:text-neutral-950 has-checked:shadow-sm has-checked:ring-1 has-checked:ring-neutral-300 dark:has-checked:bg-neutral-700 dark:has-checked:text-white dark:has-checked:ring-neutral-600 has-focus-visible:ring-2 has-focus-visible:ring-sky-500`}
        >
          <input
            type="radio"
            name={name}
            value={layout.mode}
            checked={mode === layout.mode}
            onChange={() => onMode(layout.mode)}
            className="sr-only"
          />
          <Icon name={layout.icon} size={look.icon} />
          {layout.label}
        </label>
      ))}
    </div>
  );
}
