"use client";

/*
 * Unsaved edits in the reply editor, kept across the thread's own controls. A category change, Done or Stop contacting retires
 * the open draft, and the editor then shows the saved text of the out-of-date draft. Those controls call `saveDraftEdits` first,
 * so what was typed survives as that draft's text and "Edit and send anyway" carries it on. One editor exists per thread page.
 */

type Save = () => Promise<string | null>;

let current: Save | null = null;

/** The reply editor hands over how to save its edits. Returns the cleanup for its effect. */
export function registerDraftEdits(save: Save): () => void {
  current = save;
  return () => {
    if (current === save) current = null;
  };
}

/** Saves the reply editor's unsaved edits, if there are any. Resolves to the error text when the save failed, else null. */
export async function saveDraftEdits(): Promise<string | null> {
  return current ? current() : null;
}
