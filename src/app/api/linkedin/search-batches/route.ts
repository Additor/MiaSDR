import { z } from "zod";
import { listLinkedInSearchBatches, uploadLinkedInSearchBatch } from "@/contexts/outreach/linkedin/application/linkedin-search-batch";
import { MAX_BATCH_FILE_BYTES } from "@/contexts/outreach/linkedin/domain/linkedin-search-batch";
import { linkedinSearchBatchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { CsvError } from "@/platform/files/csv";
import { parseSpreadsheet } from "@/platform/files/spreadsheet";
import { PayloadTooLargeError, ValidationError } from "@/shared/errors";
import { withActor } from "@/app/_lib/api";

export const GET = () => withActor((actor) => listLinkedInSearchBatches(linkedinSearchBatchDeps(), actor));

const fields = z.object({
  name: z.string(),
  maxResults: z.coerce.number().int().optional(),
  campaignId: z.string().nullish(),
  accountIds: z.array(z.string()).optional(),
});

/** Multipart: `file` (CSV or XLSX), `name`, and optional `maxResults`, `campaignId`, `accountIds` (JSON array). */
export const POST = (request: Request) =>
  withActor(async (actor) => {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw new ValidationError("Attach a CSV or XLSX file.");
    if (file.size > MAX_BATCH_FILE_BYTES) throw new PayloadTooLargeError(`The file is larger than ${MAX_BATCH_FILE_BYTES / 1024 / 1024} MB.`);

    let accountIds: unknown;
    try {
      const raw = String(form?.get("accountIds") ?? "");
      accountIds = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      throw new ValidationError("The account list is not valid.");
    }
    const maxRaw = String(form?.get("maxResults") ?? "");
    const input = fields.parse({
      name: String(form?.get("name") ?? ""),
      maxResults: maxRaw === "" ? undefined : maxRaw,
      campaignId: String(form?.get("campaignId") ?? "") || null,
      accountIds,
    });

    let parsed;
    try {
      parsed = await parseSpreadsheet(Buffer.from(await file.arrayBuffer()), file.name);
    } catch (error) {
      if (error instanceof CsvError) throw new ValidationError(error.message);
      throw error;
    }
    return uploadLinkedInSearchBatch(linkedinSearchBatchDeps(), actor, { ...input, filename: file.name, headers: parsed.headers, rows: parsed.rows });
  }, 201);
