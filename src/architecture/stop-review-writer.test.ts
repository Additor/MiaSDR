import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";

/**
 * Only a person's review closes a stop request, and one function decides what counts: an agent's call writes nothing there
 * (`personReviewedStopsTx`). A second writer could take an agent's call for a review, as a pick's status once did.
 */
const ROOT = path.resolve(__dirname, "../..");
const WRITER = "src/contexts/conversations/infrastructure/stop-review.ts";

describe("stop_reviews", () => {
  it("has one writer", () => {
    const writers = sourceFiles(path.join(ROOT, "src"))
      .filter((file) => /insert\s+into\s+stop_reviews|\.insert\(stopReviews\)|\.update\(stopReviews\)|update\s+stop_reviews/i.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file));
    expect(writers).toEqual([WRITER]);
  });
});
