import { describe, expect, it } from "vitest";
import { humanizeToken } from "./humanize";

describe("humanizeToken", () => {
  it("turns snake, kebab and camel case into sentence case", () => {
    expect(humanizeToken("do_not_contact")).toBe("Do not contact");
    expect(humanizeToken("needs-review")).toBe("Needs review");
    expect(humanizeToken("replyReceived")).toBe("Reply received");
    expect(humanizeToken("sent")).toBe("Sent");
  });

  it("joins comma lists with a comma and a space", () => {
    expect(humanizeToken("email,linkedin")).toBe("Email, Linkedin");
    expect(humanizeToken("do_not_contact, needs_review")).toBe("Do not contact, Needs review");
  });

  it("handles empty input", () => {
    expect(humanizeToken("")).toBe("");
    expect(humanizeToken(" , ")).toBe("");
  });
});
