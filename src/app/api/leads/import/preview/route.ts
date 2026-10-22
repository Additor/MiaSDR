import { NextResponse } from "next/server";
import { MAX_IMPORT_ROWS } from "@/contexts/people/application/import-leads";
import { suggestMapping } from "@/contexts/people/domain/import-plan";
import { CsvError, MAX_FILE_BYTES } from "@/platform/files/csv";
import { collectExamples } from "@/contexts/people/domain/import-summary";
import { parseSpreadsheet } from "@/platform/files/spreadsheet";
import { apiOrgContext } from "@/contexts/identity/infrastructure/session";

/** Reads the uploaded CSV and returns its headers, up to three distinct example values per column and a guessed mapping. Stores nothing. */
export async function POST(request: Request) {
  if (!(await apiOrgContext())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Attach a CSV or XLSX file." }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: "The file is larger than 5 MB." }, { status: 413 });

  try {
    const { headers, rows } = await parseSpreadsheet(Buffer.from(await file.arrayBuffer()), file.name);
    if (rows.length > MAX_IMPORT_ROWS) {
      return NextResponse.json({ error: `The file has ${rows.length} rows. The limit is ${MAX_IMPORT_ROWS}; split it and import in parts.` }, { status: 400 });
    }
    return NextResponse.json({
      headers,
      totalRows: rows.length,
      examples: collectExamples(headers, rows),
      suggestedMapping: suggestMapping(headers),
    });
  } catch (error) {
    if (error instanceof CsvError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
