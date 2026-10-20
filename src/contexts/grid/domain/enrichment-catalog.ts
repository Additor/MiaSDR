/**
 * Enrichment provider catalog. `available` providers have an adapter in this codebase.
 * `catalog_only` providers are listed by name, but nothing can call them: they have no adapter. The generic `http` adapter can stand in for any of them when the
 * operator allow-lists the host.
 */

import { contractAction } from "./enrichment-contracts";

export type ProviderStatus = "available" | "catalog_only";
/** Vendors with a native adapter in `infrastructure/vendors`. The key is also the `config.adapter` value stored on provider rows. */
export type VendorAdapterKey = "hunter" | "apollo";
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
  catalogOnly("cleanlist", "Cleanlist", "Contact enrichment."),
  catalogOnly("snov", "Snov.io", "Email finder and verifier."),
  catalogOnly("millionverifier", "MillionVerifier", "Email verification."),
  catalogOnly("contactout", "ContactOut", "Contact details lookup."),
  catalogOnly("findymail", "Findymail", "Email finder."),
  catalogOnly("fullenrich", "FullEnrich", "Waterfall contact enrichment."),
  catalogOnly("leadmagic", "LeadMagic", "Email and mobile finder."),
  catalogOnly("lusha", "Lusha", "Contact and company data."),
  catalogOnly("zerobounce", "ZeroBounce", "Email validation."),
  catalogOnly("similarweb", "Similarweb", "Website traffic data."),
  catalogOnly("semrush", "Semrush", "SEO and domain metrics."),
  catalogOnly("rocketreach", "RocketReach", "Contact lookup."),
  catalogOnly("icypeas", "Icypeas", "Email finder and verifier."),
];

/** Adapters a provider row can name without its own config: every native vendor, plus the fake one. */
export const SIMPLE_ADAPTER_KEYS: readonly string[] = PROVIDER_CATALOG.flatMap((e) => (e.status === "available" && e.adapter && e.adapter !== "http" ? [e.adapter] : []));

export const catalogEntry = (key: string): CatalogEntry | undefined => PROVIDER_CATALOG.find((e) => e.key === key);
