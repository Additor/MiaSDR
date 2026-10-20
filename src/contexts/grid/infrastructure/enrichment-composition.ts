import { hostname } from "node:os";
import { aiResolver } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { AiError } from "@/contexts/conversations/ai/application/ai-ports";
import { credentialCipher } from "@/contexts/integrations/infrastructure/credential-cipher";
import { createCredentialVerifier } from "@/contexts/integrations/infrastructure/credential-verifier";
import { env } from "@/shared/env";
import { kickJob } from "@/platform/jobs/kick";
import type { Job } from "@/platform/jobs/types";
import { GridAiError, type CellAnswerer, type CredentialCipher } from "../application/enrichment-ports";
import type { ColumnDeps } from "../application/enrichment-columns";
import type { ProviderDeps } from "../application/enrichment-providers";
import type { RunDeps } from "../application/enrichment-run";
import { createGridRunJob, GRID_CALL_TIMEOUT_MS, GRID_RUN_JOB, GRID_JOB_LEASE_MS, type WorkerDeps } from "../application/enrichment-worker";
import { DEFAULT_CONCURRENCY } from "../domain/enrichment-run-limits";
import type { UrlPolicy } from "../domain/enrichment-url-policy";
import { createAdapterRegistry, FakeEnrichmentProvider } from "./enrichment-adapters";
import { drizzleProviderStore } from "./enrichment-provider-store";
import { drizzleGridRunStore } from "./enrichment-run-store";

const globalForGrid = globalThis as unknown as { __miasdrFakeGridProvider?: FakeEnrichmentProvider };

const fakeMode = () => env().GRID_PROVIDER === "fake";

/** Hosts a generic HTTP provider may call. Empty by default, so nothing user-configured can leave the server. */
export function gridUrlPolicy(options: { allowLoopback?: boolean } = {}): UrlPolicy {
  const allowedHosts = (env().GRID_HTTP_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return { allowedHosts, allowLoopback: options.allowLoopback === true };
}

export const gridCipher: CredentialCipher = credentialCipher;

/** The organization's own AI key through the shared resolver. The model sees cell text only inside nonce-fenced blocks. */
export const cellAnswerer: CellAnswerer = {
  async answer(organizationId, input) {
    const provider = await aiResolver.forOrganization(organizationId);
    if (!provider) return null;
    if (!provider.answer) throw new GridAiError("The configured AI provider cannot fill table columns.", false);
    try {
      const result = await provider.answer(input);
      return { output: result.output, provider: provider.name, model: provider.model, usage: result.usage };
    } catch (error) {
      if (error instanceof AiError) throw new GridAiError(error.message, error.kind === "transient");
      throw error;
    }
  },
};

export function fakeGridProvider(): FakeEnrichmentProvider {
  return (globalForGrid.__miasdrFakeGridProvider ??= new FakeEnrichmentProvider());
}

export function gridAdapters(options: { allowLoopback?: boolean; fake?: FakeEnrichmentProvider } = {}) {
  return createAdapterRegistry({ policy: gridUrlPolicy(options), net: { allowLoopback: options.allowLoopback }, fake: options.fake ?? (fakeMode() ? fakeGridProvider() : undefined) });
}

export function gridProviderDeps(): ProviderDeps {
  return { providers: drizzleProviderStore, cipher: gridCipher, adapters: gridAdapters(), urlPolicy: gridUrlPolicy(), allowFake: fakeMode(), verifier: createCredentialVerifier({ skip: fakeMode }) };
}

/** Runs `grid.run` in this process soon after a request queued cells. Other instances pick the cells up on their tick. */
export const kickGridWorker = (): void => kickJob(GRID_RUN_JOB);

export function gridRunDeps(): RunDeps {
  return { store: drizzleGridRunStore, providers: drizzleProviderStore, adapters: gridAdapters(), now: () => new Date(), kick: kickGridWorker };
}

export function gridColumnDeps(): ColumnDeps {
  return { store: drizzleGridRunStore, providers: drizzleProviderStore, adapters: gridAdapters() };
}

export function gridWorkerDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    store: drizzleGridRunStore,
    providers: drizzleProviderStore,
    adapters: gridAdapters(),
    cipher: gridCipher,
    ai: cellAnswerer,
    now: () => new Date(),
    workerId: `${hostname()}:${process.pid}`,
    leaseMs: GRID_JOB_LEASE_MS,
    concurrency: env().GRID_RUN_CONCURRENCY ?? DEFAULT_CONCURRENCY,
    callTimeoutMs: GRID_CALL_TIMEOUT_MS,
    // Formulas that read a result recompute once it lands. Loaded on use because composition.ts imports this file.
    afterWrite: async (job, columnKeys) => {
      const [{ recalculateFormulasQuietly }, { refreshAfterSourceWrite }, { gridDeps }] = await Promise.all([import("../application/formula-recalc"), import("../application/formula-lookup-refresh"), import("./composition")]);
      const deps = gridDeps();
      await recalculateFormulasQuietly(deps, job.organizationId, job.tableId, { rowIds: [job.rowId], changedKeys: columnKeys });
      // Formulas in other tables may look up what the run just wrote. One rescan per finished cell is too much, so they are marked stale.
      const table = await deps.structure.getTable(job.organizationId, job.tableId);
      if (table) await refreshAfterSourceWrite(deps, job.organizationId, table, columnKeys, { markOnly: true });
    },
    ...overrides,
  };
}

/** Registered once in the kernel registry. With no queued cells a tick costs one empty claim query. */
export function gridJobs(): Job[] {
  return [createGridRunJob(gridWorkerDeps())];
}
