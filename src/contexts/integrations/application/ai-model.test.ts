import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, ValidationError, type Actor } from "@/shared/errors";
import type { AiConnectionSpec } from "../domain/ai-connections";
import { aiStatusOf, apiKeyOf, getAiModel, KNOWN_AI_MODELS, runningAi, setAiModel, type AiAccount, type AiModelDeps, type ModelListResult } from "./ai-model";

const owner: Actor = { userId: "u1", organizationId: "o1", role: "owner" };
const member: Actor = { ...owner, role: "member" };
const LIVE = ["claude-sonnet-5-5", "claude-opus-9-9"];
const ROUTER = ["anthropic/claude-sonnet-5.5", "openai/gpt-6"];

function setup(options: { list?: ModelListResult; model?: string | null; connected?: boolean; skipLive?: boolean; envModel?: string; extra?: AiAccount[] } = {}) {
  let accounts: AiAccount[] =
    options.connected === false ? [] : [{ accountId: "a1", key: "anthropic", encryptedPayload: "enc", model: options.model ?? null, primary: false }, ...(options.extra ?? [])];
  const saveChoice = vi.fn(async (_o: string, accountId: string, next: string | null) => {
    accounts = accounts.map((a) => (a.accountId === accountId ? { ...a, model: next, primary: true } : { ...a, primary: false }));
  });
  const list = vi.fn<(spec: AiConnectionSpec, key: string) => Promise<ModelListResult>>(async (spec) =>
    options.list ?? { ok: true, ids: spec.key === "openrouter" ? ROUTER : LIVE },
  );
  const deps: AiModelDeps = {
    store: { listAi: async () => accounts, saveChoice },
    catalog: { list },
    decrypt: () => JSON.stringify({ apiKey: "sk-ant-SECRET" }),
    skipLive: options.skipLive ?? false,
    envModel: options.envModel,
  };
  return { deps, saveChoice, list };
}

