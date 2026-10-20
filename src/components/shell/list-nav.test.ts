import { describe, expect, it } from "vitest";
import { isTypingTarget, listKeyAction, moveActive } from "./list-nav";

describe("list keyboard", () => {
  it("maps j, k and Enter on the page body", () => {
    expect(listKeyAction({ key: "j" }, { tagName: "BODY" })).toBe("next");
    expect(listKeyAction({ key: "k" }, null)).toBe("prev");
    expect(listKeyAction({ key: "Enter" }, { tagName: "BODY" })).toBe("open");
    expect(listKeyAction({ key: "x" }, null)).toBeNull();
  });

  it("ignores keys typed into fields", () => {
    for (const tagName of ["INPUT", "textarea", "SELECT"]) expect(listKeyAction({ key: "j" }, { tagName })).toBeNull();
    expect(listKeyAction({ key: "k" }, { tagName: "DIV", isContentEditable: true })).toBeNull();
    expect(isTypingTarget({ tagName: "A" })).toBe(false);
  });

  it("ignores keys held with a modifier", () => {
    expect(listKeyAction({ key: "j", metaKey: true }, null)).toBeNull();
    expect(listKeyAction({ key: "j", ctrlKey: true }, null)).toBeNull();
    expect(listKeyAction({ key: "k", altKey: true }, null)).toBeNull();
    expect(listKeyAction({ key: "J", shiftKey: true }, null)).toBeNull();
  });

  it("leaves Enter to links and buttons", () => {
    expect(listKeyAction({ key: "Enter" }, { tagName: "A" })).toBeNull();
    expect(listKeyAction({ key: "Enter" }, { tagName: "button" })).toBeNull();
    expect(listKeyAction({ key: "j" }, { tagName: "A" })).toBe("next");
  });

  it("moves the focus row and stops at the ends", () => {
    expect(moveActive(-1, 5, "next")).toBe(0);
    expect(moveActive(-1, 5, "prev")).toBe(0);
    expect(moveActive(0, 5, "next")).toBe(1);
    expect(moveActive(4, 5, "next")).toBe(4);
    expect(moveActive(0, 5, "prev")).toBe(0);
    expect(moveActive(3, 5, "prev")).toBe(2);
    expect(moveActive(9, 5, "next")).toBe(0);
    expect(moveActive(0, 0, "next")).toBe(-1);
  });
});
