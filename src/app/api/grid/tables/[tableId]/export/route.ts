import { exportTableCsv } from "@/contexts/grid/application/import-export";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { ValidationError } from "@/shared/errors";
import { withActor } from "@/shared/api";
import { idList, idParam, readOptionalJsonObject, stringList } from "../../../http";

const flag = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new ValidationError("useView must be true or false");
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new ValidationError("search must be text");
  return value;
};

/**
 * Body `{ rowIds?, columnKeys?, useView?, search? }`. Without `rowIds` the whole table is exported in table order (up to 50,000 rows).
 * With `useView` the rows are the ones the member's own view shows (default view plus personal filters and sorts),
 * narrowed by `search` and in the view's sort order; the client never sends filters.
 * Cells a spreadsheet would run as a formula get a leading apostrophe. The CSV is UTF-8 with a byte-order mark.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/export">) {
  const { tableId } = await ctx.params;
  let exported: Awaited<ReturnType<typeof exportTableCsv>> | undefined;
  // withActor owns the session check and the error mapping; the stream is returned outside it.
  const failure = await withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readOptionalJsonObject(request, GRID_LIMITS.cellsBodyBytes);
    exported = await exportTableCsv(gridDeps(), actor, id, {
      rowIds: body.rowIds === undefined ? undefined : idList(body.rowIds, "rowIds", GRID_LIMITS.exportRows),
      useView: body.useView === undefined ? undefined : flag(body.useView),
      search: body.search === undefined ? undefined : text(body.search),
      columnKeys: body.columnKeys === undefined ? undefined : stringList(body.columnKeys, "columnKeys", GRID_LIMITS.columnsPerTable),
    });
    return { ok: true };
  });
  if (!exported) return failure;

  const chunks = exported.chunks;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${exported.filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
