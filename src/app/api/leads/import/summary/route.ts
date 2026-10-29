import { NextResponse } from "next/server";
import { previewImport } from "@/contexts/people/application/import-leads";
import { parseSpreadsheet } from "@/platform/files/spreadsheet";
import { leadImportDeps } from "@/contexts/people/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { readImportForm } from "../read-form";

/** Dry run of the import: the counts the import would produce for this file and mapping. Writes nothing. */
export const POST = (request: Request) =>
  withActor(async (actor) => {
    const form = await readImportForm(request);
    const { headers, rows } = await parseSpreadsheet(Buffer.from(await form.file.arrayBuffer()), form.file.name);
    const summary = await previewImport(leadImportDeps(), {
      organizationId: actor.organizationId,
      headers,
      rows,
      mapping: form.mapping,
      defaultCountry: form.defaultCountry,
      role: actor.role,
    });
    return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
  });
