import { describe, expect, it } from "vitest";
import { canMoveSend, SEND_FINAL, SEND_FROM, type SendStatus } from "./send-status";

const ALL: SendStatus[] = ["sending", "sent", "failed", "unknown"];

describe("send status transitions", () => {
  it("never leaves a final status", () => {
    for (const from of SEND_FINAL) for (const to of ALL) expect(canMoveSend(from, to)).toBe(false);
  });

  it("lets unknown move only to sent or failed", () => {
    expect(ALL.filter((to) => canMoveSend("unknown", to)).sort()).toEqual(["failed", "sent"]);
  });

  it("never re-enters sending", () => {
    expect(SEND_FROM.sending).toEqual([]);
  });
});
