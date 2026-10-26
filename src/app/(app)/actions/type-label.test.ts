import { describe, expect, it } from "vitest";
import { ambiguousTypeNames, typeLabel } from "./type-label";

describe("typeLabel", () => {
  const types = [
    { name: "Meeting requested", groupKey: "interested" },
    { name: "Unclear", groupKey: "other" },
    { name: "unclear", groupKey: "not_interested" },
  ];
  const ambiguous = ambiguousTypeNames(types);

  it("names the type alone unless another group uses the same name", () => {
    expect(typeLabel("Meeting requested", "interested", ambiguous)).toBe("Meeting requested");
    expect(typeLabel("Unclear", "other", ambiguous)).toBe("Unclear · Other");
  });

  it("falls back to the group, and to nothing without either", () => {
    expect(typeLabel(null, "interested", ambiguous)).toBe("Interested");
    expect(typeLabel(null, null, ambiguous)).toBeNull();
  });
});
