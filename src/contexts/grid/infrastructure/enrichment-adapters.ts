import { ProviderError, type AdapterRegistry, type EnrichmentProvider, type ProviderAnswer, type ProviderCall, type ProviderRecord } from "../application/enrichment-ports";
import { APOLLO_ACTIONS, FAKE_ACTIONS, HUNTER_ACTIONS, type ActionSpec } from "../domain/enrichment-catalog";
import { httpActionSpecs, httpProviderConfigSchema } from "../domain/enrichment-config";
import { stripLineBreaks, parseProviderBaseUrl, type UrlPolicy } from "../domain/enrichment-url-policy";
import { hasCellValue, pluck, render, renderBody } from "../domain/enrichment-templates";
import { isTransientStatus, parseBody, safeRequest, type SafeFetchDeps } from "./enrichment-http";

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The first useful sentence of a vendor's error body, never more than 300 characters. */
function errorSnippet(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  const root = asRecord(body);
  const errors = root.errors;
  const first = Array.isArray(errors) ? asRecord(errors[0]) : asRecord(errors);
  for (const value of [first.details, first.detail, first.message, root.message, (root.error as { message?: unknown } | undefined)?.message, root.error]) {
    if (typeof value === "string" && value) return value.slice(0, 300);
  }
  return "request failed";
}

// ---------------------------------------------------------------------------
// Hunter (https://hunter.io/api-documentation/v2). The caller brings their own key.
// ---------------------------------------------------------------------------

const HUNTER_BASE = "https://api.hunter.io/v2";

export class HunterAdapter implements EnrichmentProvider {
  readonly adapter = "hunter";
  constructor(private readonly net: SafeFetchDeps = {}) {}

  actions(): ActionSpec[] {
    return HUNTER_ACTIONS;
  }

  async execute(call: ProviderCall): Promise<ProviderAnswer> {
    const apiKey = call.credentials.apiKey;
    if (!apiKey) throw new ProviderError("The Hunter API key is missing.", false);
    const url = new URL(HUNTER_BASE);
    const { inputs } = call;
    if (call.action === "verify-email") {
      url.pathname = "/v2/email-verifier";
      url.searchParams.set("email", String(inputs.email));
    } else if (call.action === "find-emails-by-company") {
      url.pathname = "/v2/domain-search";
      url.searchParams.set("domain", String(inputs.companyDomain));
      url.searchParams.set("limit", "10");
    } else if (call.action === "find-work-email") {
      url.pathname = "/v2/email-finder";
      url.searchParams.set("domain", String(inputs.companyDomain));
      url.searchParams.set("full_name", String(inputs.fullName));
    } else {
      throw new ProviderError(`Unknown Hunter action: ${call.action}`, false);
    }
    const request = { method: "GET", endpoint: url.pathname, inputKeys: Object.keys(inputs) };
    const response = await safeRequest(url, { method: "GET", headers: { Accept: "application/json", "X-API-KEY": stripLineBreaks(apiKey) } }, call.timeoutMs, this.net);
    const body = parseBody(response);
    if (response.status === 202) throw new ProviderError("Hunter is still verifying this address. It will be asked again.", true, { request, response: body });
    if (response.status < 200 || response.status >= 300) {
      // 222 and 403 are Hunter's usage and rate limits; they clear on their own.
      const transient = response.status === 222 || response.status === 403 || isTransientStatus(response.status);
      throw new ProviderError(`Hunter returned ${response.status}: ${errorSnippet(body)}`, transient, { request, response: body });
    }
    const data = asRecord(asRecord(body).data);
    let outputs: Record<string, unknown>;
    let primary: unknown;
    if (call.action === "verify-email") {
      outputs = { email: data.email, status: data.status, score: data.score, acceptAll: data.accept_all, disposable: data.disposable, webmail: data.webmail };
      primary = data.status;
    } else if (call.action === "find-emails-by-company") {
      const emails = Array.isArray(data.emails) ? data.emails : [];
      outputs = { emails, emailCount: emails.length, firstEmail: asRecord(emails[0]).value, organization: data.organization, pattern: data.pattern };
      primary = outputs.firstEmail;
    } else {
      outputs = { email: data.email, score: data.score, verificationStatus: asRecord(data.verification).status, position: data.position, linkedinUrl: data.linkedin_url };
      primary = data.email;
    }
    const found = hasCellValue(primary);
    return { outcome: found ? "hit" : "miss", primary: found ? primary : null, outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v ?? null])), request, response: body };
  }
}

// ---------------------------------------------------------------------------
// Apollo (https://docs.apollo.io/reference/people-enrichment, .../organization-enrichment).
// The caller brings their own key. Docs read 2026-10-16; not exercised against a live key.
// ---------------------------------------------------------------------------

