/**
 * Pure rules for the keyboard on the conversation list: j and k move a visible focus row, Enter opens it. The client
 * component feeds these functions; nothing here touches the DOM.
 */

export type ListKeyAction = "next" | "prev" | "open";

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
/** Elements that handle Enter themselves. The list must not also open a row. */
const ACTIVATING_TAGS = new Set(["A", "BUTTON", "SUMMARY"]);

/** True while the person types into a field, so a letter key stays a letter. */
export function isTypingTarget(target: TargetLike | null): boolean {
  if (!target) return false;
  return target.isContentEditable === true || TYPING_TAGS.has((target.tagName ?? "").toUpperCase());
}

/** Maps a key press to a list action, or null when the key is not ours. */
export function listKeyAction(event: KeyLike, target: TargetLike | null): ListKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (isTypingTarget(target)) return null;
  if (event.key === "j") return "next";
  if (event.key === "k") return "prev";
  if (event.key === "Enter") return ACTIVATING_TAGS.has((target?.tagName ?? "").toUpperCase()) ? null : "open";
  return null;
}

/** The next focus index: -1 means no row has focus yet, and both keys land on the first row. The ends do not wrap. */
export function moveActive(current: number, count: number, action: "next" | "prev"): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return 0;
  return action === "next" ? Math.min(count - 1, current + 1) : Math.max(0, current - 1);
}
