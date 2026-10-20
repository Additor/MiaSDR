import { ProviderError, type AdapterRegistry, type EnrichmentProvider, type ProviderAnswer, type ProviderCall, type ProviderRecord } from "../application/enrichment-ports";
import { catalogEntry, FAKE_ACTIONS, type ActionSpec } from "../domain/enrichment-catalog";
import { httpActionSpecs, httpProviderConfigSchema } from "../domain/enrichment-config";
import { stripLineBreaks, parseProviderBaseUrl, type UrlPolicy } from "../domain/enrichment-url-policy";
import { hasCellValue, pluck, render, renderBody } from "../domain/enrichment-templates";
import { isTransientStatus, parseBody, safeRequest, type SafeFetchDeps } from "./enrichment-http";
import { VENDORS } from "./vendors";
import { errorSnippet, type VendorDefinition } from "./vendors/vendor-kit";

/** A native vendor adapter. Its actions come from the vendor's catalog entry, its calls from the vendor's definition. */
export class VendorAdapter implements EnrichmentProvider {
  readonly adapter: string;
  constructor(
    private readonly vendor: VendorDefinition,
    private readonly net: SafeFetchDeps = {},
  ) {
    this.adapter = vendor.key;
  }

  actions(): ActionSpec[] {
    return catalogEntry(this.vendor.key)?.actions ?? [];
  }

  execute(call: ProviderCall): Promise<ProviderAnswer> {
    return this.vendor.execute(call, this.net);
  }
}


// ---------------------------------------------------------------------------
// Generic HTTP: any JSON API the operator allow-listed, described by the provider's config.
// ---------------------------------------------------------------------------

export class HttpAdapter implements EnrichmentProvider {
  readonly adapter = "http";
  constructor(
    private readonly policy: UrlPolicy,
    private readonly net: SafeFetchDeps = {},
  ) {}

  actions(provider: ProviderRecord): ActionSpec[] {
    const parsed = httpProviderConfigSchema.safeParse(provider.config);
    return parsed.success ? httpActionSpecs(parsed.data) : [];
  }

