import { z } from "zod";
import {
createCustomColumn,reorderCustomColumns
} from "@/contexts/people/application/custom-columns";
import { COLUMN_ENTITIES } from "@/contexts/people/domain/custom-columns";
import { customColumnStore } from "@/contexts/people/infrastructure/composition";
import { withAdmin } from "@/app/_lib/api";

const entity = z.enum(COLUMN_ENTITIES);
const DENIED = "Only an owner or admin can manage custom fields.";

export function POST(request: Request) {
  return withAdmin(
    DENIED,
    async (actor) => {
      const body = z.object({ entity: entity.default("people"), name: z.string().max(200) }).parse(await request.json());
      return createCustomColumn(customColumnStore, actor, body);
    },
    201,
  );
}

/** Persists the order of the active columns of one entity. */
export function PUT(request: Request) {
  return withAdmin(DENIED, async (actor) => {
    const body = z.object({ entity: entity.default("people"), ids: z.array(z.uuid()).max(500) }).parse(await request.json());
    await reorderCustomColumns(customColumnStore, actor, body);
    return { ok: true };
  });
}
