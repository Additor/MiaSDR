"use client";

/*
 * Unsaved edits in the reply editor, kept across the thread's own controls. A type change, Accept, Undo, Done or Stop
 * contacting retires the open draft, and the editor then shows the saved text of the out-of-date draft. Those controls call
 * `saveDraftEdits` first, so what was typed survives as that draft's text and "Edit and send anyway" carries it on. One
 * editor exists per thread page.
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

/** The refusal a control shows when the edits did not save. It sends nothing, so the edits stay in the editor. */
export const unsavedEditsError = (reason: string) => `Your draft edits were not saved, so nothing changed. ${reason}`;

/**
 * Saves the edits, then runs a step that retires the open draft. A failed save stops before the step and answers with the
 * refusal in the shape of `callApi`, so the caller shows it like any other error.
 */
export async function afterSavingEdits<T extends { ok: boolean; error: string | null }>(step: () => Promise<T>, save: () => Promise<string | null> = saveDraftEdits): Promise<T | { ok: false; status: 0; error: string; data: null; details: null }> {
  const unsaved = await save();
  if (unsaved) return { ok: false, status: 0, error: unsavedEditsError(unsaved), data: null, details: null };
  return step();
}
