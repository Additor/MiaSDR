/**
 * The plain form controls a Filters popover edits, as much of them as the draft helpers read and write. The pickers
 * (`SelectField`, `DateRangeField`) keep their value in React and reset through `useDraftValue`.
 */
export interface DraftControl {
  type: string;
  value: string;
  defaultValue?: string;
  checked?: boolean;
  defaultChecked?: boolean;
}

const isCheck = (c: DraftControl) => c.type === "radio" || c.type === "checkbox";

/** Puts each control back to the value the page rendered, so a closed popover sends only the filters in force. */
export function restoreDraft(controls: Iterable<DraftControl>): void {
  for (const c of controls) {
    if (c.type === "hidden") continue;
    if (isCheck(c)) c.checked = c.defaultChecked ?? false;
    else c.value = c.defaultValue ?? "";
  }
}

/** Empties the draft: a radio group takes the choice whose value is empty, a checkbox clears and a text field empties. */
export function emptyDraft(controls: Iterable<DraftControl>): void {
  for (const c of controls) {
    if (c.type === "hidden") continue;
    if (c.type === "radio") c.checked = c.value === "";
    else if (c.type === "checkbox") c.checked = false;
    else c.value = "";
  }
}
