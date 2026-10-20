import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderError } from "../../application/enrichment-ports";
import { pinnedFetch, safeRequest } from "../enrichment-http";

const url = new URL("https://api.vendor.test/v1/x");
const get = { method: "GET", headers: {} };

describe("response size cap", () => {
  const big = (bytes: number) => (async () => new Response("a".repeat(bytes), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const resolve = async () => ["93.184.216.34"];

  it("fails with a permanent 'response too large' error instead of handing truncated text to the parser", async () => {
    const error = await safeRequest(url, get, 1000, { fetch: big(1024 * 1024 + 1), resolve }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toMatch(/response too large/i);
    expect(error.transient).toBe(false);
  });

  it("rejects on a declared content-length before reading", async () => {
    const f = (async () => new Response("{}", { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } })) as unknown as typeof fetch;
    await expect(safeRequest(url, get, 1000, { fetch: f, resolve })).rejects.toThrow(/response too large/i);
  });

  it("accepts a body of exactly the limit", async () => {
    const response = await safeRequest(url, get, 1000, { fetch: big(1024 * 1024), resolve });
    expect(response.text.length).toBe(1024 * 1024);
  });
});

describe("address pinning", () => {
  it("resolves once, validates, and hands the validated address to the transport", async () => {
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    let calls = 0;
    const resolve = async () => answers[Math.min(calls++, answers.length - 1)];
    const seen: Array<string | undefined> = [];
    const f = (async (_u: URL, _i: RequestInit, address?: string) => {
      seen.push(address);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await safeRequest(url, get, 1000, { fetch: f, resolve });
    expect(calls).toBe(1);
    expect(seen).toEqual(["93.184.216.34"]);
  });

  it("refuses when any returned address is blocked, whatever the order", async () => {
    const resolve = async () => ["93.184.216.34", "203.0.113.9"];
    await expect(safeRequest(url, get, 1000, { fetch: (async () => new Response("{}")) as unknown as typeof fetch, resolve })).rejects.toThrow(/private or internal/);
  });

  describe("default transport", () => {
    let server: Server;
    let port = 0;
    const hosts: Array<string | undefined> = [];
    beforeAll(async () => {
      server = createServer((req, res) => {
        hosts.push(req.headers.host);
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("connects to the validated address while keeping the Host header, so the name is never resolved again", async () => {
      // `pinned.invalid` resolves nowhere, so the call only succeeds when the socket dials the pinned address.
      const response = await pinnedFetch(new URL(`http://pinned.invalid:${port}/v1/x`), { method: "GET", headers: {} }, "127.0.0.1");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"ok":true}');
      expect(hosts.at(-1)).toBe(`pinned.invalid:${port}`);
    });
  });
});
