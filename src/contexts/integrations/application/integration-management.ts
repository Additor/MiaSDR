import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { EXTERNAL_PROVIDERS, managedProvider, validateCredentialInput } from "../domain/providers";
import { assertCredentialVerified, type CredentialVerifier } from "./credential-verifier";

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
}

export interface IntegrationStore {
  list(organizationId: string): Promise<Omit<IntegrationView, "manageHref">[]>;
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
  return rows.map((row) => ({ ...row, manageHref: EXTERNAL_PROVIDERS[row.key]?.href ?? null }));
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
