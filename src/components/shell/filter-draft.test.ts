import { describe, expect, it } from "vitest";
import { emptyDraft, restoreDraft } from "./filter-draft";

describe("restoreDraft", () => {
  it("puts radios, checkboxes and fields back to what the page rendered", () => {
    const yes = { type: "radio", value: "yes", checked: true, defaultChecked: false };
    const any = { type: "radio", value: "", checked: false, defaultChecked: true };
    const box = { type: "checkbox", value: "1", checked: true, defaultChecked: false };
    const text = { type: "text", value: "ada", defaultValue: "bea" };
    restoreDraft([yes, any, box, text]);
    expect([yes.checked, any.checked, box.checked]).toEqual([false, true, false]);
    expect(text.value).toBe("bea");
  });

  it("leaves hidden inputs alone, since they carry the page's other params and the pickers' values", () => {
    const hidden = { type: "hidden", value: "mine", defaultValue: "" };
    restoreDraft([hidden]);
    expect(hidden.value).toBe("mine");
  });
});

describe("emptyDraft", () => {
  it("picks the empty radio, and clears checkboxes and fields", () => {
    const yes = { type: "radio", value: "yes", checked: true };
    const any = { type: "radio", value: "", checked: false };
    const box = { type: "checkbox", value: "1", checked: true };
    const text = { type: "text", value: "ada" };
    const hidden = { type: "hidden", value: "mine" };
    emptyDraft([yes, any, box, text, hidden]);
    expect([yes.checked, any.checked, box.checked]).toEqual([false, true, false]);
    expect(text.value).toBe("");
    expect(hidden.value).toBe("mine");
  });
});
