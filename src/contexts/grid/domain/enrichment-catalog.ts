/**
 * Enrichment provider catalog. `available` providers have an adapter in this codebase.
 * `catalog_only` providers are listed by name, but nothing can call them: they have no adapter. The generic `http` adapter can stand in for any of them when the
 * operator allow-lists the host.
 */

export type ProviderStatus = "available" | "catalog_only";
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
  adapter: "hunter" | "apollo" | "http" | "fake" | null;
  /** Fixed API host for adapters that call one vendor. The saved base URL must equal it. */
  fixedBaseUrl?: string;
  credentialFields: CredentialField[];
  /** Static actions. The `http` adapter reads its actions from the provider config instead. */
  actions: ActionSpec[];
}

const API_KEY: CredentialField[] = [{ key: "apiKey", label: "API key", required: true }];

export const HUNTER_ACTIONS: ActionSpec[] = [
  {
    key: "verify-email",
    name: "Verify email",
    inputs: [{ key: "email", name: "Email", type: "email", required: true }],
    outputs: [
      { key: "email", name: "Email", type: "email" },
      { key: "status", name: "Status", type: "text" },
      { key: "score", name: "Score", type: "number" },
      { key: "acceptAll", name: "Accept all", type: "boolean" },
      { key: "disposable", name: "Disposable", type: "boolean" },
      { key: "webmail", name: "Webmail", type: "boolean" },
    ],
    primaryOutput: "status",
    defaultCostCents: 0,
  },
  {
    key: "find-work-email",
    name: "Find work email",
    inputs: [
      { key: "fullName", name: "Full name", type: "text", required: true },
      { key: "companyDomain", name: "Company domain", type: "domain", required: true },
    ],
    outputs: [
      { key: "email", name: "Work email", type: "email" },
      { key: "score", name: "Score", type: "number" },
      { key: "verificationStatus", name: "Verification status", type: "text" },
      { key: "position", name: "Position", type: "text" },
      { key: "linkedinUrl", name: "LinkedIn URL", type: "url" },
    ],
    primaryOutput: "email",
    defaultCostCents: 0,
  },
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

/**
 * Apollo. Inputs are optional because Apollo matches on any of several identities; the adapter refuses a call
 * that has none of the usable combinations. The adapter never asks Apollo to reveal phone numbers or personal emails.
 */
export const APOLLO_ACTIONS: ActionSpec[] = [
  {
    key: "enrich-person",
    name: "Enrich person",
    inputs: [
      { key: "email", name: "Email", type: "email", required: false },
      { key: "fullName", name: "Full name", type: "text", required: false },
      { key: "companyDomain", name: "Company domain", type: "domain", required: false },
      { key: "linkedinUrl", name: "LinkedIn URL", type: "url", required: false },
    ],
    outputs: [
      { key: "email", name: "Work email", type: "email" },
      { key: "emailStatus", name: "Email status", type: "text" },
      { key: "title", name: "Title", type: "text" },
      { key: "company", name: "Company", type: "text" },
      { key: "linkedinUrl", name: "LinkedIn URL", type: "url" },
      { key: "matchConfidence", name: "Match confidence", type: "text" },
    ],
    primaryOutput: "email",
    defaultCostCents: 0,
  },
  {
    key: "enrich-company",
    name: "Enrich company",
    inputs: [{ key: "companyDomain", name: "Company domain", type: "domain", required: true }],
    outputs: [
      { key: "name", name: "Company name", type: "text" },
      { key: "industry", name: "Industry", type: "text" },
      { key: "employeeCount", name: "Employees", type: "number" },
      { key: "websiteUrl", name: "Website", type: "url" },
      { key: "linkedinUrl", name: "LinkedIn URL", type: "url" },
      { key: "city", name: "City", type: "text" },
      { key: "country", name: "Country", type: "text" },
    ],
    primaryOutput: "name",
    defaultCostCents: 0,
  },
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

export const catalogEntry = (key: string): CatalogEntry | undefined => PROVIDER_CATALOG.find((e) => e.key === key);
