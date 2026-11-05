import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isBlockedAddress } from "@/shared/blocked-address";

/**
 * One outbound request to an address a person or a web page named: resolve once, check every address, then connect to
 * that validated address (no second lookup, so DNS rebinding cannot swap it). A body cap and a timeout always apply.
 * What the caller allows, such as a host list or a same-site rule, stays with the caller.
 */

export const MAX_BODY_BYTES = 1024 * 1024;

export type SafeHttpFailure = "scheme" | "unresolved" | "blocked" | "timeout" | "unreachable" | "redirect" | "too_large" | "cut_off";

/** `retryable` says whether the same request could work later. */
export class SafeHttpError extends Error {
  constructor(
    readonly failure: SafeHttpFailure,
    readonly retryable: boolean,
    readonly host: string,
    readonly timeoutMs?: number,
  ) {
    super(`The request to ${host} failed: ${failure}.`);
  }
}

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

export interface SafeBodyOptions {
  /** `return` hands a 3xx back with its `location` header, for a caller that checks each hop. Default `refuse`. */
  redirects?: "refuse" | "return";
  /** `truncate` keeps the first bytes of a body past the cap. Default `fail`. */
  overflow?: "fail" | "truncate";
  /** Ends the request before its timeout, and reads as a timeout. */
  signal?: AbortSignal;
}

export interface SafeBytesResponse {
  status: number;
  contentType: string;
  bytes: Uint8Array;
  /** The body went past the cap and was cut. Only with `overflow: "truncate"`. */
  truncated: boolean;
  retryAfter: string | null;
  headers: Headers;
}

const isLoopbackHost = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1";

async function readBody(response: Response, host: string, overflow: "fail" | "truncate"): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const tooLarge = () => new SafeHttpError("too_large", false, host);
  const declared = Number(response.headers.get("content-length"));
  if (overflow === "fail" && Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        if (overflow === "fail") throw tooLarge();
        chunks.push(value.subarray(0, value.byteLength - (size - MAX_BODY_BYTES)));
        return { bytes: Buffer.concat(chunks), truncated: true };
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SafeHttpError) throw error;
    throw new SafeHttpError("cut_off", true, host);
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}

export async function safeRequestBytes(
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
  deps: SafeFetchDeps = {},
  options: SafeBodyOptions = {},
): Promise<SafeBytesResponse> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const loopbackOk = deps.allowLoopback === true && isLoopbackHost(hostname);
  if (url.protocol !== "https:" && !(loopbackOk && url.protocol === "http:")) throw new SafeHttpError("scheme", false, hostname);
  let pinned = hostname === "localhost" ? "127.0.0.1" : hostname;
  if (!loopbackOk) {
    let addresses: string[];
    if (isIP(hostname)) addresses = [hostname];
    else {
      try {
        addresses = await (deps.resolve ?? resolveAll)(hostname);
      } catch {
        throw new SafeHttpError("unresolved", true, hostname);
      }
    }
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) throw new SafeHttpError("blocked", false, hostname);
    pinned = addresses[0];
  }

  const signal = options.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal]) : AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await ((deps.fetch ?? pinnedFetch) as Transport)(url, { method: init.method, headers: init.headers, body: init.body, redirect: "manual", signal, cache: "no-store" }, pinned);
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw timedOut ? new SafeHttpError("timeout", true, hostname, timeoutMs) : new SafeHttpError("unreachable", true, hostname);
  }
  const redirected = response.status >= 300 && response.status < 400;
  if (redirected && options.redirects !== "return") throw new SafeHttpError("redirect", false, hostname);

  const { bytes, truncated } = redirected ? { bytes: new Uint8Array(), truncated: false } : await readBody(response, hostname, options.overflow ?? "fail");
  if (redirected) await response.body?.cancel().catch(() => undefined);
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", bytes, truncated, retryAfter: response.headers.get("retry-after"), headers: response.headers };
}
