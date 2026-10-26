/** The form controls a Filters popover edits, as much of them as the draft helpers read and write. */
export interface DraftControl {
  type: string;
  value: string;
  defaultValue?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  selectedIndex?: number;
  options?: ArrayLike<{ selected: boolean; defaultSelected: boolean }>;
}

const isSelect = (c: DraftControl) => c.type === "select-one" || c.type === "select-multiple";
const isCheck = (c: DraftControl) => c.type === "radio" || c.type === "checkbox";

/** Puts each control back to the value the page rendered, so a closed popover sends only the filters in force. */
export function restoreDraft(controls: Iterable<DraftControl>): void {
  for (const c of controls) {
    if (c.type === "hidden") continue;
    if (isSelect(c)) {
      for (const option of Array.from(c.options ?? [])) option.selected = option.defaultSelected;
    } else if (isCheck(c)) {
      c.checked = c.defaultChecked ?? false;
    } else {
      c.value = c.defaultValue ?? "";
    }
  }
}

/**
 * Empties the draft: a select takes its first option (Any, All, Leads), a radio group the choice whose value is empty,
 * a checkbox clears and a text or date field empties.
 */
export function emptyDraft(controls: Iterable<DraftControl>): void {
  for (const c of controls) {
    if (c.type === "hidden") continue;
    if (isSelect(c)) c.selectedIndex = 0;
    else if (c.type === "radio") c.checked = c.value === "";
    else if (c.type === "checkbox") c.checked = false;
    else c.value = "";
  }
}
