import "server-only";

import { testHelpersBuilt } from "@/shared/test-route-gate";

/**
 * Rate-limit storage for the end-to-end build only. Better Auth keeps its default memory store in a module
 * variable that nothing can reach, so a test run could not start a spec file with a clean window. This store
 * follows the same rule as the default one (a window opens at the first request, resets once `window` seconds
 * pass without a request, and refuses after `max`) and adds `resetE2eRateLimits()`.
 *
 * `e2eRateLimitStorage()` returns undefined unless `testHelpersBuilt()` and E2E_FAKE_CONTROLS=1, so a production
 * image keeps Better Auth's own store whatever the runtime variables say.
 */
type Entry = { count: number; lastRequest: number };
type Rule = { window: number; max: number };

const globalForLimits = globalThis as unknown as { __miasdrE2eRateLimits?: Map<string, Entry> };
const entries = (): Map<string, Entry> => (globalForLimits.__miasdrE2eRateLimits ??= new Map());

export function e2eRateLimitsEnabled(): boolean {
  return testHelpersBuilt() && process.env.E2E_FAKE_CONTROLS === "1";
}

export function e2eRateLimitStorage() {
  if (!e2eRateLimitsEnabled()) return undefined;
  return {
    async consume(key: string, rule: Rule): Promise<{ allowed: true; retryAfter: null } | { allowed: false; retryAfter: number }> {
      const now = Date.now();
      const windowMs = rule.window * 1000;
      const map = entries();
      const entry = map.get(key);
      if (!entry || now - entry.lastRequest >= windowMs) {
        map.set(key, { count: 1, lastRequest: now });
        return { allowed: true, retryAfter: null };
      }
      if (entry.count >= rule.max) return { allowed: false, retryAfter: Math.ceil((entry.lastRequest + windowMs - now) / 1000) };
      map.set(key, { count: entry.count + 1, lastRequest: now });
      return { allowed: true, retryAfter: null };
    },
  };
}

/** Forgets every counter. Does nothing outside the e2e build. */
export function resetE2eRateLimits(): boolean {
  if (!e2eRateLimitsEnabled()) return false;
  entries().clear();
  return true;
}
