import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ProviderSendError, type OutgoingEmail } from "../../application/ports";
import { GmailMailboxProvider, parseServiceAccountJson } from "../gmail-mailbox-provider";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const credentials = { clientEmail: "svc@proj.iam.gserviceaccount.com", privateKey };

const email: OutgoingEmail = {
  mailbox: { emailAddress: "sam@acme.com", displayName: "Sam" },
  to: "lead@example.com",
  subject: "Hello",
  bodyText: "Hi",
  bodyHtml: "<p>Hi</p>",
  rfcMessageId: "<abc@acme.com>",
  inReplyTo: null,
  references: [],
  threadId: null,
  listUnsubscribeUrl: "https://app.example.com/u",
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokenOk = () => json(200, { access_token: "tok-1", expires_in: 3600 });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function setup(handler: Handler, now = { t: 1_700_000_000_000 }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  const provider = new GmailMailboxProvider({ credentials, fetch: fetchMock as unknown as typeof fetch, now: () => new Date(now.t) });
  return { provider, calls, now };
}
const isToken = (url: string) => url === "https://oauth2.googleapis.com/token";

describe("token exchange", () => {
  it("signs an RS256 JWT with the delegated subject and the three scopes", async () => {
    const { provider, calls } = setup((url) => (isToken(url) ? tokenOk() : json(200, { emailAddress: "sam@acme.com" })));
    await provider.verify("sam@acme.com");
    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = form.get("assertion")!.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims).toMatchObject({
      iss: credentials.clientEmail,
      sub: "sam@acme.com",
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify",
    });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
    expect(calls[1]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
  });

  it("caches per mailbox and refreshes 60 seconds before expiry", async () => {
    const { provider, calls, now } = setup((url) => (isToken(url) ? tokenOk() : json(200, {})));
    await provider.verify("sam@acme.com");
    await provider.verify("sam@acme.com");
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(1);
    await provider.verify("other@acme.com");
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(2);
    now.t += 3600_000 - 61_000;
    await provider.verify("sam@acme.com");
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(2);
    now.t += 2_000;
    await provider.verify("sam@acme.com");
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(3);
  });

  it("explains missing delegation on verify", async () => {
    const { provider } = setup(() => json(401, { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens" }));
    await expect(provider.verify("sam@acme.com")).rejects.toThrow(/domain-wide delegation[\s\S]*gmail\.send/);
  });

  it("explains a Gmail refusal on verify", async () => {
    const { provider } = setup((url) => (isToken(url) ? tokenOk() : json(403, { error: { message: "Mail service not enabled" } })));
    await expect(provider.verify("sam@acme.com")).rejects.toThrow(/403[\s\S]*Mail service not enabled/);
  });

  it("never puts the key or token in an error", async () => {
    const { provider } = setup(() => json(400, { error: "invalid_grant", error_description: "Invalid email or User ID" }));
    const error = await provider.verify("sam@acme.com").catch((e: Error) => e);
    expect((error as Error).message).not.toContain("PRIVATE KEY");
    expect((error as Error).message).not.toContain("tok-1");
  });
});

describe("send", () => {
  const sendHandler = (response: () => Response | Promise<Response>): Handler => (url) => (isToken(url) ? tokenOk() : response());

  it("posts base64url raw and returns the ids", async () => {
    const { provider, calls } = setup(sendHandler(() => json(200, { id: "m1", threadId: "t1" })));
    const sent = await provider.send({ ...email, threadId: "t0" });
    expect(sent).toEqual({ providerMessageId: "m1", threadId: "t1" });
    const call = calls[1]!;
    expect(call.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(call.init!.method).toBe("POST");
    const body = JSON.parse(String(call.init!.body));
    expect(body.threadId).toBe("t0");
    expect(body.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(body.raw, "base64url").toString()).toContain("Message-ID: <abc@acme.com>");
    expect(call.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits threadId when none is given", async () => {
    const { provider, calls } = setup(sendHandler(() => json(200, { id: "m1" })));
    expect(await provider.send(email)).toEqual({ providerMessageId: "m1", threadId: null });
    expect(JSON.parse(String(calls[1]!.init!.body))).not.toHaveProperty("threadId");
  });

  it.each([400, 401, 403, 404])("treats %i as definite", async (status) => {
    const { provider } = setup(sendHandler(() => json(status, { error: { message: "nope" } })));
    const error = await provider.send(email).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderSendError);
    expect(error.kind).toBe("definite");
    expect(error.message).toContain("nope");
    if (status === 401 || status === 403) expect(error.message).toMatch(/domain-wide delegation/);
  });

  it.each([429, 500, 502, 503])("treats %i as unknown", async (status) => {
    const { provider } = setup(sendHandler(() => json(status, { error: { message: "busy" } })));
    const error = await provider.send(email).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderSendError);
    expect(error.kind).toBe("unknown");
  });

  it("treats a network error or timeout after the request as unknown", async () => {
    for (const failure of [new TypeError("fetch failed"), new DOMException("timed out", "TimeoutError")]) {
      const { provider } = setup(sendHandler(() => Promise.reject(failure)));
      const error = await provider.send(email).catch((e) => e);
      expect(error.kind).toBe("unknown");
    }
  });

  it("treats an unreadable success response as unknown", async () => {
    const { provider } = setup(sendHandler(() => new Response("not json", { status: 200 })));
    expect((await provider.send(email).catch((e) => e)).kind).toBe("unknown");
  });

  it("treats token failures as definite and sends nothing", async () => {
    for (const handler of [() => json(400, { error: "invalid_grant" }), () => json(503, {}), () => Promise.reject(new TypeError("fetch failed"))] as Handler[]) {
      const { provider, calls } = setup(handler);
      const error = await provider.send(email).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderSendError);
      expect(error.kind).toBe("definite");
      expect(calls.every((c) => isToken(c.url))).toBe(true);
    }
  });

  it("refuses header injection as definite without any request", async () => {
    const { provider, calls } = setup(sendHandler(() => json(200, { id: "m1" })));
    const error = await provider.send({ ...email, subject: "x\r\nBcc: a@b.com" }).catch((e) => e);
    expect(error.kind).toBe("definite");
    expect(calls).toHaveLength(0);
  });
});

describe("findSent", () => {
  const SINCE = new Date(1_700_000_000_000 - 2 * 3_600_000);
  const who = { emailAddress: "sam@acme.com" };
  /** Gmail rewrites Message-ID on send, so matching runs on our own X-MiaSDR-Send-Id header. */
  const sentMail = (headers: Record<string, string>, pages: Array<Array<string>> = [["m1", "m2"]]) => (url: string) => {
    if (isToken(url)) return tokenOk();
    const u = new URL(url);
    if (u.pathname.endsWith("/messages")) {
      const index = Number(u.searchParams.get("pageToken") ?? 0);
      const ids = pages[index] ?? [];
      return json(200, { messages: ids.map((id) => ({ id, threadId: `t${id.slice(1)}` })), ...(index + 1 < pages.length ? { nextPageToken: String(index + 1) } : {}) });
    }
    const value = headers[u.pathname.split("/").pop()!];
    return json(200, { payload: { headers: value ? [{ name: "X-MiaSDR-Send-Id", value }] : [] } });
  };

  it("finds the message whose send-id header matches within the window", async () => {
    const { provider, calls } = setup(sentMail({ m1: "<other@acme.com>", m2: "<abc@acme.com>" }));
    expect(await provider.findSent(who, "abc@acme.com", SINCE)).toEqual({ status: "found", sent: { providerMessageId: "m2", threadId: "t2" } });
    const q = new URL(calls[1]!.url).searchParams.get("q");
    expect(q).toBe(`in:sent after:${Math.floor(SINCE.getTime() / 1000) - 3600}`);
    expect(new URL(calls[1]!.url).searchParams.get("includeSpamTrash")).toBe("true");
  });

  it("narrows the query to the recipient when given a hint", async () => {
    const { provider, calls } = setup(sentMail({ m1: "<abc@acme.com>" }));
    await provider.findSent(who, "abc@acme.com", SINCE, { to: "Lead@Example.com" });
    const u = new URL(calls[1]!.url);
    expect(u.searchParams.get("q")).toBe(`in:sent to:lead@example.com after:${Math.floor(SINCE.getTime() / 1000) - 3600}`);
    expect(u.searchParams.get("includeSpamTrash")).toBe("true");
  });

  it("ignores a hint that is not a plain address", async () => {
    const { provider, calls } = setup(sentMail({}));
    await provider.findSent(who, "abc@acme.com", SINCE, { to: 'x@y.com) OR (in:anywhere' });
    expect(new URL(calls[1]!.url).searchParams.get("q")).not.toContain("to:");
  });

  it("caps a hinted scan at 10 pages", async () => {
    const { provider, calls } = setup((url) => {
      if (isToken(url)) return tokenOk();
      return json(200, { messages: [], nextPageToken: "more" });
    });
    const result = await provider.findSent(who, "<abc@acme.com>", new Date(1_700_000_000_000 - 20 * 86_400_000), { to: "lead@example.com" });
    expect(result).toMatchObject({ status: "inconclusive" });
    expect(calls.filter((c) => new URL(c.url).pathname.endsWith("/messages"))).toHaveLength(10);
  });

  it("returns inconclusive, not absent, for a claim younger than 10 minutes", async () => {
    const { provider } = setup(sentMail({ m1: "<other@acme.com>" }));
    const young = new Date(1_700_000_000_000 - 9 * 60_000);
    expect(await provider.findSent(who, "<abc@acme.com>", young)).toMatchObject({ status: "inconclusive", reason: expect.stringMatching(/10 minutes/) });
    const old = new Date(1_700_000_000_000 - 10 * 60_000);
    expect(await provider.findSent(who, "<abc@acme.com>", old)).toEqual({ status: "absent" });
  });

  it("still finds a message for a young claim", async () => {
    const { provider } = setup(sentMail({ m1: "<abc@acme.com>" }));
    const result = await provider.findSent(who, "<abc@acme.com>", new Date(1_700_000_000_000 - 60_000));
    expect(result.status).toBe("found");
  });

  it("returns absent only when the listing ended with no next page token", async () => {
    const { provider } = setup(sentMail({ m1: "<other@acme.com>" }, [["m1"], ["m2"]]));
    expect(await provider.findSent(who, "<abc@acme.com>", SINCE)).toEqual({ status: "absent" });
  });

  it("returns inconclusive when the page cap is hit before the listing ends", async () => {
    // Always offers a next page: the scan can never be exhaustive.
    const { provider, calls } = setup((url) => {
      if (isToken(url)) return tokenOk();
      if (new URL(url).pathname.endsWith("/messages")) return json(200, { messages: [], nextPageToken: "more" });
      return json(200, { payload: { headers: [] } });
    });
    const result = await provider.findSent(who, "<abc@acme.com>", SINCE);
    expect(result).toMatchObject({ status: "inconclusive" });
    // 2h window plus margin: ceil(0.125 day * 2000 / 100) + 5 = 8 pages.
    expect(calls.filter((c) => new URL(c.url).pathname.endsWith("/messages"))).toHaveLength(8);
  });

  it("sizes the page cap from the window length", async () => {
    const { provider, calls } = setup((url) => {
      if (isToken(url)) return tokenOk();
      return json(200, { messages: [], nextPageToken: "more" });
    });
    await provider.findSent(who, "<abc@acme.com>", new Date(1_700_000_000_000 - 10 * 86_400_000));
    // 10-day window plus the 1 h margin: ceil((10 + 1 / 24) day * 2000 / 100) + 5 = 206 pages.
    expect(calls.filter((c) => new URL(c.url).pathname.endsWith("/messages"))).toHaveLength(206);
  });

  it("returns inconclusive without any request when the claim is beyond the horizon", async () => {
    const { provider, calls } = setup(sentMail({}));
    const result = await provider.findSent(who, "<abc@acme.com>", new Date(1_700_000_000_000 - 31 * 86_400_000));
    expect(result).toMatchObject({ status: "inconclusive" });
    expect(calls).toHaveLength(0);
  });

  it("throws on an API failure so the send stays unresolved", async () => {
    const { provider } = setup((url) => (isToken(url) ? tokenOk() : json(500, { error: { message: "down" } })));
    await expect(provider.findSent(who, "<abc@acme.com>", SINCE)).rejects.toThrow(/500/);
  });

  it("throws when a message lookup fails mid-scan", async () => {
    const { provider } = setup((url) => {
      if (isToken(url)) return tokenOk();
      if (new URL(url).pathname.endsWith("/messages")) return json(200, { messages: [{ id: "m1" }] });
      return json(503, { error: { message: "busy" } });
    });
    await expect(provider.findSent(who, "<abc@acme.com>", SINCE)).rejects.toThrow(/503/);
  });
});

describe("fetchMessages", () => {
  const raw = (id: string, labels: string[] = ["INBOX"]) => ({
    id,
    threadId: `t-${id}`,
    labelIds: labels,
    internalDate: "1791986777000",
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: "Lena <lena@acme.test>" }, { name: "Subject", value: "Hi" }, { name: "To", value: "sam@acme.com" }], body: { data: Buffer.from("Hello").toString("base64url") } },
  });
  const handler = (url: string) => {
    if (isToken(url)) return tokenOk();
    const id = new URL(url).pathname.split("/").pop()!;
    if (id === "gone") return json(404, { error: { message: "Requested entity was not found." } });
    if (id === "badid") return json(400, { error: { message: "Invalid id value" } });
    if (id === "sent1") return json(200, raw("sent1", ["SENT"]));
    return json(200, raw(id));
  };

  it("returns messages by id and reports deleted, unresolvable and own messages as missing", async () => {
    const { provider } = setup(handler);
    const result = await provider.fetchMessages({ emailAddress: "sam@acme.com" }, ["m1", "gone", "badid", "sent1"]);
    expect(result.messages.map((m) => m.providerMessageId)).toEqual(["m1"]);
    expect(result.missing).toEqual(["gone", "badid", "sent1"]);
  });

  it("still throws on a server error so the retry stays pending", async () => {
    const { provider } = setup((url) => (isToken(url) ? tokenOk() : json(500, { error: { message: "down" } })));
    await expect(provider.fetchMessages({ emailAddress: "sam@acme.com" }, ["m1"])).rejects.toThrow(/500/);
  });
});

