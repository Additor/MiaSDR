import { NextResponse } from "next/server";
import { ImportInputError, importLeads } from "@/contexts/leads/application/import-leads";
import { CsvError } from "@/platform/files/csv";
import { parseSpreadsheet } from "@/platform/files/spreadsheet";
import { leadImportDeps } from "@/contexts/leads/infrastructure/composition";
import { apiOrgContext } from "@/contexts/identity/infrastructure/session";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ConflictError } from "@/shared/errors";
import { readImportForm } from "./read-form";

export async function POST(request: Request) {
  const ctx = await apiOrgContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await readImportForm(request);
  if (form instanceof NextResponse) return form;

  try {
    const { headers, rows } = await parseSpreadsheet(Buffer.from(await form.file.arrayBuffer()), form.file.name);
    const report = await importLeads(
      leadImportDeps(),
      {
        organizationId: ctx.organization.id,
        userId: ctx.user.id,
        filename: form.file.name,
        headers,
        rows,
        mapping: form.mapping,
        defaultCountry: form.defaultCountry,
        restoreArchivedColumns: isOwnerOrAdmin(ctx.role),
      },
    );
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof CsvError || error instanceof ImportInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
