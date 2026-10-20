import { previewImport, runImport } from "@/contexts/grid/application/import-export";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { parseUpload } from "@/contexts/grid/infrastructure/parse-upload";
import { PayloadTooLargeError, ValidationError } from "@/shared/errors";
import { withActor } from "@/shared/api";
import { idParam, readFormLimited } from "../../../http";

/**
 * Multipart form with `file` (CSV or XLSX, up to 5 MB, up to 10,000 rows), an optional `mapping` (JSON) and an optional
 * `sheet` (whole number from 1, the workbook sheet to read; sheet 1 by default, ignored for CSV).
 */
const FORM_OVERHEAD_BYTES = 64 * 1024;

function sheetField(raw: FormDataEntryValue | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = typeof raw === "string" && /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
  if (n < 1) throw new ValidationError("sheet must be a whole number from 1");
  return n;
}

/**
 * Without `mapping` this is a preview: headers, the first rows and a suggested mapping, nothing written.
 * With `mapping` it imports: `[{ headerIndex, action: "map", columnKey } | { headerIndex, action: "create", name?, type } | { headerIndex, action: "skip" }]`.
 * The file is uploaded again for the import, so the endpoint keeps no state between the two calls.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/import">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const form = await readFormLimited(request, GRID_LIMITS.importFileBytes + FORM_OVERHEAD_BYTES);
    const file = form.get("file");
    if (!(file instanceof File)) throw new ValidationError("Attach a CSV or XLSX file.");
    if (file.size === 0) throw new ValidationError("That file is empty.");
    if (file.size > GRID_LIMITS.importFileBytes) throw new PayloadTooLargeError("The file is larger than 5 MB.");
    const sheet = await parseUpload({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, { sheet: sheetField(form.get("sheet")) });

    const rawMapping = form.get("mapping");
    if (typeof rawMapping !== "string" || rawMapping === "") return previewImport(gridDeps(), actor, id, sheet, file.name);
    let mapping: unknown;
    try {
      mapping = JSON.parse(rawMapping);
    } catch {
      throw new ValidationError("mapping is not valid JSON");
    }
    return runImport(gridDeps(), actor, id, sheet, mapping);
  });
}
