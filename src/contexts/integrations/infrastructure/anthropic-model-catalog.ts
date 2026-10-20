import type { ModelCatalog, ModelListResult } from "../application/ai-model";

const MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;
const TIMEOUT_MS = 10_000;

/** Same printable-ASCII rule as the credential verifier: anything else makes fetch throw while it builds headers. */
const headerSafe = (value: string) => !/[^\x20-\x7e]/.test(value);

/**
 * GET /v1/models with the saved key (paged by `after_id`, `has_more`). The key travels in a header only. 401 and 403
 * mean the key is rejected; any other failure, a malformed body or a network error means the list is unreachable.
 */
export function createModelCatalog(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): ModelCatalog {
  const doFetch = options.fetch ?? fetch;
  return {
    async list(apiKey): Promise<ModelListResult> {
      if (!apiKey || !headerSafe(apiKey)) return { ok: false, reason: "rejected" };
      const ids: string[] = [];
      let after: string | null = null;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const url = new URL(MODELS_URL);
          url.searchParams.set("limit", String(PAGE_SIZE));
          if (after) url.searchParams.set("after_id", after);
          const response = await doFetch(url, {
            method: "GET",
            headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
          });
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel().catch(() => undefined);
            return { ok: false, reason: "rejected" };
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return { ok: false, reason: "unreachable" };
          }
          const body = (await response.json()) as { data?: Array<{ id?: unknown }>; has_more?: unknown; last_id?: unknown };
          if (!Array.isArray(body.data)) return { ok: false, reason: "unreachable" };
          for (const item of body.data) if (typeof item?.id === "string") ids.push(item.id);
          if (body.has_more !== true || typeof body.last_id !== "string") break;
          after = body.last_id;
        }
      } catch {
        return { ok: false, reason: "unreachable" };
      }
      return ids.length > 0 ? { ok: true, ids } : { ok: false, reason: "unreachable" };
    },
  };
}
