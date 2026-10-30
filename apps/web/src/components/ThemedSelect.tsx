import { Icon, type IconName } from '../theme/icons.js';

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A select with the theme's face (an icon, the value in the display font, a chevron) over the browser's own select,
 * which stays on top, invisible, so clicks, keys and the phone's native picker all work as usual (docs/THEME.md).
 */
export function ThemedSelect({
  id,
  label,
  icon,
  value,
  options,
  onChange,
  title,
  disabled,
}: {
  id?: string;
  /** The accessible name; shown as the tooltip unless `title` says more. */
  label: string;
  icon?: IconName;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  title?: string;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <span className="cb-select" title={title ?? label} data-disabled={disabled ? 'true' : undefined}>
      {icon && <Icon name={icon} size={14} />}
      <span className="cb-select-value">{current || '…'}</span>
      <svg className="cb-select-chevron" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
      <select id={id} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}
