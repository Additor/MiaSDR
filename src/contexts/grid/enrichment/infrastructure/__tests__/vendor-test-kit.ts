import { vi } from "vitest";
import type { EnrichmentProvider, ProviderCall, ProviderRecord } from "../../application/enrichment-ports";
import { createAdapterRegistry } from "../enrichment-adapters";
import { createEnrichmentVerifier } from "../vendors";

/**
 * Shared fixtures for native vendor tests. Every response a test feeds in is copied from the vendor's docs, or is the
 * smallest change to one that a test names, so the parser is checked against the vendor's shape and not against itself.
 */
export const VENDOR_KEY = "vendor-key-a+b/c=d-0123456789";

export interface Seen {
  url: string;
  init: RequestInit;
}

export function mockFetch(status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  const seen: Seen[] = [];
  const fn = (async (url: URL, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const record = (adapter: string): ProviderRecord => ({
  id: "p1", key: adapter, name: adapter, baseUrl: null, defaultCostCents: 0, rateLimitPerMin: null, config: { adapter }, enabled: true, hasCredential: true, createdAt: new Date(), updatedAt: new Date(),
});

/** The vendor's adapter as the worker gets it from the registry, over a stubbed network. */
export function vendorAdapter(adapter: string, fn: typeof fetch): EnrichmentProvider {
  return createAdapterRegistry({ policy: { allowedHosts: [] }, net: { fetch: fn, resolve: async () => ["93.184.216.34"] } }).adapterFor(record(adapter))!;
}

export const vendorCall = (adapter: string, action: string, inputs: Record<string, unknown>): ProviderCall => ({ action, inputs, credentials: { apiKey: VENDOR_KEY }, provider: record(adapter), timeoutMs: 1000 });

/** Runs one call; a thrown ProviderError comes back as the value. */
export async function ask(adapter: string, status: number, body: unknown, action: string, inputs: Record<string, unknown>, headers?: Record<string, string>) {
  const { fn, seen } = mockFetch(status, body, headers);
  const result = await vendorAdapter(adapter, fn).execute(vendorCall(adapter, action, inputs)).catch((e: unknown) => e);
  return { result: result as Record<string, unknown> & { message?: string }, seen };
}

/** Every encoded form the key could take. None may reach a request audit, an error text or the stored response. */
export const keyForms = [VENDOR_KEY, encodeURIComponent(VENDOR_KEY), new URLSearchParams({ k: VENDOR_KEY }).toString().slice(2)];

export async function checkKey(adapter: string, status: number, body: string) {
  const stub = vi.fn(async () => new Response(body, { status }));
  const result = await createEnrichmentVerifier({ fetch: stub as unknown as typeof fetch }).verify(adapter, { apiKey: VENDOR_KEY });
  const [url, init] = (stub.mock.calls[0] ?? []) as unknown as [string, RequestInit];
  return { result, url, init };
}
