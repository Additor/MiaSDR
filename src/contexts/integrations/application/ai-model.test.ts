import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, ValidationError, type Actor } from "@/shared/errors";
import { getAiModel, KNOWN_AI_MODELS, setAiModel, type AiModelDeps, type ModelListResult } from "./ai-model";

const owner: Actor = { userId: "u1", organizationId: "o1", role: "owner" };
const member: Actor = { ...owner, role: "member" };
const LIVE = ["claude-sonnet-5-5", "claude-opus-9-9"];

function setup(options: { list?: ModelListResult; model?: string | null; connected?: boolean; skipLive?: boolean; envModel?: string } = {}) {
  let model = options.model ?? null;
  const saveModel = vi.fn(async (_o: string, _a: string, next: string | null) => {
    model = next;
  });
  const list = vi.fn<(key: string) => Promise<ModelListResult>>(async () => options.list ?? { ok: true, ids: LIVE });
  const deps: AiModelDeps = {
    store: {
      getAnthropic: async () => (options.connected === false ? null : { accountId: "a1", encryptedPayload: "enc", model }),
      saveModel,
    },
    catalog: { list },
    decrypt: () => JSON.stringify({ apiKey: "sk-ant-SECRET" }),
    skipLive: options.skipLive ?? false,
    envModel: options.envModel,
  };
  return { deps, saveModel, list };
}

describe("AI model setting", () => {
  it("refuses a member with 403 before any read or call", async () => {
    const { deps, list, saveModel } = setup();
    await expect(getAiModel(deps, member)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setAiModel(deps, member, { model: "claude-opus-9-9" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(list).not.toHaveBeenCalled();
    expect(saveModel).not.toHaveBeenCalled();
  });

  it("saves a model that the live list contains and passes the decrypted key to the catalog", async () => {
    const { deps, saveModel, list } = setup();
    const view = await setAiModel(deps, owner, { model: " claude-opus-9-9 " });
    expect(list).toHaveBeenCalledWith("sk-ant-SECRET");
    expect(saveModel).toHaveBeenCalledWith("o1", "a1", "claude-opus-9-9", { actorUserId: "u1", from: null });
    expect(view).toMatchObject({ model: "claude-opus-9-9", effective: "claude-opus-9-9", live: true, choices: LIVE });
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  it("refuses a model the live list does not contain, even one from the built-in list", async () => {
    const { deps, saveModel } = setup();
    await expect(setAiModel(deps, owner, { model: "claude-haiku-4-5" })).rejects.toThrow("Anthropic does not list claude-haiku-4-5 for this key. Pick one from the list.");
    await expect(setAiModel(deps, owner, { model: "not a model!" })).rejects.toBeInstanceOf(ValidationError);
    expect(saveModel).not.toHaveBeenCalled();
  });

  it("falls back to the built-in list when the live list is unreachable", async () => {
    const { deps, saveModel } = setup({ list: { ok: false, reason: "unreachable" } });
    await expect(setAiModel(deps, owner, { model: "claude-opus-9-9" })).rejects.toThrow("Anthropic's model list could not be reached, and claude-opus-9-9 is not in the built-in list. Try again shortly.");
    expect(saveModel).not.toHaveBeenCalled();
    const view = await setAiModel(deps, owner, { model: KNOWN_AI_MODELS[1] });
    expect(saveModel).toHaveBeenCalledOnce();
    expect(view).toMatchObject({ live: false, choices: [...KNOWN_AI_MODELS] });
    expect(view.notice).toContain("could not be loaded");
  });

  it("uses the built-in list without a call when AI_PROVIDER is fake", async () => {
    const { deps, list } = setup({ skipLive: true });
    await setAiModel(deps, owner, { model: "claude-sonnet-4-5" });
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a save when Anthropic rejects the saved key", async () => {
    const { deps, saveModel } = setup({ list: { ok: false, reason: "rejected" } });
    await expect(setAiModel(deps, owner, { model: "claude-sonnet-5-5" })).rejects.toThrow("Anthropic rejected the saved key, so the model cannot be checked. Save the key again.");
    expect(saveModel).not.toHaveBeenCalled();
  });

  it("refuses without a saved Anthropic key", async () => {
    const { deps } = setup({ connected: false });
    await expect(setAiModel(deps, owner, { model: "claude-sonnet-5-5" })).rejects.toThrow("Save an Anthropic key before you choose a model.");
    expect(await getAiModel(deps, owner)).toMatchObject({ connected: false, choices: [], effective: "claude-sonnet-5-5" });
  });

  it("clears the choice with null or an empty string without a catalog call, and reports the env default", async () => {
    const { deps, saveModel, list } = setup({ model: "claude-opus-9-9", envModel: "claude-haiku-4-5" });
    expect(await getAiModel(deps, owner)).toMatchObject({ model: "claude-opus-9-9", effective: "claude-opus-9-9" });
    list.mockClear();
    const view = await setAiModel(deps, owner, { model: "  " });
    expect(saveModel).toHaveBeenCalledWith("o1", "a1", null, { actorUserId: "u1", from: "claude-opus-9-9" });
    expect(view).toMatchObject({ model: null, effective: "claude-haiku-4-5" });
    expect(list).toHaveBeenCalledTimes(1); // only the view's choices
  });

  it("writes nothing when the model is unchanged", async () => {
    const { deps, saveModel } = setup({ model: "claude-sonnet-5-5" });
    await setAiModel(deps, owner, { model: "claude-sonnet-5-5" });
    expect(saveModel).not.toHaveBeenCalled();
  });
});
