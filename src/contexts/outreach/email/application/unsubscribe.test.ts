import { describe, expect, it, vi } from "vitest";
import { createUnsubscribeToken } from "../domain/unsubscribe-token";
import { InvalidUnsubscribeToken, unsubscribeByToken } from "./unsubscribe";

const secret = "k".repeat(40);
const org = "33333333-3333-4333-8333-333333333333";

describe("unsubscribeByToken", () => {
  it("suppresses the address in the token's organization", async () => {
    const suppressEmail = vi.fn().mockResolvedValue({ stopped: 1 });
    const result = await unsubscribeByToken({ store: { suppressEmail }, secret }, createUnsubscribeToken(secret, org, "Ann@Acme.com"));
    expect(result).toEqual({ email: "ann@acme.com" });
    expect(suppressEmail).toHaveBeenCalledWith({ organizationId: org, email: "ann@acme.com", reason: "unsubscribed" });
  });

  it("refuses a forged token without touching the store", async () => {
    const suppressEmail = vi.fn();
    await expect(unsubscribeByToken({ store: { suppressEmail }, secret }, createUnsubscribeToken("z".repeat(40), org, "ann@acme.com"))).rejects.toBeInstanceOf(InvalidUnsubscribeToken);
    expect(suppressEmail).not.toHaveBeenCalled();
  });
});
