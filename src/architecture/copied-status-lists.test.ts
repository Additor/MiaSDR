import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ATTEMPT_COUNTED } from "@/contexts/conversations/domain/send-attempt-status";

const SRC = path.resolve(__dirname, "..");

describe("status lists a lower context copies", () => {
  it("counts the same send attempts in the LinkedIn daily limit as conversations does", () => {
    // Outreach sits below conversations, so its store holds a copy of the list.
    const store = readFileSync(path.join(SRC, "contexts/outreach/linkedin/infrastructure/drizzle-linkedin-account-store.ts"), "utf8");
    const copy = store.match(/ATTEMPT_COUNTED of conversations[^\n]*\n\s*inArray\(sendAttempts\.status, (\[[^\]]*\])\)/)?.[1];
    expect(copy).toBeDefined();
    expect(JSON.parse(copy as string)).toEqual([...ATTEMPT_COUNTED]);
  });
});
