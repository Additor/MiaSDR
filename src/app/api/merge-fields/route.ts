import { listMergeFields } from "@/contexts/outreach/application/merge-fields";
import { mergeFieldDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor } from "@/shared/api";

/** Fields a step template can use: standard ones, custom columns and import source data. */
export async function GET() {
  return withActor(async (actor) => ({ fields: await listMergeFields(mergeFieldDeps(), actor) }));
}
