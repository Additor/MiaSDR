import { batchTemplateCsv } from "@/contexts/outreach/linkedin/domain/linkedin-search-batch";
import { UTF8_BOM } from "@/shared/csv";
import { withActor } from "@/app/_lib/api";

/** The sheet to fill in for a batch upload: company_name and search_url, with one sample row. */
export const GET = () =>
  withActor(async () =>
    new Response(UTF8_BOM + batchTemplateCsv(), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="search-batch-template.csv"',
        "cache-control": "no-store",
      },
    }),
  );