describe("AI model setting", () => {
  it("refuses a member with 403 before any read or call", async () => {
    const { deps, list, saveChoice } = setup();
    await expect(getAiModel(deps, member)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setAiModel(deps, member, { model: "claude-opus-9-9" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(list).not.toHaveBeenCalled();
    expect(saveChoice).not.toHaveBeenCalled();
  });

  it("saves a model that the live list contains and passes the decrypted key to the catalog", async () => {
    const { deps, saveChoice, list } = setup();
    const view = await setAiModel(deps, owner, { model: " claude-opus-9-9 " });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ key: "anthropic" }), "sk-ant-SECRET");
    expect(saveChoice).toHaveBeenCalledWith("o1", "a1", "claude-opus-9-9", { actorUserId: "u1", from: { connection: "anthropic", model: null }, to: { connection: "anthropic", model: "claude-opus-9-9" } });
    expect(view).toMatchObject({ connection: "anthropic", active: "anthropic", model: "claude-opus-9-9", effective: "claude-opus-9-9", live: true, choices: LIVE });
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  it("refuses a model the live list does not contain, even one from the built-in list", async () => {
    const { deps, saveChoice } = setup();
    await expect(setAiModel(deps, owner, { model: "claude-haiku-5-5" })).rejects.toThrow("Anthropic does not list claude-haiku-5-5 for this key. Pick one from the list.");
    await expect(setAiModel(deps, owner, { model: "not a model!" })).rejects.toBeInstanceOf(ValidationError);
    expect(saveChoice).not.toHaveBeenCalled();
  });

  it("falls back to the built-in list when Anthropic's live list is unreachable", async () => {
    const { deps, saveChoice } = setup({ list: { ok: false, reason: "unreachable" } });
    await expect(setAiModel(deps, owner, { model: "claude-opus-9-9" })).rejects.toThrow("Anthropic's model list could not be reached, and claude-opus-9-9 is not in the built-in list. Try again shortly.");
    expect(saveChoice).not.toHaveBeenCalled();
    const view = await setAiModel(deps, owner, { model: KNOWN_AI_MODELS[1] });
    expect(saveChoice).toHaveBeenCalledOnce();
    expect(view).toMatchObject({ live: false, choices: [...KNOWN_AI_MODELS] });
    expect(view.notice).toContain("could not be loaded");
  });

  it("uses the built-in list without a call when AI_PROVIDER is fake", async () => {
    const { deps, list } = setup({ skipLive: true });
    await setAiModel(deps, owner, { model: "claude-sonnet-5" });
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a save when the provider rejects the saved key", async () => {
    const { deps, saveChoice } = setup({ list: { ok: false, reason: "rejected" } });
    await expect(setAiModel(deps, owner, { model: "claude-sonnet-5-5" })).rejects.toThrow("Anthropic rejected the saved key, so the model cannot be checked. Save the key again.");
    expect(saveChoice).not.toHaveBeenCalled();
  });

  it("refuses without a saved AI key", async () => {
    const { deps } = setup({ connected: false });
    await expect(setAiModel(deps, owner, { model: "claude-sonnet-5-5" })).rejects.toThrow("Connect an AI provider before you choose a model.");
    expect(await getAiModel(deps, owner)).toMatchObject({ connected: false, choices: [], effective: null, connections: [] });
  });

  it("clears the choice with null or an empty string, and reports the env default", async () => {
    const { deps, saveChoice, list } = setup({ model: "claude-opus-9-9", envModel: "claude-haiku-5-5" });
    expect(await getAiModel(deps, owner)).toMatchObject({ model: "claude-opus-9-9", effective: "claude-opus-9-9", defaultModel: "claude-haiku-5-5" });
    list.mockClear();
    const view = await setAiModel(deps, owner, { model: "  " });
    expect(saveChoice).toHaveBeenCalledWith("o1", "a1", null, expect.objectContaining({ from: { connection: "anthropic", model: "claude-opus-9-9" } }));
    expect(view).toMatchObject({ model: null, effective: "claude-haiku-5-5" });
    expect(list).toHaveBeenCalledTimes(1); // only the view's choices
  });

  it("writes nothing when the model is unchanged", async () => {
    const { deps, saveChoice } = setup({ model: "claude-sonnet-5-5" });
    await setAiModel(deps, owner, { model: "claude-sonnet-5-5" });
    expect(saveChoice).not.toHaveBeenCalled();
  });

  describe("several connections", () => {
    const router: AiAccount = { accountId: "a2", key: "openrouter", encryptedPayload: "enc2", model: null, primary: false };

    it("keeps running on Anthropic until another connection is chosen, and describes a saved one on request", async () => {
      const { deps } = setup({ extra: [router] });
      expect(await getAiModel(deps, owner)).toMatchObject({ active: "anthropic", connection: "anthropic", connections: [{ key: "anthropic" }, { key: "openrouter" }] });
      const other = await getAiModel(deps, owner, { connection: "openrouter" });
      expect(other).toMatchObject({ active: "anthropic", connection: "openrouter", effective: null, defaultModel: null, choices: ROUTER });
      expect(other.notice).toMatch(/Choose a OpenRouter model/);
      await expect(getAiModel(deps, owner, { connection: "vercel-ai-gateway" })).rejects.toThrow(/not connected/);
    });

    it("needs a model on a gateway, and switches AI to it when saved", async () => {
      const { deps, saveChoice } = setup({ extra: [router] });
      await expect(setAiModel(deps, owner, { connection: "openrouter", model: null })).rejects.toThrow("Pick a OpenRouter model from the list.");
      await expect(setAiModel(deps, owner, { connection: "openrouter", model: "claude-sonnet-5-5" })).rejects.toThrow(/OpenRouter does not list/);
      const view = await setAiModel(deps, owner, { connection: "openrouter", model: "openai/gpt-6" });
      expect(saveChoice).toHaveBeenCalledWith("o1", "a2", "openai/gpt-6", { actorUserId: "u1", from: { connection: "anthropic", model: null }, to: { connection: "openrouter", model: "openai/gpt-6" } });
      expect(view).toMatchObject({ active: "openrouter", connection: "openrouter", model: "openai/gpt-6", effective: "openai/gpt-6" });
    });

    it("has no built-in fallback for a gateway whose list is unreachable", async () => {
      const { deps, saveChoice } = setup({ extra: [router], list: { ok: false, reason: "unreachable" } });
      await expect(setAiModel(deps, owner, { connection: "openrouter", model: "openai/gpt-6" })).rejects.toThrow(/cannot be checked/);
      expect(saveChoice).not.toHaveBeenCalled();
      expect(await getAiModel(deps, owner, { connection: "openrouter" })).toMatchObject({ choices: [], live: false });
    });
  });

  describe("the running connection, as the model resolver reads it", () => {
    const account = (key: AiAccount["key"], model: string | null, primary = false): AiAccount => ({ accountId: key, key, encryptedPayload: "enc", model, primary });

    it("runs Anthropic with AI_MODEL, then the code default, when nothing is picked", () => {
      expect(runningAi([account("anthropic", null)], "claude-haiku-5-5")).toMatchObject({ model: "claude-haiku-5-5", spec: { key: "anthropic" } });
      expect(runningAi([account("anthropic", null)])).toMatchObject({ model: "claude-sonnet-5-5" });
    });

    it("keeps AI off on a gateway with no model, and ignores AI_MODEL there", () => {
      expect(runningAi([account("openrouter", null, true)], "claude-haiku-5-5")).toBeNull();
      expect(runningAi([account("openrouter", "openai/gpt-6", true), account("anthropic", null)])).toMatchObject({ model: "openai/gpt-6", account: { key: "openrouter" } });
      expect(runningAi([])).toBeNull();
    });

    it("tells a missing key from a missing model", () => {
      expect(aiStatusOf([])).toEqual({ state: "no_key" });
      expect(aiStatusOf([account("openrouter", null, true)])).toEqual({ state: "no_model", provider: "OpenRouter" });
      expect(aiStatusOf([account("anthropic", null)])).toEqual({ state: "on", provider: "Anthropic", model: "claude-sonnet-5-5" });
    });

    it("reads the key from a decrypted payload, and null from one that does not parse", () => {
      expect(apiKeyOf(() => JSON.stringify({ apiKey: "sk-1" }))).toBe("sk-1");
      expect(apiKeyOf(() => "{}")).toBeNull();
      expect(apiKeyOf(() => "not json")).toBeNull();
      expect(
        apiKeyOf(() => {
          throw new Error("bad envelope");
        }),
      ).toBeNull();
    });
  });
});
