import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, ValidationError, type Actor } from "@/shared/errors";
import type { AiStatus } from "../domain/ai-status";
import { aiConnection, effectiveAiModel, pickActiveAiConnection, type AiConnectionKey, type AiConnectionSpec } from "../domain/ai-connections";

export { DEFAULT_AI_MODEL, KNOWN_AI_MODELS } from "../domain/ai-connections";

/** Anthropic ids, and gateway ids such as `anthropic/claude-sonnet-5.5` or `openai/gpt-6:free`. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,149}$/;

export type ModelListResult = { ok: true; ids: string[] } | { ok: false; reason: "rejected" | "unreachable" };

/** Lists the models a connection offers. Anthropic needs the saved key; the gateways' lists are public. */
export interface ModelCatalog {
  list(spec: AiConnectionSpec, apiKey: string): Promise<ModelListResult>;
}

export interface AiAccount {
  accountId: string;
  key: AiConnectionKey;
  encryptedPayload: string;
  model: string | null;
  /** Marked as the connection AI runs on. */
  primary: boolean;
}

export interface AiModelStore {
  /** The organization's enabled AI accounts, with their encrypted credential and config. */
  listAi(organizationId: string): Promise<AiAccount[]>;
  /**
   * Makes `accountId` the connection AI runs on, with `model` (null clears it), and unmarks the others. Writes the
   * `integration.ai_model_changed` audit row in the same transaction.
   */
  saveChoice(organizationId: string, accountId: string, model: string | null, audit: { actorUserId: string; from: { connection: string | null; model: string | null }; to: { connection: string; model: string | null } }): Promise<void>;
}

export interface AiModelDeps {
  store: AiModelStore;
  catalog: ModelCatalog;
  decrypt(envelope: string): string;
  /** AI_PROVIDER=fake: no call to any provider, the known list applies. */
  skipLive: boolean;
  /** `AI_MODEL` from the environment, the default on a direct Anthropic connection. */
  envModel?: string;
}

export interface AiModelView {
  /** Whether AI runs for the organization and on what, whichever connection this view describes. */
  status: AiStatus;
  connected: boolean;
  /** Every connection with a saved key, in settings order. */
  connections: Array<{ key: string; label: string }>;
  /** The connection AI runs on. */
  active: string | null;
  /** The connection this view describes: the one asked for, else the active one. */
  connection: string | null;
  /** The organization's own choice on `connection`. Null means the default applies. */
  model: string | null;
  /** What runs on `connection`. Null when it has no default and nothing is picked. */
  effective: string | null;
  /** What runs on `connection` with no pick. Null on the gateways, which need one. */
  defaultModel: string | null;
  choices: string[];
  /** True when `choices` came from the provider, false when it is the built-in list or empty. */
  live: boolean;
  /** The provider turned down the saved key on `connection`: no model can be checked, and AI calls on it fail. */
  keyRejected: boolean;
  notice: string | null;
}

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can choose the AI model.");
}

/** The API key inside a decrypted AI credential, or null when the payload has none or does not parse. */
export function apiKeyOf(decrypted: () => string): string | null {
  try {
    const { apiKey } = JSON.parse(decrypted()) as { apiKey?: string };
    return apiKey || null;
  } catch {
    return null;
  }
}

/**
 * The account AI runs on and the model it runs, or null when AI is off: no AI key saved, or a connection with no
 * default and no model picked. The settings card and the model resolver both read this, so they agree.
 */
export function runningAi(accounts: readonly AiAccount[], envModel?: string): { account: AiAccount; spec: AiConnectionSpec; model: string } | null {
  const account = pickActiveAiConnection(accounts);
  const spec = account && aiConnection(account.key);
  if (!account || !spec) return null;
  const model = effectiveAiModel(spec, account.model, envModel);
  return model ? { account, spec, model } : null;
}

/** The organization's AI status from its saved AI accounts. Demo mode is the caller's switch, since it skips every account. */
export function aiStatusOf(accounts: readonly AiAccount[], envModel?: string): AiStatus {
  const running = runningAi(accounts, envModel);
  if (running) return { state: "on", provider: running.spec.label, model: running.model };
  const active = pickActiveAiConnection(accounts);
  const spec = active && aiConnection(active.key);
  return spec ? { state: "no_model", provider: spec.label } : { state: "no_key" };
}

