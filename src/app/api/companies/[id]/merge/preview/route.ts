import { z } from "zod";
import { companyMergePreviewDeps } from "@/composition/person-lifecycle";
import { previewCompanyMerge } from "@/contexts/people/application/company-lifecycle";
import { withActor } from "@/app/_lib/api";

const bodySchema = z.object({ otherId: z.string().max(64) });

/** What a merge of `otherId` into this company would do. 404 when either company is gone; 409 `same_company`. */
export async function POST(request: Request, ctx: RouteContext<"/api/companies/[id]/merge/preview">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { otherId } = bodySchema.parse(await request.json());
    return previewCompanyMerge(companyMergePreviewDeps, actor, id, otherId);
  });
}