describe("parseServiceAccountJson", () => {
  it("reads the key file fields", () => {
    expect(parseServiceAccountJson(JSON.stringify({ client_email: "a@b", private_key: "k", other: 1 }))).toEqual({ clientEmail: "a@b", privateKey: "k" });
  });
  it("rejects bad input without echoing it", () => {
    let message = "";
    try {
      parseServiceAccountJson("{secret");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not valid JSON/);
    expect(message).not.toContain("secret");
    expect(() => parseServiceAccountJson("{}")).toThrow(/client_email and private_key/);
  });
});

describe("fetchInbound", () => {
  const api = "https://gmail.googleapis.com/gmail/v1/users/me";
  const b64 = (t: string) => Buffer.from(t).toString("base64url");
  const msg = (id: string, labels: string[] = ["INBOX"], subject = `s-${id}`) => ({
    id,
    threadId: `t-${id}`,
    labelIds: labels,
    internalDate: "1700000000000",
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: "a@b.com" }, { name: "Subject", value: subject }], body: { data: b64(`body ${id}`) } },
  });
  const mailbox = { emailAddress: "sam@acme.com" };

  it("returns the profile history id on first sync", async () => {
    const { provider, calls } = setup((url) => (isToken(url) ? tokenOk() : json(200, { historyId: "500" })));
    expect(await provider.fetchInbound(mailbox, null)).toEqual({ messages: [], cursor: "500" });
    expect(calls[1]!.url).toBe(`${api}/profile`);
  });

  it("pages through history, dedupes ids and tracks the newest history id", async () => {
    const { provider, calls } = setup((url) => {
      if (isToken(url)) return tokenOk();
      if (url.includes("/history?") && !url.includes("pageToken")) {
        return json(200, { history: [{ messagesAdded: [{ message: { id: "a" } }, { message: { id: "b" } }] }], historyId: "610", nextPageToken: "p2" });
      }
      if (url.includes("/history?")) return json(200, { history: [{ messagesAdded: [{ message: { id: "b" } }, { message: { id: "c" } }] }], historyId: "620" });
      const id = /messages\/(\w+)\?/.exec(url)![1]!;
      return json(200, msg(id));
    });
    const batch = await provider.fetchInbound(mailbox, "600");
    expect(batch.cursor).toBe("620");
    expect(batch.reset).toBeUndefined();
    expect(batch.messages.map((m) => m.providerMessageId)).toEqual(["a", "b", "c"]);
    expect(batch.messages[0]).toMatchObject({ subject: "s-a", bodyText: "body a", threadId: "t-a" });
    const history = calls.filter((c) => c.url.includes("/history?"));
    expect(history).toHaveLength(2);
    expect(history[0]!.url).toContain("startHistoryId=600");
    expect(history[0]!.url).toContain("historyTypes=messageAdded");
    expect(history[0]!.url).toContain("labelId=INBOX");
    expect(history[1]!.url).toContain("pageToken=p2");
    expect(calls.filter((c) => c.url.includes("/messages/") && c.url.includes("format=full"))).toHaveLength(3);
  });

  it("keeps the cursor when history is empty", async () => {
    const { provider } = setup((url) => (isToken(url) ? tokenOk() : json(200, {})));
    expect(await provider.fetchInbound(mailbox, "600")).toEqual({ messages: [], cursor: "600" });
  });

  it("resets with a fresh profile cursor when history answers 404", async () => {
    const { provider } = setup((url) => {
      if (isToken(url)) return tokenOk();
      if (url.includes("/history?")) return json(404, { error: { message: "Requested entity was not found." } });
      return json(200, { historyId: "900" });
    });
    expect(await provider.fetchInbound(mailbox, "1")).toEqual({ messages: [], cursor: "900", reset: true });
  });

  it("skips sent, draft and non-inbox messages and messages that vanished", async () => {
    const { provider } = setup((url) => {
      if (isToken(url)) return tokenOk();
      if (url.includes("/history?")) {
        return json(200, { history: [{ messagesAdded: ["ok", "sent", "draft", "archived", "gone"].map((id) => ({ message: { id } })) }], historyId: "700" });
      }
      const id = /messages\/(\w+)\?/.exec(url)![1]!;
      if (id === "gone") return json(404, { error: { message: "not found" } });
      const labels: Record<string, string[]> = { ok: ["INBOX", "UNREAD"], sent: ["INBOX", "SENT"], draft: ["INBOX", "DRAFT"], archived: ["CATEGORY_UPDATES"] };
      return json(200, msg(id, labels[id]));
    });
    const batch = await provider.fetchInbound(mailbox, "600");
    expect(batch.messages.map((m) => m.providerMessageId)).toEqual(["ok"]);
    expect(batch.cursor).toBe("700");
  });

  it("limits detail fetches to 5 at a time", async () => {
    let active = 0;
    let peak = 0;
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const { provider } = setup(async (url) => {
      if (isToken(url)) return tokenOk();
      if (url.includes("/history?")) return json(200, { history: [{ messagesAdded: ids.map((id) => ({ message: { id } })) }], historyId: "800" });
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return json(200, msg(/messages\/(\w+)\?/.exec(url)![1]!));
    });
    expect((await provider.fetchInbound(mailbox, "1")).messages).toHaveLength(12);
    expect(peak).toBe(5);
  });

  it("throws when a message fetch fails, so the cursor is not advanced", async () => {
    const { provider } = setup((url) => {
      if (isToken(url)) return tokenOk();
      if (url.includes("/history?")) return json(200, { history: [{ messagesAdded: [{ message: { id: "a" } }, { message: { id: "b" } }] }], historyId: "700" });
      return /messages\/b\?/.test(url) ? json(500, { error: { message: "backend error" } }) : json(200, msg("a"));
    });
    await expect(provider.fetchInbound(mailbox, "600")).rejects.toThrow(/message lookup failed.*500.*backend error/);
  });

  it("throws on a history failure other than 404 and on network errors", async () => {
    const forbidden = setup((url) => (isToken(url) ? tokenOk() : json(403, { error: { message: "denied" } })));
    await expect(forbidden.provider.fetchInbound(mailbox, "1")).rejects.toThrow(/history failed.*403.*denied.*domain-wide delegation/i);
    const offline = setup((url) => {
      if (isToken(url)) return tokenOk();
      throw new TypeError("fetch failed");
    });
    await expect(offline.provider.fetchInbound(mailbox, "1")).rejects.toThrow(/Could not reach the Gmail API/);
  });
});
