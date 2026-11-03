"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Which editors of one campaign hold unsaved edits. Start and Resume send what is saved, and the page's editors and its
 * controls are separate client trees under a server component, so they meet here. An editor with `save` lets Start save it.
 */
export interface UnsavedEdit {
  campaignId: string;
  label: string;
  save?: () => Promise<boolean>;
}

let edits: readonly UnsavedEdit[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly UnsavedEdit[]) => {
  edits = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const NONE: readonly UnsavedEdit[] = [];

/** Reports one editor's state. Its edit stays listed until it is saved, discarded or the editor leaves the page. */
export function useReportUnsaved(campaignId: string, label: string, dirty: boolean, save?: () => Promise<boolean>) {
  const latest = useRef(save);
  useEffect(() => {
    latest.current = save;
  });
  const hasSave = save !== undefined;
  useEffect(() => {
    if (!dirty) return;
    const edit: UnsavedEdit = { campaignId, label, save: hasSave ? () => latest.current?.() ?? Promise.resolve(false) : undefined };
    publish([...edits, edit]);
    return () => publish(edits.filter((e) => e !== edit));
  }, [campaignId, label, dirty, hasSave]);
}

export function useUnsavedEdits(campaignId?: string): readonly UnsavedEdit[] {
  const all = useSyncExternalStore(subscribe, () => edits, () => NONE);
  return campaignId ? all.filter((edit) => edit.campaignId === campaignId) : all;
}

/** "Steps" or "Steps and Senders", for a sentence about them. */
export const unsavedNames = (list: readonly UnsavedEdit[]): string => list.map((edit) => edit.label).join(" and ");
