import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { aiConnection, type AiConnectionKey } from "../domain/ai-connections";
import { runningAi } from "./ai-model";
import { EXTERNAL_PROVIDERS, managedProvider, validateCredentialInput } from "../domain/providers";
import { assertCredentialVerified, type CredentialVerifier } from "@/platform/credentials/verify";

/** What the UI may see about a connection. There is deliberately no field for the secret. */
export interface IntegrationView {
  id: string;
  kind: string;
  key: string;
  name: string;
  enabled: boolean;
  hasCredential: boolean;
  credentialUpdatedAt: Date | null;
  updatedAt: Date;
  /** Set for providers with their own settings page. */
  manageHref: string | null;
  /** The AI connection that runs AI now: picked and with a model. False for every other account. */
  runsAi: boolean;
  /**
   * For the account that runs AI: where AI moves if it is removed, as that account's name. Null when AI would turn off
   * (no other key, or the next one has no model), and for every account that does not run AI.
   */
  removalMovesAiTo: string | null;
}

export interface IntegrationStore {
  /** `primary` and `model`: the AI choice in the account's config. */
  list(organizationId: string): Promise<Array<Omit<IntegrationView, "manageHref" | "runsAi" | "removalMovesAiTo"> & { primary: boolean; model: string | null }>>;
  get(organizationId: string, id: string): Promise<{ id: string; key: string } | null>;
  /** Creates the account or replaces its credential for the same provider key. */
  saveCredential(
    organizationId: string,
    account: { kind: string; key: string; name: string },
    encryptedPayload: string,
    /** The store writes the `integration.saved` audit row in the same transaction. `verified` is false when no live check ran. */
    audit: { actorUserId: string; verified: boolean },
  ): Promise<{ id: string; created: boolean }>;
  /** Deletes the account and writes the `integration.deleted` audit row in the same transaction. */
  delete(organizationId: string, account: { id: string; key: string }, audit: { actorUserId: string }): Promise<void>;
}

export interface CredentialCipher {
  encrypt(plaintext: string): string;
}

export interface IntegrationDeps {
  integrations: IntegrationStore;
  cipher: CredentialCipher;
  verifier: CredentialVerifier;
}

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can manage integrations.");
}

export async function listIntegrations(deps: IntegrationDeps, actor: Actor): Promise<IntegrationView[]> {
  requireAdmin(actor);
  const rows = await deps.integrations.list(actor.organizationId);
  // The same rule the model resolver runs: an AI key with no model (a gateway nobody picked one for) runs nothing.
  const aiRows = rows.filter((row) => row.kind === "ai" && row.enabled && row.hasCredential && aiConnection(row.key));
  const accounts = aiRows.map((row) => ({ accountId: row.id, key: row.key as AiConnectionKey, encryptedPayload: "", model: row.model, primary: row.primary }));
  const running = runningAi(accounts)?.account ?? null;
  const after = running ? runningAi(accounts.filter((a) => a.accountId !== running.accountId))?.account : null;
  const nameOf = (accountId: string | undefined) => rows.find((row) => row.id === accountId)?.name ?? null;
  return rows.map(({ id, kind, key, name, enabled, hasCredential, credentialUpdatedAt, updatedAt }) => ({
    id,
    kind,
    key,
    name,
    enabled,
    hasCredential,
    credentialUpdatedAt,
    updatedAt,
    manageHref: EXTERNAL_PROVIDERS[key]?.href ?? null,
    runsAi: id === running?.accountId,
    removalMovesAiTo: id === running?.accountId ? nameOf(after?.accountId) : null,
  }));
}

/** Adds the provider's credential, or rotates it when one is already stored. */
export async function saveIntegrationCredential(
  deps: IntegrationDeps,
  actor: Actor,
  input: { providerKey: string; values: Record<string, unknown> },
): Promise<{ id: string; created: boolean }> {
  requireAdmin(actor);
  const spec = managedProvider(input.providerKey);
  if (!spec) throw new ValidationError("This provider is not managed here.");
  const checked = validateCredentialInput(spec, input.values);
  if (!checked.ok) throw new ValidationError(checked.reason);
  // Order: validate shape, verify with the provider, encrypt, store. A rejected key reaches neither the cipher nor the store.
  const verified = await assertCredentialVerified(deps.verifier, { key: spec.key, name: spec.label }, checked.values);
  return deps.integrations.saveCredential(
    actor.organizationId,
    { kind: spec.kind, key: spec.key, name: spec.label },
    deps.cipher.encrypt(JSON.stringify(checked.values)),
    { actorUserId: actor.userId, verified },
  );
}

export async function deleteIntegration(deps: IntegrationDeps, actor: Actor, id: string): Promise<void> {
  requireAdmin(actor);
  const account = await deps.integrations.get(actor.organizationId, id);
  if (!account) throw new NotFoundError("Integration not found");
  if (!managedProvider(account.key)) throw new ValidationError("This connection is managed on its own settings page.");
  await deps.integrations.delete(actor.organizationId, account, { actorUserId: actor.userId });
}
