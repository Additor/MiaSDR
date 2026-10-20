import { MAX_PINNED_COLUMNS, type TableView } from "@/contexts/grid/domain/view-query";

/**
 * Pinned columns lead the grid and stay in view while the rest scroll sideways. Reordering happens before the
 * columns reach the grid, so the keyboard, the selection and copy all walk the order the person sees.
 */

export interface PinLayout<T> {
  /** Pinned columns first, in the order they were pinned, then the rest in table order. */
  columns: T[];
  /** How many of the leading columns are pinned. */
  pinned: number;
}

/**
 * `visible` is the columns the grid shows (hidden ones already removed). A pin on a hidden or deleted column
 * is ignored here. With `enabled` false (phone width) the order stays as it is.
 */
export function layoutPins<T extends { key: string }>(visible: readonly T[], pinnedKeys: readonly string[] | undefined, enabled = true): PinLayout<T> {
  if (!enabled || !pinnedKeys || pinnedKeys.length === 0) return { columns: [...visible], pinned: 0 };
  const byKey = new Map(visible.map((c) => [c.key, c]));
  const lead: T[] = [];
  for (const key of pinnedKeys) {
    const column = byKey.get(key);
    if (column && !lead.includes(column)) lead.push(column);
    if (lead.length === MAX_PINNED_COLUMNS) break;
  }
  const rest = visible.filter((c) => !lead.includes(c));
  return { columns: [...lead, ...rest], pinned: lead.length };
}

/**
 * The message for a pin or unpin made at phone width, where the grid ignores pins (see `layoutPins`). The pin is still
 * saved with the member's view, so it shows on a wider screen. Null when pins are drawn, so no message is needed.
 */
export function pinPhoneNotice(phone: boolean, pin: boolean): string | null {
  if (!phone) return null;
  return pin ? "Pinned for wider screens. Columns are not pinned on a phone." : "Unpinned. Columns are not pinned on a phone.";
}

/** The view with `key` pinned or unpinned. Pinning past the limit, or twice, changes nothing. */
export function withPin(view: TableView, key: string, pin: boolean): TableView {
  const current = view.pinnedColumns ?? [];
  if (pin) return current.includes(key) || current.length >= MAX_PINNED_COLUMNS ? view : { ...view, pinnedColumns: [...current, key] };
  return { ...view, pinnedColumns: current.filter((k) => k !== key) };
}
