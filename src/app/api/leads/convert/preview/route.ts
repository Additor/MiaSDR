import { previewConvert } from "@/contexts/leads/application/convert-to-contact";
import { convertPreviewDeps } from "@/composition/deals";
import { withActor } from "@/app/_lib/api";
import { idsSchema } from "@/app/api/deals/validation";

/** What creating deals for these leads would stop, said before the click. Up to 500 ids; the dialog sends chunks and sums. */
export async function POST(request: Request) {
  return withActor(async (actor) => {
    const { ids } = idsSchema.parse(await request.json());
    return previewConvert(convertPreviewDeps(), actor, ids);
  });
}
