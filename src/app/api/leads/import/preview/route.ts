import { MAX_IMPORT_ROWS } from "@/contexts/people/application/import-leads";
import { suggestMapping } from "@/contexts/people/domain/import-plan";
import { collectExamples } from "@/contexts/people/domain/import-summary";
import { parseSpreadsheet } from "@/platform/files/spreadsheet";
import { ValidationError } from "@/shared/errors";
import { withActor } from "@/app/_lib/api";
import { readImportFile } from "../read-form";

/** Reads the uploaded CSV and returns its headers, up to three distinct example values per column and a guessed mapping. Stores nothing. */
export const POST = (request: Request) =>
  withActor(async () => {
    const { file } = await readImportFile(request);
    const { headers, rows } = await parseSpreadsheet(Buffer.from(await file.arrayBuffer()), file.name);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ValidationError(`The file has ${rows.length} rows. The limit is ${MAX_IMPORT_ROWS}; split it and import in parts.`);
    }
    return {
      headers,
      totalRows: rows.length,
      examples: collectExamples(headers, rows),
      suggestedMapping: suggestMapping(headers),
    };
  });
