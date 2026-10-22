import { NextResponse, connection } from "next/server";
import { batchTemplateCsv } from "@/contexts/outreach/linkedin/domain/linkedin-search-batch";
import { UTF8_BOM } from "@/contexts/people/domain/csv-export";
import { apiOrgContext } from "@/contexts/identity/infrastructure/session";

/** The sheet to fill in for a batch upload: company_name and search_url, with one sample row. */
export async function GET() {
  await connection();
  if (!(await apiOrgContext())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return new Response(UTF8_BOM + batchTemplateCsv(), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="search-batch-template.csv"',
      "cache-control": "no-store",
    },
  });
}
