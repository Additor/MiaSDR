"use client";

import { useState } from "react";

/**
 * A form's text on top of what the server last said. `useState(saved)` reads the server once, so a value that changed since,
 * by a save, a colleague or an agent, shows as this person's unsaved change and Save writes the old value back.
 *
 * With no edits the draft follows the server. With edits it keeps them and sets `baseChanged`, so the form can say so.
 * Call `adoptNext` when a save succeeds: the server may have trimmed the text, and its copy is the one to keep. Until the
 * refresh brings that copy, `saved` still holds the old value, so `settling` says the text on screen is already stored and a
 * form leaves it out of `dirty`.
 */
export function useServerDraft<T>(saved: T) {
  const savedKey = JSON.stringify(saved);
  const [seen, setSeen] = useState(savedKey);
  const [value, setValue] = useState(saved);
  const [baseChanged, setBaseChanged] = useState(false);
  // The text a save sent, while it waits for its refresh. Text typed since then is a new edit, and the server's copy must not replace it.
  const [adopting, setAdopting] = useState<string | null>(null);
  if (savedKey !== seen) {
    setSeen(savedKey);
    const valueKey = JSON.stringify(value);
    // During a save, only the text it sent counts as unedited: typing the old value back right after a save is an edit.
    if (adopting !== null ? valueKey === adopting : valueKey === seen) {
      setValue(saved);
      setBaseChanged(false);
    } else if (adopting === null) setBaseChanged(valueKey !== savedKey);
    setAdopting(null);
  }
  return {
    value,
    setValue,
    baseChanged,
    /** Back to the server's copy. */
    discard: () => {
      setValue(saved);
      setBaseChanged(false);
    },
    adoptNext: () => setAdopting(JSON.stringify(value)),
    settling: adopting !== null && adopting === JSON.stringify(value),
  };
}
