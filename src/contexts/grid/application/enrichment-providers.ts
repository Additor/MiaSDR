import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { assertCredentialVerified, type CredentialVerifier } from "@/contexts/integrations/application/credential-verifier";
import { catalogEntry, PROVIDER_CATALOG, type ActionSpec, type CatalogEntry } from "../domain/enrichment-catalog";
import { checkHttpConfig, httpProviderConfigSchema, simpleAdapterConfigSchema } from "../domain/enrichment-config";
import { parseProviderBaseUrl, type UrlPolicy } from "../domain/enrichment-url-policy";
import type { AdapterRegistry, CredentialCipher, ProviderRecord, ProviderStore } from "./enrichment-ports";

export interface ProviderDeps {
  providers: ProviderStore;
  cipher: CredentialCipher;
  adapters: AdapterRegistry;
  urlPolicy: UrlPolicy;
  /** The `fake` adapter answers without a network. Off unless the operator turns it on. */
  allowFake: boolean;
  /** Checks a new or replaced key against the vendor before it is stored. Adapters without a verifier (http, fake) pass. */
  verifier?: CredentialVerifier;
}

/** What clients see of a provider. There is no field that can hold the credential. */
export interface ProviderView {
  id: string;
  key: string;
  name: string;
  adapter: string;
  baseUrl: string | null;
  defaultCostCents: number;
  rateLimitPerMin: number | null;
  enabled: boolean;
  hasCredential: boolean;
  actions: ActionSpec[];
  config: Record<string, unknown>;
  updatedAt: Date;
}

export interface ProviderInput {
  adapter: string;
  key?: string;
  name?: string;
  baseUrl?: string;
  defaultCostCents?: number;
  rateLimitPerMin?: number | null;
  config?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
}

const KEY = /^[a-z][a-z0-9_-]*$/;

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can manage enrichment providers.");
}

export function toView(deps: Pick<ProviderDeps, "adapters">, p: ProviderRecord): ProviderView {
  const adapter = typeof p.config.adapter === "string" ? p.config.adapter : "";
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    adapter,
    baseUrl: p.baseUrl,
    defaultCostCents: p.defaultCostCents,
    rateLimitPerMin: p.rateLimitPerMin,
    enabled: p.enabled,
    hasCredential: p.hasCredential,
    actions: deps.adapters.adapterFor(p)?.actions(p) ?? [],
    config: p.config,
    updatedAt: p.updatedAt,
  };
}

export function listCatalog(allowFake: boolean): Array<Omit<CatalogEntry, "actions"> & { actions: ActionSpec[] }> {
  return PROVIDER_CATALOG.filter((e) => e.adapter !== "fake" || allowFake).map((e) => ({ ...e }));
}

export async function listProviders(deps: ProviderDeps, actor: Actor): Promise<ProviderView[]> {
  return (await deps.providers.list(actor.organizationId)).map((p) => toView(deps, p));
}

function cleanCredentials(entry: CatalogEntry, input: Record<string, unknown>): Record<string, string> {
  const allowed = new Set(entry.credentialFields.map((f) => f.key));
  if (Object.keys(input).some((k) => !allowed.has(k))) throw new ValidationError("One or more credential fields are not valid for this provider.");
  const out: Record<string, string> = {};
  for (const field of entry.credentialFields) {
    const raw = input[field.key];
    if (raw !== undefined && typeof raw !== "string") throw new ValidationError("Credential values must be text.");
    const value = (raw ?? "").trim();
    if (field.required && !value) throw new ValidationError(`${field.label} is required.`);
    if (value.length > 4096) throw new ValidationError("A credential value is too long.");
    if (/[\r\n]/.test(value)) throw new ValidationError("A credential value cannot contain line breaks.");
    if (value) out[field.key] = value;
  }
  return out;
}

function checkNumbers(input: { defaultCostCents?: number; rateLimitPerMin?: number | null }) {
  const cost = input.defaultCostCents;
  if (cost !== undefined && (!Number.isFinite(cost) || cost < 0 || cost > 10_000)) throw new ValidationError("defaultCostCents must be between 0 and 10000.");
  const rate = input.rateLimitPerMin;
  if (rate !== undefined && rate !== null && (!Number.isInteger(rate) || rate < 1 || rate > 100_000)) throw new ValidationError("rateLimitPerMin must be a whole number of at least 1.");
}

