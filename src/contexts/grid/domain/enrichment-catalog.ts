/**
 * Enrichment provider catalog. `available` providers have an adapter in this codebase.
 * `catalog_only` providers are listed by name, but nothing can call them: they have no adapter. The generic `http` adapter can stand in for any of them when the
 * operator allow-lists the host.
 */

import { contractAction } from "./enrichment-contracts";

export type ProviderStatus = "available" | "catalog_only";
/** Vendors with a native adapter in `infrastructure/vendors`. The key is also the `config.adapter` value stored on provider rows. */
export type VendorAdapterKey = "hunter" | "apollo" | "zerobounce" | "millionverifier" | "neverbounce" | "findymail" | "prospeo" | "leadmagic" | "peopledatalabs";
export type AdapterKey = VendorAdapterKey | "http" | "fake";
export type ValueType = "text" | "email" | "url" | "number" | "boolean" | "json" | "domain";

export interface ActionInput {
  key: string;
  name: string;
  type: ValueType;
  required: boolean;
}
export interface ActionOutput {
  key: string;
  name: string;
  type: ValueType;
}
export interface ActionSpec {
  key: string;
  name: string;
  inputs: ActionInput[];
  outputs: ActionOutput[];
  /** The output whose value is the cell's own value. Empty means a miss. */
  primaryOutput: string;
  /** Provider credits are not money; this is the cents a hit costs when the provider row sets no price. */
  defaultCostCents: number;
  /**
   * Input combinations the action can match on, beyond its required inputs. A cell runs when one combination is
   * filled. Empty or absent means the required inputs are enough.
   */
  accepts?: string[][];
}

export interface CredentialField {
  key: string;
  label: string;
  required: boolean;
}

export interface CatalogEntry {
  key: string;
  name: string;
  description: string;
  status: ProviderStatus;
  /** Adapter that serves the entry. Null for catalog-only entries. */
  adapter: AdapterKey | null;
  /** Fixed API host for adapters that call one vendor. The saved base URL must equal it. */
  fixedBaseUrl?: string;
  credentialFields: CredentialField[];
  /** Calls per minute a new provider row starts with, from the vendor's published limit. Null means no limit. */
  defaultRateLimitPerMin?: number;
  /** Static actions. The `http` adapter reads its actions from the provider config instead. */
  actions: ActionSpec[];
}

const API_KEY: CredentialField[] = [{ key: "apiKey", label: "API key", required: true }];

export const HUNTER_ACTIONS: ActionSpec[] = [
  contractAction("verify-email", {
    extraOutputs: [
      { key: "acceptAll", name: "Accept all", type: "boolean" },
      { key: "disposable", name: "Disposable", type: "boolean" },
      { key: "webmail", name: "Webmail", type: "boolean" },
    ],
  }),
  // `score` predates the contract's `confidence` and stays, so saved columns keep their values.
  contractAction("find-work-email", {
    extraOutputs: [
      { key: "score", name: "Score", type: "number" },
      { key: "position", name: "Position", type: "text" },
      { key: "linkedinUrl", name: "LinkedIn URL", type: "url" },
    ],
  }),
  {
    key: "find-emails-by-company",
    name: "Find emails by company",
    inputs: [{ key: "companyDomain", name: "Company domain", type: "domain", required: true }],
    outputs: [
      { key: "emails", name: "Emails", type: "json" },
      { key: "emailCount", name: "Email count", type: "number" },
      { key: "firstEmail", name: "First email", type: "email" },
      { key: "organization", name: "Organization", type: "text" },
      { key: "pattern", name: "Email pattern", type: "text" },
    ],
    primaryOutput: "firstEmail",
    defaultCostCents: 0,
  },
];

/** Apollo. The adapter never asks Apollo to reveal phone numbers or personal emails. */
export const APOLLO_ACTIONS: ActionSpec[] = [
  contractAction("enrich-person", {
    extraOutputs: [
      { key: "emailStatus", name: "Email status", type: "text" },
      { key: "matchConfidence", name: "Match confidence", type: "text" },
    ],
  }),
  contractAction("enrich-company"),
];

