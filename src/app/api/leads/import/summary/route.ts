import { NextResponse } from "next/server";
import { ImportInputError, previewImport } from "@/contexts/people/application/import-leads";
import { CsvError } from "@/platform/files/csv";
import { parseSpreadsheet } from "@/platform/files/spreadsheet";
import { leadImportDeps } from "@/contexts/people/infrastructure/composition";
import { apiOrgContext } from "@/contexts/identity/infrastructure/session";
import { ConflictError } from "@/shared/errors";
import { readImportForm } from "../read-form";

/** Dry run of the import: the counts the import would produce for this file and mapping. Writes nothing. */
export async function POST(request: Request) {
  const ctx = await apiOrgContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await readImportForm(request);
  if (form instanceof NextResponse) return form;

  try {
    const { headers, rows } = await parseSpreadsheet(Buffer.from(await form.file.arrayBuffer()), form.file.name);
    const summary = await previewImport(
      leadImportDeps(),
      {
        organizationId: ctx.organization.id,
        headers,
        rows,
        mapping: form.mapping,
        defaultCountry: form.defaultCountry,
        role: ctx.role,
      },
    );
    return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof CsvError || error instanceof ImportInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