/** Validates the adapter config and base URL together. Returns what to store. */
function checkAdapterConfig(deps: ProviderDeps, entry: CatalogEntry, baseUrl: string | undefined, config: Record<string, unknown> | undefined) {
  if (entry.adapter === "http") {
    const parsed = httpProviderConfigSchema.safeParse({ ...config, adapter: "http" });
    if (!parsed.success) throw new ValidationError(`Provider config is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const problem = checkHttpConfig(parsed.data);
    if (problem) throw new ValidationError(problem);
    const url = parseProviderBaseUrl(baseUrl ?? "", deps.urlPolicy);
    if (!url) throw new ValidationError("That base URL is not allowed. It must be https, a plain hostname, and listed in GRID_HTTP_ALLOWED_HOSTS.");
    return { baseUrl: url.base, config: parsed.data as Record<string, unknown> };
  }
  const parsed = simpleAdapterConfigSchema.safeParse({ adapter: entry.adapter });
  if (!parsed.success) throw new ValidationError("Provider config is invalid.");
  if (baseUrl && entry.fixedBaseUrl && baseUrl.replace(/\/+$/, "") !== entry.fixedBaseUrl) throw new ValidationError(`${entry.name} always uses ${entry.fixedBaseUrl}.`);
  return { baseUrl: entry.fixedBaseUrl ?? null, config: { adapter: entry.adapter } as Record<string, unknown> };
}

export async function createProvider(deps: ProviderDeps, actor: Actor, input: ProviderInput): Promise<ProviderView> {
  requireAdmin(actor);
  const entry = catalogEntry(input.adapter);
  if (!entry) throw new ValidationError("Unknown provider.");
  if (entry.status === "catalog_only" || !entry.adapter) throw new ValidationError(`${entry.name} has no adapter in this app yet. Use the Custom HTTP API provider with your own key.`);
  if (entry.adapter === "fake" && !deps.allowFake) throw new ValidationError("The fake provider is disabled on this server.");
  const key = input.key ?? entry.key;
  if (!KEY.test(key) || key.length > 60) throw new ValidationError("The provider key must be lower-case letters, digits, - or _, starting with a letter.");
  checkNumbers(input);
  const name = (input.name ?? entry.name).trim();
  if (!name || name.length > 120) throw new ValidationError("The provider name must be 1 to 120 characters.");
  const adapter = checkAdapterConfig(deps, entry, input.baseUrl, input.config);
  const credentials = cleanCredentials(entry, input.credentials ?? {});
  if (Object.keys(credentials).length) await assertCredentialVerified(deps.verifier, { key: entry.adapter, name: entry.name }, credentials);
  const envelope = Object.keys(credentials).length ? deps.cipher.encrypt(JSON.stringify(credentials)) : null;
  const created = await deps.providers.create(
    actor.organizationId,
    { key, name, baseUrl: adapter.baseUrl, defaultCostCents: input.defaultCostCents ?? 0, rateLimitPerMin: input.rateLimitPerMin === undefined ? (entry.defaultRateLimitPerMin ?? null) : input.rateLimitPerMin, config: adapter.config },
    envelope,
  );
  return toView(deps, created);
}

export interface ProviderUpdate {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  defaultCostCents?: number;
  rateLimitPerMin?: number | null;
  config?: Record<string, unknown>;
  /** Replaces the stored credential. Send nothing to keep it. */
  credentials?: Record<string, unknown>;
}

export async function updateProvider(deps: ProviderDeps, actor: Actor, id: string, input: ProviderUpdate): Promise<ProviderView> {
  requireAdmin(actor);
  const current = await deps.providers.get(actor.organizationId, id);
  if (!current) throw new NotFoundError("Provider not found");
  const entry = catalogEntry(String(current.config.adapter ?? ""));
  if (!entry) throw new ValidationError("This provider's adapter is no longer available.");
  checkNumbers(input);
  if (input.name !== undefined && (!input.name.trim() || input.name.length > 120)) throw new ValidationError("The provider name must be 1 to 120 characters.");
  if (entry.adapter === "fake" && !deps.allowFake && input.enabled) throw new ValidationError("The fake provider is disabled on this server.");

  let patch: Parameters<ProviderStore["update"]>[2] = { name: input.name?.trim(), enabled: input.enabled, defaultCostCents: input.defaultCostCents, rateLimitPerMin: input.rateLimitPerMin };
  if (input.baseUrl !== undefined || input.config !== undefined) {
    const checked = checkAdapterConfig(deps, entry, input.baseUrl ?? current.baseUrl ?? undefined, input.config ?? current.config);
    patch = { ...patch, baseUrl: checked.baseUrl, config: checked.config };
  }
  let envelope: string | undefined;
  if (input.credentials !== undefined) {
    const credentials = cleanCredentials(entry, input.credentials);
    if (Object.keys(credentials).length === 0) throw new ValidationError("Send at least one credential value, or omit credentials to keep the stored one.");
    await assertCredentialVerified(deps.verifier, { key: entry.adapter ?? "", name: entry.name }, credentials);
    envelope = deps.cipher.encrypt(JSON.stringify(credentials));
  }
  const updated = await deps.providers.update(actor.organizationId, id, patch, envelope);
  if (!updated) throw new NotFoundError("Provider not found");
  return toView(deps, updated);
}

export async function deleteProvider(deps: ProviderDeps, actor: Actor, id: string): Promise<void> {
  requireAdmin(actor);
  if (!(await deps.providers.delete(actor.organizationId, id))) throw new NotFoundError("Provider not found");
}
