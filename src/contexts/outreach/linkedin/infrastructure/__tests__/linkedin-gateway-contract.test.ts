import { describe, expect, it } from "vitest";
import { LinkedInGatewayError, type LinkedInGateway } from "../../application/linkedin-ports";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";
import { EdgesGateway } from "../vendors/edges/edges-gateway";
import { GtmGateway } from "../vendors/gtmapi/gtm-gateway";
import { LinkedApiGateway } from "../vendors/linkedapi/linkedapi-gateway";
import { UnipileGateway } from "../vendors/unipile/unipile-gateway";

/*
 * What the engines rely on from every gateway, whatever its vendor does on the wire. Each vendor's own test pins the wire.
 * Answers here carry no vendor fields beyond a refusal's envelope, so nothing guessed about a vendor's rows is pinned.
 */

type Answer = Error | { status: number; text: string };

function scripted(answer: Answer) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    calls.push(String(url));
    if (answer instanceof Error) throw answer;
    return new Response(answer.text, { status: answer.status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const refusal = (body: unknown, status: number): Answer => ({ status, text: JSON.stringify(body) });

/** A send on Linked API first reads the account's token, and that read is not what these cases are about. */
const withListing = (fetcher: typeof fetch) =>
  (async (url: string | URL, init?: RequestInit) =>
    String(url).endsWith("/admin/accounts.getAll") ? new Response(JSON.stringify({ success: true, result: { accounts: [{ id: "acct", identificationToken: "t" }] } })) : fetcher(url, init)) as unknown as typeof fetch;

let linkedApiKey = 0;

const VENDORS: Array<{ name: string; make: (fetcher: typeof fetch) => LinkedInGateway; unauthorized: Answer; limited: Answer }> = [
  {
    name: "Unipile",
    make: (fetcher) => new UnipileGateway({ dsn: "api9.unipile.com:14999", apiKey: "k", fetch: fetcher }),
    unauthorized: refusal({}, 401),
    limited: refusal({}, 429),
  },
  {
    name: "Edges",
    make: (fetcher) => new EdgesGateway({ apiKey: "k", fetch: fetcher }),
    unauthorized: refusal({}, 401),
    limited: refusal({}, 429),
  },
  {
    name: "gtm-api",
    make: (fetcher) => new GtmGateway({ apiKey: "k", fetch: fetcher }),
    unauthorized: refusal({ success: false, error: { code: "unauthorized", message: "No." } }, 401),
    limited: refusal({ success: false, error: { code: "rate_limited", message: "Slow down." } }, 429),
  },
  {
    name: "Linked API",
    make: (fetcher) => new LinkedApiGateway({ apiKey: `contract-${(linkedApiKey += 1)}`, fetch: withListing(fetcher) }),
    unauthorized: refusal({ success: false, error: { type: "invalidLinkedApiToken", message: "No." } }, 401),
    limited: refusal({ success: false, error: { type: "tooManyRequests", message: "Slow down." } }, 429),
  },
];

const NO_ANSWER: Answer = new Error("connection reset");
const GARBLED: Answer = { status: 200, text: "<html>a proxy page</html>" };
const GATEWAY_PAGE: Answer = { status: 503, text: "<html>bad gateway</html>" };

const MEMBER = "ACoAAmember1";
const to = { chat: "chat-1", member: MEMBER, slug: "ada" };
const since = new Date("2026-10-14T10:00:00Z");
const message = { account: "acct", to, text: "Hi", sendKey: "send-1", unlessRepliedAfter: null };
const invitation = { account: "acct", member: MEMBER, note: null, sendKey: "send-1" };

const failure = async (call: Promise<unknown>) => {
  const outcome = await call.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(LinkedInGatewayError);
  return outcome as LinkedInGatewayError;
};

describe.each(VENDORS)("the LinkedIn gateway port, on $name", ({ name, make, unauthorized, limited }) => {
  const gateway = (answer: Answer) => {
    const { fetcher, calls } = scripted(answer);
    return { gateway: make(fetcher), calls };
  };

  it("refuses a message with nobody to send it to, before any call", async () => {
    const { gateway: g, calls } = gateway({ status: 200, text: "{}" });
    expect(await failure(g.sendMessage({ ...message, to: { chat: null, member: null, slug: null } }))).toMatchObject({ kind: "definite", code: "invalid_recipient" });
    expect(calls).toHaveLength(0);
  });

  // A send that may have run must never read as refused: the engine would send it again.
  it.each([
    ["no answer", NO_ANSWER],
    ["a success that is not JSON", GARBLED],
    ["a gateway page", GATEWAY_PAGE],
  ])("calls the outcome of a send unknown on %s", async (_, answer) => {
    expect(await failure(gateway(answer).gateway.sendMessage(message))).toMatchObject({ kind: "unknown" });
    expect(await failure(gateway(answer).gateway.sendInvitation(invitation))).toMatchObject({ kind: "unknown" });
  });

  // Null and "none" lead to a resend, so a check that learned nothing has to throw.
  it.each([
    ["no answer", NO_ANSWER],
    ["a success that is not JSON", GARBLED],
    ["a gateway page", GATEWAY_PAGE],
  ])("throws from a reconcile check on %s", async (_, answer) => {
    expect(await failure(gateway(answer).gateway.findSentMessage({ ...message, since }))).toMatchObject({ kind: "unknown" });
    // Linked API answers without looking, and a repeat is refused at LinkedIn: see `invitationStatus` there.
    if (name !== "Linked API") expect(await failure(gateway(answer).gateway.invitationStatus({ ...invitation, since }))).toMatchObject({ kind: "unknown" });
  });

  it("calls a lookup with no answer unknown, so the lead keeps its retries", async () => {
    expect(await failure(gateway(NO_ANSWER).gateway.getProfile({ account: "acct", identifier: "ada" }))).toMatchObject({ kind: "unknown" });
  });

  it("names refused credentials", async () => {
    expect(await failure(gateway(unauthorized).gateway.verify())).toMatchObject({ kind: "definite", code: "auth" });
  });

  it("calls a limit definite, so a limited send keeps its attempt", async () => {
    expect(await failure(gateway(limited).gateway.sendMessage(message))).toMatchObject({ kind: "definite", code: "rate_limited" });
  });
});

/** The engine tests run on the fake, so it has to keep the same promises. */
describe("the LinkedIn gateway port, on the fake", () => {
  it("refuses a message with nobody to send it to, and records nothing", async () => {
    const fake = new FakeLinkedInGateway();
    expect(await failure(fake.sendMessage({ ...message, to: { chat: null, member: null, slug: null } }))).toMatchObject({ kind: "definite", code: "invalid_recipient" });
    expect(fake.messages).toHaveLength(0);
  });

  it("calls a timed out send unknown", async () => {
    const fake = new FakeLinkedInGateway();
    fake.messageBehavior = () => "timeout-lost";
    fake.inviteBehavior = () => "timeout-lost";
    expect(await failure(fake.sendMessage(message))).toMatchObject({ kind: "unknown" });
    expect(await failure(fake.sendInvitation(invitation))).toMatchObject({ kind: "unknown" });
  });

  it("throws from a reconcile check during an outage", async () => {
    const fake = new FakeLinkedInGateway();
    fake.readOutage = true;
    expect(await failure(fake.findSentMessage({ ...message, since }))).toMatchObject({ kind: "unknown" });
    expect(await failure(fake.invitationStatus({ ...invitation, since }))).toMatchObject({ kind: "unknown" });
  });

  it("finds a sent message only after `since`, as the port asks", async () => {
    const fake = new FakeLinkedInGateway();
    await fake.sendMessage(message);
    expect(await fake.findSentMessage({ ...message, since: new Date(Date.now() - 60_000) })).toMatchObject({ messageId: expect.any(String) });
    expect(await fake.findSentMessage({ ...message, since: new Date(Date.now() + 60_000) })).toBeNull();
  });
});
