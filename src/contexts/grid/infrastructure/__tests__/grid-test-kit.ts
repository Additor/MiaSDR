import type postgres from "postgres";
import type { Actor } from "@/shared/errors";
import { createTestOrg, type TestOrg } from "@/test-support/db";

export interface GridOrg extends TestOrg {
  actor: Actor;
}

/**
 * An organization with one user who holds `role`, recorded in `orgs` so the file's `afterAll` can pass it to `dropOrgs`.
 * The actor carries the same role as the membership row.
 */
export async function gridOrg(sql: postgres.Sql, orgs: TestOrg[], role = "member", name = "Grid"): Promise<GridOrg> {
  const org = await createTestOrg(sql, name, role);
  orgs.push(org);
  return { ...org, actor: { userId: org.userId, organizationId: org.organizationId, role } };
}
