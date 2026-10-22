import { z } from "zod";
import { deleteProvider, updateProvider } from "@/contexts/grid/enrichment/application/enrichment-providers";
import { gridProviderDeps } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { withAdmin } from "@/app/_lib/api";

const body = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  defaultCostCents: z.number().optional(),
  rateLimitPerMin: z.number().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
});

export const PATCH = async (request: Request, { params }: RouteContext<"/api/grid/providers/[id]">) => {
  const { id } = await params;
  return withAdmin("Only an owner or admin can manage enrichment providers.", async (actor) => updateProvider(gridProviderDeps(), actor, id, body.parse(await request.json())));
};

export const DELETE = async (_request: Request, { params }: RouteContext<"/api/grid/providers/[id]">) => {
  const { id } = await params;
  return withAdmin("Only an owner or admin can manage enrichment providers.", (actor) => deleteProvider(gridProviderDeps(), actor, id));
};
