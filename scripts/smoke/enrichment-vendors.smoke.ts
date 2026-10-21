import { describe, expect, it } from "vitest";
import type { ProviderAnswer, ProviderRecord } from "@/contexts/grid/enrichment/application/enrichment-ports";
import { catalogEntry, SIMPLE_ADAPTER_KEYS } from "@/contexts/grid/enrichment/domain/enrichment-catalog";
import { CONTRACTS, type ContractKey } from "@/contexts/grid/enrichment/domain/enrichment-contracts";
import { redactSecrets } from "@/contexts/grid/enrichment/domain/enrichment-redact";
import { createAdapterRegistry } from "@/contexts/grid/enrichment/infrastructure/enrichment-adapters";
import { createEnrichmentVerifier } from "@/contexts/grid/enrichment/infrastructure/vendors";

/**
 * Calls each enrichment vendor for real, once, with your own key. A vendor without a key is skipped. Each call spends at
 * most one credit; pick inputs your plan allows.
 *
 * Env:
 *   SMOKE_<VENDOR>_KEY   e.g. SMOKE_HUNTER_KEY, SMOKE_ZEROBOUNCE_KEY, SMOKE_PEOPLEDATALABS_KEY
 *   SMOKE_EMAIL          address to verify or enrich (default valid@example.com, a ZeroBounce sandbox address)
 *   SMOKE_NAME, SMOKE_DOMAIN   person to find (default Patrick Collison, stripe.com)
 *
 * For each vendor it checks the key with the free key-check call, makes one call per contract action, and asserts that
 * every contract output is present and that no form of the key appears in the request, the response or an error. It
 * prints the outcome, the output keys and the latency with the key redacted. Record the date in the vendor's file
 * header ("exercised live <date>") after a clean run.
 */
const EMAIL = process.env.SMOKE_EMAIL ?? "valid@example.com";
const NAME = process.env.SMOKE_NAME ?? "Patrick Collison";
const DOMAIN = process.env.SMOKE_DOMAIN ?? "stripe.com";

const INPUTS: Record<ContractKey, Record<string, unknown>> = {
  "verify-email": { email: EMAIL },
  "find-work-email": { fullName: NAME, companyDomain: DOMAIN },
  "enrich-person": { fullName: NAME, companyDomain: DOMAIN },
  "enrich-company": { companyDomain: DOMAIN },
};

const vendors = SIMPLE_ADAPTER_KEYS.filter((key) => key !== "fake");
const keyFor = (vendor: string) => process.env[`SMOKE_${vendor.toUpperCase()}_KEY`];

const record = (adapter: string): ProviderRecord => ({
  id: "smoke", key: adapter, name: adapter, baseUrl: null, defaultCostCents: 0, rateLimitPerMin: null, config: { adapter }, enabled: true, hasCredential: true, createdAt: new Date(), updatedAt: new Date(),
});

describe("enrichment vendors, live", () => {
  it("names at least one vendor key, or says none was given", () => {
    const given = vendors.filter(keyFor);
    console.log(given.length ? `[smoke] live vendors: ${given.join(", ")}` : `[smoke] no SMOKE_<VENDOR>_KEY set; every vendor is skipped (${vendors.join(", ")})`);
  });

  for (const vendor of vendors) {
    const apiKey = keyFor(vendor);
    const forms = apiKey ? [apiKey, encodeURIComponent(apiKey), new URLSearchParams({ k: apiKey }).toString().slice(2)] : [];
    const clean = (value: unknown) => {
      const json = JSON.stringify(value ?? null);
      for (const form of forms) expect(json).not.toContain(form);
    };

    it.skipIf(!apiKey)(`${vendor}: the key check accepts the key`, async () => {
      expect(await createEnrichmentVerifier().verify(vendor, { apiKey: apiKey! })).toEqual({ ok: true, verified: true });
    });

    for (const action of catalogEntry(vendor)?.actions.filter((a) => a.key in CONTRACTS) ?? []) {
      it.skipIf(!apiKey)(`${vendor}: ${action.key} answers in the contract's shape`, async () => {
        const adapter = createAdapterRegistry({ policy: { allowedHosts: [] } }).adapterFor(record(vendor))!;
        const started = Date.now();
        let answer: ProviderAnswer;
        try {
          answer = await adapter.execute({ action: action.key, inputs: INPUTS[action.key as ContractKey], credentials: { apiKey: apiKey! }, provider: record(vendor), timeoutMs: 30_000 });
        } catch (error) {
          clean(error instanceof Error ? error.message : String(error));
          throw error;
        }
        clean([answer.request, answer.response]);
        for (const output of CONTRACTS[action.key as ContractKey].outputs) expect(answer.outputs).toHaveProperty(output.key);
        console.log(`[smoke] ${vendor} ${action.key}: ${answer.outcome}`, redactSecrets({ primary: answer.primary, billable: answer.billable ?? true, outputs: Object.keys(answer.outputs), ms: Date.now() - started }, forms));
      });
    }
  }
});
