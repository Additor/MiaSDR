import { z } from "zod";
import { switchOrganization } from "@/contexts/tenancy/application/organization-switching";
import { switchingDeps } from "@/contexts/tenancy/infrastructure/organization-composition";
import { withUser } from "@/app/_lib/api";

export const POST = (request: Request) =>
  withUser(async (user) => {
    const { organizationId } = z.object({ organizationId: z.string().max(100) }).parse(await request.json());
    return switchOrganization(switchingDeps(), user, organizationId);
  });