const APOLLO_BASE = "https://api.apollo.io/api/v1";
const APOLLO_DEFAULT_WAIT_MS = 60_000;
const APOLLO_MAX_WAIT_MS = 60 * 60_000;

/** `retry-after` is a number of seconds. A missing or odd value waits a minute; a long one is capped at an hour. */
export function apolloRetryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (!header || !Number.isFinite(seconds) || seconds < 0) return APOLLO_DEFAULT_WAIT_MS;
  return Math.min(APOLLO_MAX_WAIT_MS, Math.max(1000, Math.ceil(seconds * 1000)));
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export class ApolloAdapter implements EnrichmentProvider {
  readonly adapter = "apollo";
  constructor(private readonly net: SafeFetchDeps = {}) {}

  actions(): ActionSpec[] {
    return APOLLO_ACTIONS;
  }

  async execute(call: ProviderCall): Promise<ProviderAnswer> {
    const apiKey = call.credentials.apiKey;
    if (!apiKey) throw new ProviderError("The Apollo API key is missing.", false);
    const { inputs } = call;
    const url = new URL(APOLLO_BASE);
    let method: "GET" | "POST";
    if (call.action === "enrich-person") {
      const email = text(inputs.email);
      const linkedin = text(inputs.linkedinUrl);
      const name = text(inputs.fullName);
      const domain = text(inputs.companyDomain);
      if (!email && !linkedin && !(name && domain)) throw new ProviderError("Apollo needs an email, a LinkedIn URL, or a full name with a company domain.", false);
      method = "POST";
      url.pathname = "/api/v1/people/match";
      if (email) url.searchParams.set("email", email);
      if (linkedin) url.searchParams.set("linkedin_url", linkedin);
      if (name) url.searchParams.set("name", name);
      if (domain) url.searchParams.set("domain", domain);
    } else if (call.action === "enrich-company") {
      const domain = text(inputs.companyDomain);
      if (!domain) throw new ProviderError("Apollo needs a company domain.", false);
      method = "GET";
      url.pathname = "/api/v1/organizations/enrich";
      url.searchParams.set("domain", domain);
    } else {
      throw new ProviderError(`Unknown Apollo action: ${call.action}`, false);
    }
    const request = { method, endpoint: url.pathname, inputKeys: Object.keys(inputs) };
    const response = await safeRequest(url, { method, headers: { Accept: "application/json", "Cache-Control": "no-cache", "x-api-key": stripLineBreaks(apiKey) } }, call.timeoutMs, this.net);
    const body = parseBody(response);
    if (response.status < 200 || response.status >= 300) {
      const detail = `Apollo returned ${response.status}: ${errorSnippet(body)}`;
      if (response.status === 401 || response.status === 403) throw new ProviderError(`${detail} Check the Apollo API key.`, false, { request, response: body });
      if (response.status === 429) throw new ProviderError(detail, true, { request, response: body }, apolloRetryAfterMs(response.retryAfter));
      throw new ProviderError(detail, isTransientStatus(response.status), { request, response: body });
    }
    let outputs: Record<string, unknown>;
    let primary: unknown;
    if (call.action === "enrich-person") {
      const person = asRecord(asRecord(body).person);
      const confidence = text(person.match_confidence);
      // Apollo bills nothing for "none", and its fields then belong to nobody.
      const matched = confidence !== "none";
      outputs = {
        email: matched ? person.email : null,
        emailStatus: matched ? person.email_status : null,
        title: matched ? person.title : null,
        company: matched ? asRecord(person.organization).name : null,
        linkedinUrl: matched ? person.linkedin_url : null,
        matchConfidence: confidence,
      };
      primary = outputs.email;
    } else {
      const org = asRecord(asRecord(body).organization);
      outputs = {
        name: org.name,
        industry: org.industry,
        employeeCount: org.estimated_num_employees,
        websiteUrl: org.website_url,
        linkedinUrl: org.linkedin_url,
        city: org.city,
        country: org.country,
      };
      primary = org.name;
    }
    const found = hasCellValue(primary);
    return { outcome: found ? "hit" : "miss", primary: found ? primary : null, outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v ?? null])), request, response: body };
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
  const hunter = new HunterAdapter(options.net);
  const apollo = new ApolloAdapter(options.net);
  const http = new HttpAdapter(options.policy, options.net);
  return {
    adapterFor(provider) {
      switch (provider.config.adapter) {
        case "hunter":
          return hunter;
        case "apollo":
          return apollo;
        case "http":
          return http;
        case "fake":
          return options.fake ?? null;
        default:
          return null;
      }
    },
  };
}
