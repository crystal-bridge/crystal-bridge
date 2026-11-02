import {
  cloneElement,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  useId,
  useState,
} from 'react';

export interface TipProps {
  text: string;
  /** Which edge of the anchor the tooltip lines up with; `end` keeps it on screen at the right edge. */
  align?: 'start' | 'center' | 'end';
  /** Classes for the wrapper, which takes the anchor's place in the layout (display, responsive visibility). */
  className?: string;
  /**
   * Opens beside the anchor, fixed to the screen, for an anchor inside a scrolling panel, which would clip a tooltip
   * below it. `align` doesn't apply.
   */
  beside?: boolean;
  children: ReactElement<{ 'aria-describedby'?: string }>;
}

/** Pixels between an anchor and a tooltip beside it. */
const GAP = 8;

/**
 * A themed tooltip in place of the browser's `title`: it shows on hover or keyboard focus after a short delay (the
 * look is `.cb-tip` in theme.css), and describes its anchor through aria-describedby.
 */
export function Tip({ text, align = 'center', className = 'inline-flex', beside = false, children }: TipProps) {
  const id = useId();
  const [place, setPlace] = useState<CSSProperties>();
  // Screen coordinates are only good for this hover, so they're taken as it starts. In the lower half it opens upward.
  const measure = (anchor: HTMLElement) => {
    const { top, bottom, right } = anchor.getBoundingClientRect();
    const height = window.innerHeight;
    setPlace(top > height / 2 ? { left: right + GAP, bottom: height - bottom } : { left: right + GAP, top });
  };
  const measuring = beside
    ? {
        onPointerEnter: (event: PointerEvent<HTMLElement>) => measure(event.currentTarget),
        onFocus: (event: FocusEvent<HTMLElement>) => measure(event.currentTarget),
      }
    : {};
  return (
    <span className={`cb-tip-anchor ${className}`} {...measuring}>
      {cloneElement(children, { 'aria-describedby': id })}
      <span
        id={id}
        role="tooltip"
        data-align={align}
        {...(beside ? { 'data-beside': '' } : {})}
        style={place}
        className="cb-tip"
      >
        {text}
      </span>
    </span>
  );
}
