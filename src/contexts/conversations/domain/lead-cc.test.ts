import { describe, expect, it } from "vitest";
import { inboundCcCandidates, normalizeCcList, MAX_REPLY_CC, validateReplyCc } from "./lead-cc";

describe("inboundCcCandidates", () => {
  it("lowercases, dedupes and drops lead, mailbox, sender and junk", () => {
    expect(
      inboundCcCandidates(["Boss@X.com", "boss@x.com", "LEAD@x.com", "me@us.com", "peer@x.com", "nope", "sender@x.com"], {
        mailbox: "ME@us.com",
        lead: "lead@x.com",
        sender: "Sender@x.com",
      }),
    ).toEqual(["boss@x.com", "peer@x.com"]);
  });
});

describe("validateReplyCc", () => {
  const ctx = { known: ["a@x.com", "b@x.com"], mailbox: "me@us.com", lead: "lead@x.com" };
  it("accepts remembered addresses, normalized and unique", () => {
    expect(validateReplyCc(["A@x.com", "a@x.com", "b@x.com"], ctx)).toEqual({ ok: true, cc: ["a@x.com", "b@x.com"] });
  });
  it("accepts an empty list", () => {
    expect(validateReplyCc([], ctx)).toEqual({ ok: true, cc: [] });
  });
  it("refuses an address never seen on the thread", () => {
    expect(validateReplyCc(["z@x.com"], ctx)).toEqual({ ok: false, error: { code: "unknown", email: "z@x.com" } });
  });
  it("refuses the lead and our mailbox", () => {
    expect(validateReplyCc(["lead@x.com"], ctx)).toMatchObject({ ok: false, error: { code: "excluded" } });
    expect(validateReplyCc(["ME@us.com"], ctx)).toMatchObject({ ok: false, error: { code: "excluded" } });
  });
  it("refuses malformed addresses", () => {
    expect(validateReplyCc(["bad"], ctx)).toMatchObject({ ok: false, error: { code: "invalid" } });
  });
  it("caps the list", () => {
    const known = Array.from({ length: MAX_REPLY_CC + 1 }, (_, i) => `p${i}@x.com`);
    expect(validateReplyCc(known, { ...ctx, known })).toEqual({ ok: false, error: { code: "too_many" } });
  });
});

describe("normalizeCcList", () => {
  it("lowercases, dedupes and drops invalid entries without excluding anyone", () => {
    expect(normalizeCcList(["A@x.com", "a@x.com", "me@us.com", "bad"])).toEqual(["a@x.com", "me@us.com"]);
  });
});
