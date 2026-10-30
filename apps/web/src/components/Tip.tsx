import { cloneElement, useId, type ReactElement } from 'react';

export interface TipProps {
  text: string;
  /** Which edge of the anchor the tooltip lines up with; `end` keeps it on screen at the right edge. */
  align?: 'start' | 'center' | 'end';
  /** Classes for the wrapper, which takes the anchor's place in the layout (display, responsive visibility). */
  className?: string;
  children: ReactElement<{ 'aria-describedby'?: string }>;
}

/**
 * A themed tooltip in place of the browser's `title`: it shows on hover or keyboard focus after a short delay (the
 * look is `.cb-tip` in theme.css), and describes its anchor through aria-describedby.
 */
export function Tip({ text, align = 'center', className = 'inline-flex', children }: TipProps) {
  const id = useId();
  return (
    <span className={`cb-tip-anchor ${className}`}>
      {cloneElement(children, { 'aria-describedby': id })}
      <span id={id} role="tooltip" data-align={align} className="cb-tip">
        {text}
      </span>
    </span>
  );
}
