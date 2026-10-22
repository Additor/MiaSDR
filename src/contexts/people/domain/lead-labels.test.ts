import { describe, expect, it } from "vitest";
import { sourceLabel } from "./lead-labels";

describe("sourceLabel", () => {
  it("hides the import run id", () => {
    expect(sourceLabel("import:0b9c8a3e-1d2f-4a5b-8c7d-9e0f1a2b3c4d")).toBe("File import");
    expect(sourceLabel("import")).toBe("File import");
    expect(sourceLabel("grid")).toBe("Grid");
  });
});
