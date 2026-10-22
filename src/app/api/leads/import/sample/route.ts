import { NextResponse, connection } from "next/server";
import { UTF8_BOM } from "@/contexts/people/domain/csv-export";
import { sampleImportCsv } from "@/contexts/people/domain/import-summary";
import { apiOrgContext } from "@/contexts/identity/infrastructure/session";

/** A sample file for the lead import: the headers the importer maps without help and two example leads. */
export async function GET() {
  await connection();
  if (!(await apiOrgContext())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return new Response(UTF8_BOM + sampleImportCsv(), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="lead-import-sample.csv"',
      "cache-control": "no-store",
    },
  });
}