const verifyExtras = [
  { key: "subStatus", name: "Sub-status", type: "text" },
  { key: "freeEmail", name: "Free email", type: "boolean" },
  { key: "role", name: "Role address", type: "boolean" },
  { key: "didYouMean", name: "Did you mean", type: "email" },
] as const satisfies ActionOutput[];

export const ZEROBOUNCE_ACTIONS: ActionSpec[] = [contractAction("verify-email", { extraOutputs: [...verifyExtras] })];
export const MILLIONVERIFIER_ACTIONS: ActionSpec[] = [contractAction("verify-email", { extraOutputs: [...verifyExtras, { key: "quality", name: "Quality", type: "text" }] })];
export const NEVERBOUNCE_ACTIONS: ActionSpec[] = [
  contractAction("verify-email", { extraOutputs: [...verifyExtras.filter((o) => o.key !== "subStatus"), { key: "flags", name: "Flags", type: "json" }] }),
];

export const FINDYMAIL_ACTIONS: ActionSpec[] = [contractAction("find-work-email")];
export const PROSPEO_ACTIONS: ActionSpec[] = [contractAction("find-work-email")];
export const LEADMAGIC_ACTIONS: ActionSpec[] = [contractAction("find-work-email", { extraOutputs: [{ key: "employmentVerified", name: "Employment verified", type: "boolean" }] })];

/** People Data Labs. Only work fields are requested; personal emails, phones and addresses never are. */
export const PEOPLEDATALABS_ACTIONS: ActionSpec[] = [
  contractAction("enrich-person", { extraOutputs: [{ key: "likelihood", name: "Likelihood", type: "number" }] }),
  contractAction("enrich-company", { extraOutputs: [{ key: "size", name: "Size range", type: "text" }] }),
];

/** Deterministic provider for tests and demos. Never calls a network. */
export const FAKE_ACTIONS: ActionSpec[] = [
  {
    key: "find-email",
    name: "Find email",
    inputs: [
      { key: "fullName", name: "Full name", type: "text", required: true },
      { key: "companyDomain", name: "Company domain", type: "domain", required: true },
    ],
    outputs: [
      { key: "email", name: "Email", type: "email" },
      { key: "confidence", name: "Confidence", type: "number" },
    ],
    primaryOutput: "email",
    defaultCostCents: 1,
  },
];

const catalogOnly = (key: string, name: string, description: string): CatalogEntry => ({
  key,
  name,
  description,
  status: "catalog_only",
  adapter: null,
  credentialFields: API_KEY,
  actions: [],
});

