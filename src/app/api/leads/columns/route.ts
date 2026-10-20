import { z } from "zod";
import {
  createCustomColumn,
  listCustomColumns,
  reorderCustomColumns,
} from "@/contexts/leads/application/custom-columns";
import { COLUMN_ENTITIES } from "@/contexts/leads/domain/custom-columns";
import { customColumnStore } from "@/contexts/leads/infrastructure/composition";
import { withActor, withAdmin } from "@/shared/api";

const entity = z.enum(COLUMN_ENTITIES);
const DENIED = "Only an owner or admin can manage custom fields.";

/** Any member can read the registry: the lead form needs the labels. */
export function GET(request: Request) {
  return withActor((actor) => {
    const params = new URL(request.url).searchParams;
    return listCustomColumns(customColumnStore, actor, {
      entity: entity.parse(params.get("entity") ?? "people"),
      includeArchived: params.get("includeArchived") === "true",
    });
  });
}

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