async function liveChoices(deps: AiModelDeps, spec: AiConnectionSpec, account: AiAccount): Promise<ModelListResult> {
  if (deps.skipLive) return { ok: false, reason: "unreachable" };
  const apiKey = apiKeyOf(() => deps.decrypt(account.encryptedPayload));
  if (!apiKey) return { ok: false, reason: "rejected" };
  return deps.catalog.list(spec, apiKey);
}

async function load(deps: AiModelDeps, actor: Actor, connection?: string) {
  const accounts = (await deps.store.listAi(actor.organizationId)).filter((a) => aiConnection(a.key));
  const active = pickActiveAiConnection(accounts);
  const target = connection ? accounts.find((a) => a.key === connection) : active;
  if (connection && !target) throw new ValidationError("That AI provider is not connected. Save its key above first.");
  return { accounts, active, target: target ?? null };
}

export async function getAiModel(deps: AiModelDeps, actor: Actor, query: { connection?: string } = {}): Promise<AiModelView> {
  requireAdmin(actor);
  const { accounts, active, target } = await load(deps, actor, query.connection);
  const connections = accounts.map((a) => ({ key: a.key, label: aiConnection(a.key)!.label }));
  const status: AiStatus = deps.skipLive ? { state: "demo" } : aiStatusOf(accounts, deps.envModel);
  if (!target) {
    return { status, connected: false, connections, active: null, connection: null, model: null, effective: null, defaultModel: null, choices: [], live: false, keyRejected: false, notice: "Connect an AI provider above, then choose a model here." };
  }
  const spec = aiConnection(target.key)!;
  const effective = effectiveAiModel(spec, target.model, deps.envModel);
  const base = { status, connected: true, connections, active: active?.key ?? null, connection: target.key, model: target.model, effective, defaultModel: effectiveAiModel(spec, null, deps.envModel) };
  const result = await liveChoices(deps, spec, target);
  if (result.ok) return { ...base, choices: result.ids, live: true, keyRejected: false, notice: null };
  // The card words a rejected key itself and offers no models: a save would fail on the same key.
  if (result.reason === "rejected") return { ...base, choices: [], live: false, keyRejected: true, notice: null };
  const notice =
    spec.fallbackModels.length > 0
        ? "The live model list could not be loaded. Showing the built-in list."
        : "The live model list could not be loaded. Try again shortly.";
  return { ...base, choices: [...spec.fallbackModels], live: false, keyRejected: false, notice };
}

/** Runs AI on `connection` (default: the active one) with `model`, or that connection's default with null. */
export async function setAiModel(deps: AiModelDeps, actor: Actor, input: { connection?: string; model: string | null }): Promise<AiModelView> {
  requireAdmin(actor);
  const { active, target } = await load(deps, actor, input.connection);
  if (!target) throw new ValidationError("Connect an AI provider before you choose a model.");
  const spec = aiConnection(target.key)!;
  const model = input.model?.trim() || null;
  if (model === null && !spec.defaultModel) throw new ValidationError(`Pick a ${spec.label} model from the list.`);
  if (model !== null) {
    if (!MODEL_ID.test(model)) throw new ValidationError("That is not a valid model ID. Pick one from the list.");
    const result = await liveChoices(deps, spec, target);
    if (result.ok) {
      if (!result.ids.includes(model)) throw new ValidationError(`${spec.label} does not list ${model} for this key. Pick one from the list.`);
    } else if (result.reason === "rejected") {
      throw new ValidationError(`${spec.label} rejected the saved key, so the model cannot be checked. Save the key again.`);
    } else if (!spec.fallbackModels.includes(model)) {
      throw new ValidationError(
        spec.fallbackModels.length > 0
          ? `${spec.label}'s model list could not be reached, and ${model} is not in the built-in list. Try again shortly.`
          : `${spec.label}'s model list could not be reached, so ${model} cannot be checked. Try again shortly.`,
      );
    }
  }
  if (target.accountId !== active?.accountId || model !== target.model) {
    await deps.store.saveChoice(actor.organizationId, target.accountId, model, {
      actorUserId: actor.userId,
      from: { connection: active?.key ?? null, model: active?.model ?? null },
      to: { connection: target.key, model },
    });
  }
  return getAiModel(deps, actor, { connection: target.key });
}
