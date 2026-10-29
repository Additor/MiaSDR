import { importLeads } from "@/contexts/people/application/import-leads";
import { parseSpreadsheet } from "@/platform/files/spreadsheet";
import { leadImportDeps } from "@/contexts/people/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { readImportForm } from "./read-form";

/** Imports the file with its mapping. An unreadable file or a mapping the file cannot make answers 422; a refused archived field 409. */
export const POST = (request: Request) =>
  withActor(async (actor) => {
    const form = await readImportForm(request);
    const { headers, rows } = await parseSpreadsheet(Buffer.from(await form.file.arrayBuffer()), form.file.name);
    return importLeads(leadImportDeps(), {
      organizationId: actor.organizationId,
      userId: actor.userId,
      filename: form.file.name,
      headers,
      rows,
      mapping: form.mapping,
      defaultCountry: form.defaultCountry,
      role: actor.role,
    });
  });
