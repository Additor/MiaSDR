import { describe, expect, it } from "vitest";
import { addCounts, skipReasons, ZERO_COUNTS } from "./enroll-counts";

describe("enroll counts", () => {
  it("sums each chunk into the total, contacts included, and treats a missing count as zero", () => {
    const first = addCounts(ZERO_COUNTS, { requested: 500, added: 498, skippedContact: 2 });
    const total = addCounts(first, { requested: 10, added: 9, skippedContact: 1 });
    expect(total).toEqual({ ...ZERO_COUNTS, requested: 510, added: 507, skippedContact: 3 });
  });

  it("lists only the nonzero skip reasons, in dialog order", () => {
    const counts = { ...ZERO_COUNTS, requested: 9, skippedDuplicate: 1, skippedMissingIdentity: 2, skippedNotFound: 3 };
    expect(skipReasons(counts, "email")).toEqual(["1 already in the campaign", "2 without an email", "3 no longer exist"]);
    expect(skipReasons(ZERO_COUNTS, "email")).toEqual([]);
  });

  it("names the missing address after the campaign's channel", () => {
    expect(skipReasons({ ...ZERO_COUNTS, skippedMissingIdentity: 4 }, "linkedin")).toEqual(["4 without a LinkedIn URL"]);
  });

  it("points removed leads to the restore action on the campaign page", () => {
    expect(skipReasons({ ...ZERO_COUNTS, skippedRemoved: 2 }, "email")).toEqual(["2 removed earlier from this campaign; restore them from the campaign page"]);
  });

  it("counts contacts with singular and plural wording", () => {
    expect(skipReasons({ ...ZERO_COUNTS, skippedContact: 1 }, "email")).toEqual(["1 is a contact"]);
    expect(skipReasons({ ...ZERO_COUNTS, skippedContact: 3 }, "email")).toEqual(["3 are contacts"]);
  });
});
