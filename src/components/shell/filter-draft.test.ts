import { describe, expect, it } from "vitest";
import { emptyDraft, restoreDraft, type DraftControl } from "./filter-draft";

const select = (defaultIndex: number, selectedIndex: number) => {
  const options = [0, 1, 2].map((i) => ({ selected: i === selectedIndex, defaultSelected: i === defaultIndex }));
  return { type: "select-one", value: "", options, selectedIndex } satisfies DraftControl;
};

describe("restoreDraft", () => {
  it("puts selects, radios, checkboxes and fields back to what the page rendered", () => {
    const sel = select(1, 2);
    const yes = { type: "radio", value: "yes", checked: true, defaultChecked: false };
    const any = { type: "radio", value: "", checked: false, defaultChecked: true };
    const box = { type: "checkbox", value: "1", checked: true, defaultChecked: false };
    const date = { type: "date", value: "2026-01-02", defaultValue: "2026-01-01" };
    restoreDraft([sel, yes, any, box, date]);
    expect(sel.options.map((o) => o.selected)).toEqual([false, true, false]);
    expect([yes.checked, any.checked, box.checked]).toEqual([false, true, false]);
    expect(date.value).toBe("2026-01-01");
  });

  it("leaves hidden inputs alone, since they carry the page's other params", () => {
    const hidden = { type: "hidden", value: "mine", defaultValue: "" };
    restoreDraft([hidden]);
    expect(hidden.value).toBe("mine");
  });
});

describe("emptyDraft", () => {
  it("picks the first option, the empty radio, and clears checkboxes and fields", () => {
    const sel = select(2, 2);
    const yes = { type: "radio", value: "yes", checked: true };
    const any = { type: "radio", value: "", checked: false };
    const box = { type: "checkbox", value: "1", checked: true };
    const text = { type: "text", value: "ada" };
    const hidden = { type: "hidden", value: "mine" };
    emptyDraft([sel, yes, any, box, text, hidden]);
    expect(sel.selectedIndex).toBe(0);
    expect([yes.checked, any.checked, box.checked]).toEqual([false, true, false]);
    expect(text.value).toBe("");
    expect(hidden.value).toBe("mine");
  });
});
