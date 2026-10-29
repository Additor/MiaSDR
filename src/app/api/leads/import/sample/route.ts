import { UTF8_BOM } from "@/shared/csv";
import { sampleImportCsv } from "@/contexts/people/domain/import-summary";
import { withActor } from "@/app/_lib/api";

/** A sample file for the lead import: the headers the importer maps without help and two example leads. */
export const GET = () =>
  withActor(async () =>
    new Response(UTF8_BOM + sampleImportCsv(), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="lead-import-sample.csv"',
        "cache-control": "no-store",
      },
    }),
  );
