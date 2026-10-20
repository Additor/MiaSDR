import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUnipileStandin, type UnipileStandin } from "@/test-support/unipile-standin";
import { UnipileGateway } from "../unipile-gateway";

/** The real adapter against the local stand-in, which enforces the documented request rules. The stand-in is not Unipile. */
describe("hosted-auth link against the local stand-in", () => {
  let standin: UnipileStandin;
  let gateway: UnipileGateway;
  const link = { name: "mia-abc", expiresAt: new Date(Date.now() + 15 * 60_000), successRedirectUrl: "https://app.test/ok", failureRedirectUrl: "https://app.test/no", notifyUrl: "https://app.test/notify?link=1&secret=s" as string | null, reconnectAccount: null as string | null };

  beforeAll(async () => {
    standin = await startUnipileStandin({ apiKey: "k" });
    gateway = new UnipileGateway({ dsn: standin.dsn, apiKey: "k", scheme: "http" });
  });
  afterAll(async () => {
    await standin.close();
  });

  it("accepts a create link and a reconnect link for a known account", async () => {
    expect((await gateway.createHostedAuthLink(link)).url).toMatch(/^https:\/\//);
    const account = standin.addAccount();
    expect((await gateway.createHostedAuthLink({ ...link, notifyUrl: null, reconnectAccount: account.id })).url).toMatch(/^https:\/\//);
    expect(standin.calls("POST /api/v1/hosted/accounts/link")).toHaveLength(2);
  });

  it("refuses a reconnect for an unknown account as a definite failure", async () => {
    await expect(gateway.createHostedAuthLink({ ...link, reconnectAccount: "nope" })).rejects.toMatchObject({ kind: "definite" });
  });
});
