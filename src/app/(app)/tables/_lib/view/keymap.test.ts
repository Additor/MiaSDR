import { describe, expect, it } from "vitest";
import { historyKey, type KeyLike } from "./keymap";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

describe("historyKey", () => {
  it("undoes on Ctrl+Z and Cmd+Z", () => {
    expect(historyKey(key("z", { ctrlKey: true }))).toBe("undo");
    expect(historyKey(key("z", { metaKey: true }))).toBe("undo");
  });
  it("redoes on Shift+Ctrl+Z, Shift+Cmd+Z (uppercase key) and Ctrl+Y", () => {
    expect(historyKey(key("z", { ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(historyKey(key("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
    expect(historyKey(key("y", { ctrlKey: true }))).toBe("redo");
    expect(historyKey(key("y", { metaKey: true }))).toBe("redo");
  });
  it("ignores a bare letter, Shift+Ctrl+Y and Alt combinations", () => {
    expect(historyKey(key("z"))).toBeNull();
    expect(historyKey(key("y"))).toBeNull();
    expect(historyKey(key("y", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(historyKey(key("z", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(historyKey(key("c", { ctrlKey: true }))).toBeNull();
  });
});
