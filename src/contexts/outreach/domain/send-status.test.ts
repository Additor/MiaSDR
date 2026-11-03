import { describe, expect, it } from "vitest";
import { SEND_FROM, SEND_STATUSES } from "./send-status";

const ALL = SEND_STATUSES;
const exitsOf = (from: (typeof ALL)[number]) => ALL.filter((to) => SEND_FROM[to].includes(from));

describe("send status transitions", () => {
  it("never leaves sent", () => {
    expect(exitsOf("sent")).toEqual([]);
  });

  it("lets a failed row back to sending only through the reclaim", () => {
    expect(exitsOf("failed")).toEqual(["sending"]);
    expect(SEND_FROM.sending).toEqual(["failed"]);
  });

  it("lets unknown move only to sent or failed", () => {
    expect(exitsOf("unknown").sort()).toEqual(["failed", "sent"]);
  });
});
