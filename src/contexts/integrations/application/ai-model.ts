import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, ValidationError, type Actor } from "@/shared/errors";

/** The model the code uses when neither the organization nor `AI_MODEL` names one. */
export const DEFAULT_AI_MODEL = "claude-sonnet-5-5";

/**
 * Models accepted when Anthropic's live list cannot be reached. The live list is the source of truth;
 * this list only keeps a save possible during an outage for ids that were valid when it was written.
 */
export const KNOWN_AI_MODELS: readonly string[] = ["claude-sonnet-5-5", "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,99}$/;

export type ModelListResult = { ok: true; ids: string[] } | { ok: false; reason: "rejected" | "unreachable" };

/** Lists the models the saved Anthropic key can use (GET /v1/models). */
export interface ModelCatalog {
  list(apiKey: string): Promise<ModelListResult>;
}

export interface AiModelStore {
  /** The organization's enabled Anthropic account with its decrypted-on-demand credential and config. */
  getAnthropic(organizationId: string): Promise<{ accountId: string; encryptedPayload: string; model: string | null } | null>;
  /** Merges `model` into `config` (other keys stay) and writes the `integration.ai_model_changed` audit row in the same transaction. A null model removes the key. */
  saveModel(organizationId: string, accountId: string, model: string | null, audit: { actorUserId: string; from: string | null }): Promise<void>;
}

export interface AiModelDeps {
  store: AiModelStore;
  catalog: ModelCatalog;
  decrypt(envelope: string): string;
  /** AI_PROVIDER=fake: no call to Anthropic, the known list applies. */
  skipLive: boolean;
  /** `AI_MODEL` from the environment, shown as the effective default. */
  envModel?: string;
}

export interface AiModelView {
  connected: boolean;
  /** The organization's own choice. Null means the default applies. */
  model: string | null;
  /** What `aiResolver` uses right now. */
  effective: string;
  choices: string[];
  /** True when `choices` came from Anthropic, false when it is the built-in list. */
  live: boolean;
  notice: string | null;
}

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can choose the AI model.");
}

async function keyOf(deps: AiModelDeps, encryptedPayload: string): Promise<string | null> {
  try {
    const { apiKey } = JSON.parse(deps.decrypt(encryptedPayload)) as { apiKey?: string };
    return apiKey || null;
  } catch {
    return null;
  }
}

async function liveChoices(deps: AiModelDeps, encryptedPayload: string): Promise<ModelListResult> {
  if (deps.skipLive) return { ok: false, reason: "unreachable" };
  const apiKey = await keyOf(deps, encryptedPayload);
  if (!apiKey) return { ok: false, reason: "rejected" };
  return deps.catalog.list(apiKey);
}

export async function getAiModel(deps: AiModelDeps, actor: Actor): Promise<AiModelView> {
  requireAdmin(actor);
  const account = await deps.store.getAnthropic(actor.organizationId);
  const fallback = deps.envModel || DEFAULT_AI_MODEL;
  if (!account) return { connected: false, model: null, effective: fallback, choices: [], live: false, notice: "Save an Anthropic key above, then choose a model here." };
  const result = await liveChoices(deps, account.encryptedPayload);
  const effective = account.model || fallback;
  if (result.ok) return { connected: true, model: account.model, effective, choices: result.ids, live: true, notice: null };
  const notice =
    result.reason === "rejected" ? "Anthropic rejected the saved key, so the live model list is unavailable. Save the key again." : "The live model list could not be loaded. Showing the built-in list.";
  return { connected: true, model: account.model, effective, choices: [...KNOWN_AI_MODELS], live: false, notice };
}

/** Saves the organization's default model, or clears it with null or an empty string. */
export async function setAiModel(deps: AiModelDeps, actor: Actor, input: { model: string | null }): Promise<AiModelView> {
  requireAdmin(actor);
  const account = await deps.store.getAnthropic(actor.organizationId);
  if (!account) throw new ValidationError("Save an Anthropic key before you choose a model.");
  const model = input.model?.trim() || null;
  if (model !== null) {
    if (!MODEL_ID.test(model)) throw new ValidationError("That is not a valid model ID. Pick one from the list.");
    const result = await liveChoices(deps, account.encryptedPayload);
    if (result.ok) {
      if (!result.ids.includes(model)) throw new ValidationError(`Anthropic does not list ${model} for this key. Pick one from the list.`);
    } else if (result.reason === "rejected") {
      throw new ValidationError("Anthropic rejected the saved key, so the model cannot be checked. Save the key again.");
    } else if (!KNOWN_AI_MODELS.includes(model)) {
      throw new ValidationError(`Anthropic's model list could not be reached, and ${model} is not in the built-in list. Try again shortly.`);
    }
  }
  if (model !== account.model) await deps.store.saveModel(actor.organizationId, account.accountId, model, { actorUserId: actor.userId, from: account.model });
  return getAiModel(deps, actor);
}
