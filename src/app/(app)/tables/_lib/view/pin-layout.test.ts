import { describe, expect, it } from "vitest";
import { layoutPins, pinPhoneNotice, withPin } from "./pin-layout";

const cols = ["a", "b", "c", "d", "e"].map((key) => ({ key }));

describe("layoutPins", () => {
  it("moves pinned columns to the front in pin order and counts them", () => {
    const layout = layoutPins(cols, ["d", "b"]);
    expect(layout.columns.map((c) => c.key)).toEqual(["d", "b", "a", "c", "e"]);
    expect(layout.pinned).toBe(2);
  });

  it("ignores a pin on a column that is hidden or gone, and a repeat", () => {
    const layout = layoutPins(cols, ["gone", "c", "c"]);
    expect(layout.columns.map((c) => c.key)).toEqual(["c", "a", "b", "d", "e"]);
    expect(layout.pinned).toBe(1);
  });

  it("keeps at most three pins", () => {
    expect(layoutPins(cols, ["a", "b", "c", "d"]).pinned).toBe(3);
  });

  it("leaves the order alone when pinning is off (phone width) or nothing is pinned", () => {
    expect(layoutPins(cols, ["d"], false)).toEqual({ columns: cols, pinned: 0 });
    expect(layoutPins(cols, undefined)).toEqual({ columns: cols, pinned: 0 });
    expect(layoutPins(cols, [])).toEqual({ columns: cols, pinned: 0 });
  });
});


describe("withPin", () => {
  it("appends a pin, once, up to three", () => {
    let view = withPin({}, "a", true);
    view = withPin(view, "a", true);
    view = withPin(view, "b", true);
    view = withPin(view, "c", true);
    view = withPin(view, "d", true);
    expect(view.pinnedColumns).toEqual(["a", "b", "c"]);
  });
  it("removes a pin and keeps an explicit empty list, which unpins the default for this member", () => {
    expect(withPin({ pinnedColumns: ["a"] }, "a", false).pinnedColumns).toEqual([]);
  });
  it("keeps the other view fields", () => {
    expect(withPin({ hiddenColumns: ["x"] }, "a", true)).toEqual({ hiddenColumns: ["x"], pinnedColumns: ["a"] });
  });
});

describe("pinPhoneNotice", () => {
  it("explains a pin made at phone width, where pins are not drawn", () => {
    expect(pinPhoneNotice(true, true)).toMatch(/not pinned on a phone/i);
    expect(pinPhoneNotice(true, false)).toMatch(/not pinned on a phone/i);
  });

  it("stays silent when pins are drawn", () => {
    expect(pinPhoneNotice(false, true)).toBeNull();
    expect(pinPhoneNotice(false, false)).toBeNull();
  });
});
