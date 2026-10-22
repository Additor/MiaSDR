import { z } from "zod";
import { companyLifecycleDeps } from "@/composition/person-lifecycle";
import { mergeCompanies } from "@/contexts/leads/application/company-lifecycle";
import { withActor } from "@/app/_lib/api";

const bodySchema = z.object({ otherId: z.string().max(64), expected: z.unknown().optional() });

/**
 * Merges `otherId` into this company. `expected` holds the versions and people counts the preview showed.
 * 200 `{ companyId, moved }`, also for a repeat of a merge that committed. 404; 409 `same_company`, `company_changed`,
 * `try_again`; 422 for a missing `expected`.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/companies/[id]/merge">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { otherId, expected } = bodySchema.parse(await request.json());
    return mergeCompanies(companyLifecycleDeps, actor, id, otherId, { expected });
  });
}