  async execute(call: ProviderCall): Promise<ProviderAnswer> {
    const parsed = httpProviderConfigSchema.safeParse(call.provider.config);
    if (!parsed.success) throw new ProviderError("The provider's configuration is invalid. Save it again.", false);
    const config = parsed.data;
    const action = config.actions[call.action];
    if (!action) throw new ProviderError(`Unknown action: ${call.action}`, false);
    // Checked again on every call: a row saved under an older, looser rule must not reach the network.
    const base = parseProviderBaseUrl(call.provider.baseUrl ?? "", this.policy);
    if (!base) throw new ProviderError("The provider's base URL is not allowed. Ask an operator to check GRID_HTTP_ALLOWED_HOSTS.", false);

    const values = call.inputs;
    const dotSegment = Object.values(values).some((v) => typeof v === "string" && /^\.{1,2}$/.test(v.trim()));
    if (dotSegment) throw new ProviderError("An input value is not allowed in a URL path.", false);
    const path = render(action.path, values, encodeURIComponent);
    const url = new URL(base.base + path);
    const basePath = new URL(base.base).pathname.replace(/\/+$/, "");
    if (url.origin !== new URL(base.base).origin || !url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) throw new ProviderError("The request path left the provider's base URL.", false);
    for (const [name, template] of Object.entries(action.query)) url.searchParams.set(name, render(template, values));

    const auditUrl = `${url.origin}${url.pathname}${url.search}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    const apiKey = call.credentials.apiKey;
    if (config.auth.type !== "none" && !apiKey) throw new ProviderError("This provider needs an API key. Save one first.", false);
    if (apiKey) {
      const key = stripLineBreaks(apiKey);
      if (config.auth.type === "bearer") headers.Authorization = `Bearer ${key}`;
      else if (config.auth.type === "header") headers[config.auth.name as string] = key;
      else if (config.auth.type === "query") url.searchParams.set(config.auth.name as string, key);
    }
    let body: string | undefined;
    if (action.method === "POST") {
      body = JSON.stringify(renderBody(action.body ?? {}, values));
      headers["Content-Type"] = "application/json";
    }
    const request = { method: action.method, url: auditUrl, body: body ? JSON.parse(body) : undefined };

    // A POST may already have taken effect when it times out, so only GET is retried on transport failure.
    let response;
    try {
      response = await safeRequest(url, { method: action.method, headers, body }, call.timeoutMs, this.net);
    } catch (error) {
      if (error instanceof ProviderError && action.method !== "GET" && error.transient) throw new ProviderError(error.message, false, { request });
      if (error instanceof ProviderError) throw new ProviderError(error.message, error.transient, { request });
      throw error;
    }
    const parsedBody = parseBody(response);
    if (response.status < 200 || response.status >= 300) {
      const transient = isTransientStatus(response.status) && (action.method === "GET" || response.status === 429);
      throw new ProviderError(`${call.provider.key} returned ${response.status}: ${errorSnippet(parsedBody)}`, transient, { request, response: parsedBody });
    }
    const outputs: Record<string, unknown> = {};
    for (const [key, path2] of Object.entries(action.outputs)) outputs[key] = pluck(parsedBody, path2);
    const primary = outputs[action.primaryOutput];
    const found = hasCellValue(primary);
    return { outcome: found ? "hit" : "miss", primary: found ? primary : null, outputs, costCents: action.costCents > 0 ? action.costCents : undefined, request, response: parsedBody };
  }
}

// ---------------------------------------------------------------------------
// Fake: deterministic, no network. Tests replace `handler` to script answers.
// ---------------------------------------------------------------------------

export class FakeEnrichmentProvider implements EnrichmentProvider {
  readonly adapter = "fake";
  calls: ProviderCall[] = [];
  /** Replace to script answers. Throw a ProviderError to simulate a failure. */
  handler: ((call: ProviderCall) => ProviderAnswer | Promise<ProviderAnswer>) | null = null;
  /** Milliseconds each call takes, for concurrency tests. */
  delayMs = 0;

  actions(): ActionSpec[] {
    return FAKE_ACTIONS;
  }

  async execute(call: ProviderCall): Promise<ProviderAnswer> {
    this.calls.push(call);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.handler) return this.handler(call);
    const name = String(call.inputs.fullName ?? "").toLowerCase();
    const domain = String(call.inputs.companyDomain ?? "");
    if (name.includes("nohit")) return { outcome: "miss", primary: null, outputs: { email: null, confidence: null }, request: { inputs: call.inputs }, response: { found: false } };
    if (name.includes("boom")) throw new ProviderError("The fake provider rejected this request.", false, { request: { inputs: call.inputs } });
    const [first, ...rest] = name.split(/\s+/).filter(Boolean);
    const email = `${first}.${rest.join("") || "x"}@${domain}`;
    return { outcome: "hit", primary: email, outputs: { email, confidence: 90 }, request: { inputs: call.inputs }, response: { email, confidence: 90, echoedKey: call.credentials.apiKey ?? null } };
  }
}

export interface RegistryOptions {
  policy: UrlPolicy;
  net?: SafeFetchDeps;
  /** When set, providers with `config.adapter = "fake"` use this instance. Leave unset to disable the fake adapter. */
  fake?: FakeEnrichmentProvider;
}

export function createAdapterRegistry(options: RegistryOptions): AdapterRegistry {
  const vendors = new Map(VENDORS.map((v) => [v.key as string, new VendorAdapter(v, options.net)]));
  const http = new HttpAdapter(options.policy, options.net);
  return {
    adapterFor(provider) {
      const adapter = String(provider.config.adapter ?? "");
      if (adapter === "http") return http;
      if (adapter === "fake") return options.fake ?? null;
      return vendors.get(adapter) ?? null;
    },
  };
}
