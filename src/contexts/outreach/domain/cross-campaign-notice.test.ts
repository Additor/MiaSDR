import { describe, expect, it } from "vitest";
import { noticesSummary } from "./cross-campaign-notice";

describe("noticesSummary", () => {
  it("is null without notices", () => {
    expect(noticesSummary({ alreadyContactedPeople: 0, excludedByAccountPeople: 0 })).toBeNull();
  });
  it("counts people with the right grammar", () => {
    expect(noticesSummary({ alreadyContactedPeople: 1, excludedByAccountPeople: 0 })).toBe("1 person was already contacted in other campaigns.");
    expect(noticesSummary({ alreadyContactedPeople: 3, excludedByAccountPeople: 2 })).toBe(
      "3 people were already contacted in other campaigns, and 2 people are skipped because the sending account already invited them.",
    );
    expect(noticesSummary({ alreadyContactedPeople: 0, excludedByAccountPeople: 1 })).toBe("1 person is skipped because the sending account already invited them.");
  });
});
