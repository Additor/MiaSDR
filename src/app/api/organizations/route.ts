import { z } from "zod";
import { createOrganization } from "@/contexts/tenancy/application/create-organization";
import { listMyOrganizations } from "@/contexts/tenancy/application/organization-switching";
import { createOrganizationDeps, switchingDeps } from "@/contexts/tenancy/infrastructure/organization-composition";
import { withUser } from "@/shared/api";

export const GET = () => withUser((user) => listMyOrganizations(switchingDeps(), user));

export const POST = (request: Request) =>
  withUser(async (user) => createOrganization(createOrganizationDeps(), user, z.object({ name: z.string().max(500) }).parse(await request.json())), 201);
