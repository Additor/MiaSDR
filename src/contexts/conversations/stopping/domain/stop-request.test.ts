import { describe, expect, it } from "vitest";
import { detectsStopRequest } from "./stop-request";
import { STOP_REQUEST_FIXTURES } from "./stop-request.fixtures";

describe.each(STOP_REQUEST_FIXTURES)("stop requests in $language", ({ asks, ordinary }) => {
  it.each(asks)("finds %s", (text) => {
    expect(detectsStopRequest(text)).toBe(true);
  });
  it.each(ordinary)("leaves %s alone", (text) => {
    expect(detectsStopRequest(text)).toBe(false);
  });
});

describe("the reading of a stop request", () => {
  it("reads Korean spelled in decomposed jamo", () => {
    expect(detectsStopRequest("수신 거부".normalize("NFD"))).toBe(true);
  });

  it("reads only the sender's own words", () => {
    expect(detectsStopRequest("좋습니다, 화요일에 뵙겠습니다.\n> 수신 거부\n> Bitte abbestellen")).toBe(false);
  });
});
