/** Keyboard shortcuts of the grid that are plain functions of the key event, so tests need no browser. */

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type HistoryKey = "undo" | "redo";

/**
 * Ctrl or Cmd with Z undoes, with Shift redoes. Ctrl or Cmd with Y redoes. Alt anywhere cancels the match so
 * layouts that type a letter with Alt (AltGr) keep working.
 */
export function historyKey(e: KeyLike): HistoryKey | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && !e.shiftKey) return "redo";
  return null;
}
