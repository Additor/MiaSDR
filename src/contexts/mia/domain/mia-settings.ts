import { ValidationError } from "@/shared/errors";
import type { AiUsage } from "@/contexts/ai/domain/generation";
import { MIA_RUN_TOKENS } from "./mia-run";

/** The organization's Mia settings, in its `mia` channel settings row. Each key falls back to its default on its own. */
export const MIA_SETTINGS_CHANNEL = "mia";

export const DEFAULT_DAILY_TOKENS = 5_000_000;
export const MAX_DAILY_TOKENS = 100_000_000;

export interface MiaSettings {
  enabled: boolean;
  /** Tokens Mia may use per UTC day. Background runs stop at `BACKGROUND_SHARE` of it, so a person can still ask. */
  dailyTokenLimit: number;
}

export const DEFAULT_MIA_SETTINGS: MiaSettings = { enabled: true, dailyTokenLimit: DEFAULT_DAILY_TOKENS };

export function readMiaSettings(values: unknown): MiaSettings {
  const raw = (values ?? {}) as Record<string, unknown>;
  const limit = raw.dailyTokenLimit;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_MIA_SETTINGS.enabled,
    dailyTokenLimit: typeof limit === "number" && Number.isInteger(limit) && limit >= 0 && limit <= MAX_DAILY_TOKENS ? limit : DEFAULT_MIA_SETTINGS.dailyTokenLimit,
  };
}

export function parseMiaSettingsPatch(raw: { enabled?: unknown; dailyTokenLimit?: unknown }): Partial<MiaSettings> {
  const patch: Partial<MiaSettings> = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new ValidationError("Choose whether Mia is on.");
    patch.enabled = raw.enabled;
  }
  if (raw.dailyTokenLimit !== undefined) {
    const limit = raw.dailyTokenLimit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > MAX_DAILY_TOKENS) throw new ValidationError(`The daily limit must be a whole number from 0 to ${MAX_DAILY_TOKENS.toLocaleString("en-US")}.`);
    patch.dailyTokenLimit = limit;
  }
  return patch;
}

/** Background runs stop here. The rest of the day's tokens stay for a person's questions. */
export const BACKGROUND_SHARE = 0.8;

export const backgroundTokenLimit = (settings: MiaSettings): number => Math.floor(settings.dailyTokenLimit * BACKGROUND_SHARE);

/** The lowest daily limit under which one job can start: a job needs its whole budget free. */
export const MIN_DAILY_TOKENS_FOR_A_JOB = Math.ceil(MIA_RUN_TOKENS / BACKGROUND_SHARE);

/** What counts against a limit: fresh input, cache writes and output. A cache read costs a fraction and rewards staying in one run. */
export const countedTokens = (usage: AiUsage): number => usage.inputTokens + (usage.cacheWriteTokens ?? 0) + usage.outputTokens;

/** A rough count for a call whose answer never came, so a failing provider still uses up the limit. */
export const estimatedTokens = (text: string): number => Math.ceil(text.length / 4);

export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

export const nextUtcMidnight = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
