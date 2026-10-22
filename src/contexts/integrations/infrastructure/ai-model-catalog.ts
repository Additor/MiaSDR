import { headerSafe } from "@/platform/credentials/key-check";
import { ANTHROPIC_VERSION, type AiConnectionSpec } from "../domain/ai-connections";
import type { ModelCatalog, ModelListResult } from "../application/ai-model";

const PAGE_SIZE = 1000;
const MAX_PAGES = 5;
const TIMEOUT_MS = 10_000;

type ModelRow = { id?: unknown; type?: unknown };

/**
 * A connection's model list. Anthropic: GET /v1/models with the saved key, paged by `after_id` and `has_more`; 401 and
 * 403 mean the key is rejected. The gateways: their list is public, so the saved key goes to the spec's key check
 * first (401 or 403 means rejected), then one public GET, filtered by the spec. Any other failure, a malformed body
 * or a network error means the list is unreachable. The key travels in a header only.
 */
export function createModelCatalog(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): ModelCatalog {
  const doFetch = options.fetch ?? fetch;
  const get = (url: URL | string, headers: Record<string, string>) =>
    doFetch(url, { method: "GET", headers: { accept: "application/json", ...headers }, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS) });

  async function anthropic(spec: AiConnectionSpec, apiKey: string): Promise<ModelListResult> {
    if (!apiKey || !headerSafe(apiKey)) return { ok: false, reason: "rejected" };
    const ids: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(spec.models.url);
      url.searchParams.set("limit", String(PAGE_SIZE));
      if (after) url.searchParams.set("after_id", after);
      const response = await get(url, { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "rejected" };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "unreachable" };
      }
      const body = (await response.json()) as { data?: ModelRow[]; has_more?: unknown; last_id?: unknown };
      if (!Array.isArray(body.data)) return { ok: false, reason: "unreachable" };
      for (const item of body.data) if (typeof item?.id === "string") ids.push(item.id);
      if (body.has_more !== true || typeof body.last_id !== "string") break;
      after = body.last_id;
    }
    return ids.length > 0 ? { ok: true, ids } : { ok: false, reason: "unreachable" };
  }

  async function publicList(spec: AiConnectionSpec, apiKey: string): Promise<ModelListResult> {
    if (!apiKey || !headerSafe(apiKey)) return { ok: false, reason: "rejected" };
    // A revoked key still sees the public list, so ask the key check before offering models it cannot run.
    const check = await get(spec.keyCheck.url, { authorization: `Bearer ${apiKey}` });
    await check.body?.cancel().catch(() => undefined);
    if (check.status === 401 || check.status === 403) return { ok: false, reason: "rejected" };
    const response = await get(spec.models.url, {});
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "unreachable" };
    }
    const body = (await response.json()) as { data?: ModelRow[] };
    if (!Array.isArray(body.data)) return { ok: false, reason: "unreachable" };
    const ids = body.data
      .filter((m): m is { id: string; type?: unknown } => typeof m?.id === "string")
      .filter((m) => !spec.models.keep || spec.models.keep({ id: m.id, type: typeof m.type === "string" ? m.type : undefined }))
      .map((m) => m.id);
    return ids.length > 0 ? { ok: true, ids } : { ok: false, reason: "unreachable" };
  }

  return {
    async list(spec, apiKey): Promise<ModelListResult> {
      try {
        return spec.models.auth === "anthropic" ? await anthropic(spec, apiKey) : await publicList(spec, apiKey);
      } catch {
        return { ok: false, reason: "unreachable" };
      }
    },
  };
}
