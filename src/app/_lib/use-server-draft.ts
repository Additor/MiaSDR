"use client";

import { useState } from "react";

/**
 * A form's text on top of what the server last said. `useState(saved)` reads the server once, so a value that changed since,
 * by a save, a colleague or an agent, shows as this person's unsaved change and Save writes the old value back.
 *
 * With no edits the draft follows the server. With edits it keeps them and sets `baseChanged`, so the form can say so.
 * Call `adoptNext` when a save succeeds: the server may have trimmed the text, and its copy is the one to keep.
 */
export function useServerDraft<T>(saved: T) {
  const savedKey = JSON.stringify(saved);
  const [seen, setSeen] = useState(savedKey);
  const [value, setValue] = useState(saved);
  const [baseChanged, setBaseChanged] = useState(false);
  const [adopting, setAdopting] = useState(false);
  if (savedKey !== seen) {
    setSeen(savedKey);
    const valueKey = JSON.stringify(value);
    if (adopting || valueKey === seen) {
      setValue(saved);
      setBaseChanged(false);
    } else if (valueKey !== savedKey) setBaseChanged(true);
    setAdopting(false);
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
    adoptNext: () => setAdopting(true),
  };
}
