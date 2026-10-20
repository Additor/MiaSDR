import { z } from "zod";
import { createProvider, listCatalog, listProviders } from "@/contexts/grid/application/enrichment-providers";
import { gridProviderDeps } from "@/contexts/grid/infrastructure/enrichment-composition";
import { withActor, withAdmin } from "@/shared/api";

/** The catalog and this organization's providers. Credentials are never part of the answer, only `hasCredential`. */
export const GET = () =>
  withActor(async (actor) => {
    const deps = gridProviderDeps();
    return { catalog: listCatalog(deps.allowFake), providers: await listProviders(deps, actor) };
  });

const body = z.object({
  adapter: z.string(),
  key: z.string().optional(),
  name: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultCostCents: z.number().optional(),
  rateLimitPerMin: z.number().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
});

export const POST = (request: Request) => withAdmin("Only an owner or admin can manage enrichment providers.", async (actor) => createProvider(gridProviderDeps(), actor, body.parse(await request.json())), 201);
