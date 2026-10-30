import type { DragEvent, KeyboardEvent } from 'react';

/**
 * Tab order this device chose. Saved ids come first, in saved order; anything without a saved place (a new Kingdom, a
 * new Quest) keeps its default order after them, so new tabs append.
 */
export function applyOrder<T extends { id: string }>(items: readonly T[], order: readonly string[] | undefined): T[] {
  if (!order?.length) return [...items];
  const rank = new Map(order.map((id, index) => [id, index]));
  const placed = items.filter((item) => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...placed, ...items.filter((item) => !rank.has(item.id))];
}

/** The ids shown now, with `id` moved to `index` (clamped); the new order to save. */
export function moveTo(shown: readonly string[], id: string, index: number): string[] {
  const from = shown.indexOf(id);
  if (from === -1) return [...shown];
  const rest = shown.filter((other) => other !== id);
  const to = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, to), id, ...rest.slice(to)];
}

/** Drag-and-drop and Alt+Arrow handlers for one tab in a strip of `ids`, reporting moves as (id, new index). */
export function reorderHandlers(
  ids: readonly string[],
  id: string,
  onMove: ((id: string, index: number) => void) | undefined,
) {
  if (!onMove) return {};
  const index = ids.indexOf(id);
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData('text/x-cb-tab', id);
      event.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      const dragged = event.dataTransfer.getData('text/x-cb-tab');
      if (dragged && dragged !== id && ids.includes(dragged)) onMove(dragged, index);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      const to = index + (event.key === 'ArrowLeft' ? -1 : 1);
      if (to >= 0 && to < ids.length) onMove(id, to);
    },
  };
}
