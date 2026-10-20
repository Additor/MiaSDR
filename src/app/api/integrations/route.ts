import { z } from "zod";
import { saveIntegrationCredential } from "@/contexts/integrations/application/integration-management";
import { integrationDeps } from "@/contexts/integrations/infrastructure/composition";
import { withAdmin } from "@/shared/api";

/** Adds a provider credential, or rotates it. The response never echoes the secret. */
export const POST = (request: Request) =>
  withAdmin(
    "Only an owner or admin can manage integrations.",
    async (actor) =>
      saveIntegrationCredential(integrationDeps(), actor, z.object({ providerKey: z.string(), values: z.record(z.string(), z.unknown()) }).parse(await request.json())),
    200,
  );