export const PROVIDER_CATALOG: readonly CatalogEntry[] = [
  {
    key: "hunter",
    name: "Hunter",
    description: "Verify email addresses and find work emails. Bring your own Hunter API key; the free plan includes monthly credits.",
    status: "available",
    adapter: "hunter",
    fixedBaseUrl: "https://api.hunter.io",
    credentialFields: API_KEY,
    actions: HUNTER_ACTIONS,
    // The Email Verifier's limit; the finder allows 500.
    defaultRateLimitPerMin: 300,
  },
  {
    key: "apollo",
    name: "Apollo",
    description: "Enrich a person (work email, title, company, LinkedIn URL) or a company. Bring your own Apollo API key. Revealing an email uses Apollo credits, and the free plan has a small monthly allowance.",
    status: "available",
    adapter: "apollo",
    fixedBaseUrl: "https://api.apollo.io",
    credentialFields: API_KEY,
    actions: APOLLO_ACTIONS,
  },
  {
    key: "http",
    name: "Custom HTTP API",
    description: "Call any JSON API you hold a key for. The host must be on the operator's allow-list (GRID_HTTP_ALLOWED_HOSTS).",
    status: "available",
    adapter: "http",
    credentialFields: [{ key: "apiKey", label: "API key", required: false }],
    actions: [],
  },
  {
    key: "fake",
    name: "Fake provider",
    description: "Deterministic answers for tests and demos. Disabled unless the operator turns it on.",
    status: "available",
    adapter: "fake",
    credentialFields: [{ key: "apiKey", label: "API key", required: false }],
    actions: FAKE_ACTIONS,
  },
  {
    key: "zerobounce",
    name: "ZeroBounce",
    description: "Verify email addresses. Bring your own ZeroBounce API key. ZeroBounce charges nothing for an unknown result.",
    status: "available",
    adapter: "zerobounce",
    fixedBaseUrl: "https://api.zerobounce.net",
    credentialFields: API_KEY,
    actions: ZEROBOUNCE_ACTIONS,
  },
  {
    key: "millionverifier",
    name: "MillionVerifier",
    description: "Verify email addresses. Bring your own MillionVerifier API key. Unknown and catch-all results are refunded as credits.",
    status: "available",
    adapter: "millionverifier",
    fixedBaseUrl: "https://api.millionverifier.com",
    credentialFields: API_KEY,
    actions: MILLIONVERIFIER_ACTIONS,
  },
  {
    key: "neverbounce",
    name: "NeverBounce",
    description: "Verify email addresses as they come in. Bring your own NeverBounce API key. NeverBounce may lock a key that checks an existing list one by one, so verify a whole list in NeverBounce's bulk tool instead.",
    status: "available",
    adapter: "neverbounce",
    fixedBaseUrl: "https://api.neverbounce.com",
    credentialFields: API_KEY,
    actions: NEVERBOUNCE_ACTIONS,
  },
  {
    key: "findymail",
    name: "Findymail",
    description: "Find verified work emails from a name and a company domain. Bring your own Findymail API key. A search that finds nothing is free.",
    status: "available",
    adapter: "findymail",
    fixedBaseUrl: "https://app.findymail.com",
    credentialFields: API_KEY,
    actions: FINDYMAIL_ACTIONS,
  },
  {
    key: "prospeo",
    name: "Prospeo",
    description: "Find verified work emails from a name and a company domain. Bring your own Prospeo API key. A search that finds nothing is free.",
    status: "available",
    adapter: "prospeo",
    fixedBaseUrl: "https://api.prospeo.io",
    credentialFields: API_KEY,
    // The Starter plan's limit; raise it on the provider for a larger plan.
    defaultRateLimitPerMin: 300,
    actions: PROSPEO_ACTIONS,
  },
  {
    key: "leadmagic",
    name: "LeadMagic",
    description: "Find work emails from a name and a company domain. Bring your own LeadMagic API key. A search that finds nothing is free.",
    status: "available",
    adapter: "leadmagic",
    fixedBaseUrl: "https://api.leadmagic.io",
    credentialFields: API_KEY,
    defaultRateLimitPerMin: 600,
    actions: LEADMAGIC_ACTIONS,
  },
  {
    key: "peopledatalabs",
    name: "People Data Labs",
    description: "Enrich a person (work email, title, company, LinkedIn URL) or a company. Bring your own People Data Labs API key. Only a match is billed, and person matches below a likelihood of 6 are dropped.",
    status: "available",
    adapter: "peopledatalabs",
    fixedBaseUrl: "https://api.peopledatalabs.com",
    credentialFields: API_KEY,
    // The free plan's person limit. Company lookups allow 10 a minute on that plan and retry when PDL says so.
    defaultRateLimitPerMin: 100,
    actions: PEOPLEDATALABS_ACTIONS,
  },
  catalogOnly("cleanlist", "Cleanlist", "Contact enrichment."),
  catalogOnly("snov", "Snov.io", "Email finder and verifier."),
  catalogOnly("contactout", "ContactOut", "Contact details lookup."),
  catalogOnly("fullenrich", "FullEnrich", "Waterfall contact enrichment."),
  catalogOnly("lusha", "Lusha", "Contact and company data."),
  catalogOnly("rocketreach", "RocketReach", "Contact lookup."),
  catalogOnly("icypeas", "Icypeas", "Email finder and verifier."),
];

/** Adapters a provider row can name without its own config: every native vendor, plus the fake one. */
export const SIMPLE_ADAPTER_KEYS: readonly string[] = PROVIDER_CATALOG.flatMap((e) => (e.status === "available" && e.adapter && e.adapter !== "http" ? [e.adapter] : []));

export const catalogEntry = (key: string): CatalogEntry | undefined => PROVIDER_CATALOG.find((e) => e.key === key);
