import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { ProviderError } from "../application/enrichment-ports";
import { isBlockedAddress } from "../domain/enrichment-url-policy";

/** A response body past this fails the call. */
const MAX_BODY_BYTES = 1024 * 1024;

export type Resolver = (hostname: string) => Promise<string[]>;

const resolveAll: Resolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((e) => e.address);

/** Sends one request. `address` is the validated IP the socket must connect to. */
export type Transport = (url: URL, init: RequestInit, address: string) => Promise<Response>;

/**
 * Default transport: a node http(s) request whose `lookup` always answers with the validated address.
 * The URL keeps its hostname, so the Host header and the TLS servername (SNI and certificate check) stay correct
 * while the connection cannot be steered by a second DNS answer.
 */
export const pinnedFetch: Transport = (url, init, address) =>
  new Promise<Response>((resolve, reject) => {
    const family = isIP(address) === 6 ? 6 : 4;
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: init.method,
        headers: init.headers as Record<string, string>,
        signal: init.signal ?? undefined,
        lookup: (_host, options, callback) => {
          if (options.all) (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
          else callback(null, address, family);
        },
      },
      (res) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v);
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers }));
      },
    );
    req.on("error", reject);
    req.end(init.body as string | undefined);
  });

export interface SafeFetchDeps {
  /** Replaces the pinned transport (tests). Receives the validated address as its third argument. */
  fetch?: Transport | typeof fetch;
  resolve?: Resolver;
  /** Tests and demos only: lets a loopback host through the address check. */
  allowLoopback?: boolean;
}

export interface SafeResponse {
  status: number;
  contentType: string;
  text: string;
  /** The `retry-after` header as sent, or null. */
  retryAfter: string | null;
  /** Every response header, for vendors that put rate-limit resets or credits in their own headers. */
  headers: Headers;
}

const isLoopbackHost = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1";

/**
 * One outbound call: resolve once, check every address, then connect to that validated address (no second lookup,
 * so DNS rebinding cannot swap it). No redirects, a body cap and a timeout.
 * The host allow-list (see `parseProviderBaseUrl`) is what keeps a tenant from pointing a provider at a server it controls.
 */
export async function safeRequest(
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
  deps: SafeFetchDeps = {},
): Promise<SafeResponse> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const loopbackOk = deps.allowLoopback === true && isLoopbackHost(hostname);
  if (url.protocol !== "https:" && !(loopbackOk && url.protocol === "http:")) throw new ProviderError("Provider calls must use https.", false);
  let pinned = hostname === "localhost" ? "127.0.0.1" : hostname;
  if (!loopbackOk) {
    let addresses: string[];
    if (isIP(hostname)) addresses = [hostname];
    else {
      try {
        addresses = await (deps.resolve ?? resolveAll)(hostname);
      } catch {
        throw new ProviderError(`Could not resolve ${hostname}.`, true);
      }
    }
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) throw new ProviderError("That address is private or internal and cannot be called.", false);
    pinned = addresses[0];
  }

  let response: Response;
  try {
    response = await ((deps.fetch ?? pinnedFetch) as Transport)(url, { method: init.method, headers: init.headers, body: init.body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs), cache: "no-store" }, pinned);
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ProviderError(timedOut ? `The provider did not answer within ${timeoutMs} ms.` : "Could not reach the provider.", true);
  }
  if (response.status >= 300 && response.status < 400) throw new ProviderError("The provider answered with a redirect. Redirects are not followed.", false);

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError("Response too large: the provider's answer is over 1 MiB.", false);
  }
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        chunks.push(value);
        if (size > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new ProviderError("Response too large: the provider's answer is over 1 MiB.", false);
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("The provider's answer was cut off.", true);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", text, retryAfter: response.headers.get("retry-after"), headers: response.headers };
}

export function parseBody(response: SafeResponse): unknown {
  const trimmed = response.text.trimStart();
  if (response.contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(response.text);
    } catch {
      return response.text;
    }
  }
  return response.text;
}

/** 4xx other than 408 and 429 is the request being wrong and fails the same way again. */
export const isTransientStatus = (status: number) => status === 408 || status === 429 || status >= 500;
