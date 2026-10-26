"use client";

import { ListFilterIcon } from "lucide-react";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { emptyDraft, restoreDraft, type DraftControl } from "./filter-draft";
import { ToolbarPopover, ToolbarPopoverBody, ToolbarPopoverFooter } from "./toolbar-popover";

/**
 * The plain controls of the draft: text fields, checkboxes and radios. A picker keeps its value in React and posts it
 * through a hidden input, which these helpers skip; it follows `useDraftValue` instead.
 */
const controlsIn = (root: HTMLElement | null): DraftControl[] => (root ? Array.from(root.querySelectorAll<HTMLInputElement>("input:not([aria-hidden='true'])")) : []);

/** Counts each Reset and each discard, so the pickers in the popover start over from the right value. */
const Draft = createContext<{ epoch: number; mode: "restore" | "empty" }>({ epoch: 0, mode: "restore" });

/**
 * A picker's value in a Filters popover. It starts at `initial`, the value in force, and follows a new `initial` when the
 * page moves to another URL. Reset sets it to `empty`, and a discard (Escape, a click outside, the trigger) back to
 * `initial`.
 */
export function useDraftValue(initial: string, empty: string): [string, (value: string) => void] {
  const draft = useContext(Draft);
  const [state, setState] = useState({ value: initial, initial, epoch: draft.epoch });
  let current = state;
  if (state.initial !== initial || state.epoch !== draft.epoch) {
    current = { value: state.epoch !== draft.epoch && draft.mode === "empty" ? empty : initial, initial, epoch: draft.epoch };
    setState(current);
  }
  return [current.value, (value) => setState((s) => ({ ...s, value }))];
}

/**
 * A list's Filters: a `ToolbarPopover` of GET form fields. Apply submits the form, so the filters live in the URL.
 * Without `form` the fields join the form around the toolbar, which keeps them while the popover is closed, so Enter in
 * the search sends the filters in force. With `form` the popover holds a form of its own.
 */
export function FilterPopover({ count, form, children }: { count: number; form?: { action: string; label: string; hidden?: ReactNode }; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ epoch: number; mode: "restore" | "empty" }>({ epoch: 0, mode: "restore" });
  const inner = (
    <>
      <ToolbarPopoverBody ref={body}>{children}</ToolbarPopoverBody>
      <ToolbarPopoverFooter
        onReset={() => {
          emptyDraft(controlsIn(body.current));
          setDraft((d) => ({ epoch: d.epoch + 1, mode: "empty" }));
        }}
      />
    </>
  );
  return (
    <ToolbarPopover
      icon={ListFilterIcon}
      label="Filters"
      count={count}
      inline
      onDiscard={() => {
        restoreDraft(controlsIn(body.current));
        setDraft((d) => ({ epoch: d.epoch + 1, mode: "restore" }));
      }}
      testId="filters-toggle"
    >
      <Draft.Provider value={draft}>
        {form ? (
          <form action={form.action} method="get" aria-label={form.label} className="flex min-h-0 flex-1 flex-col">
            {form.hidden}
            {inner}
          </form>
        ) : (
          inner
        )}
      </Draft.Provider>
    </ToolbarPopover>
  );
}
