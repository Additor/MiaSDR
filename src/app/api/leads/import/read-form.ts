import { z } from "zod";
import { CORE_TARGETS, type Mapping } from "@/contexts/people/domain/import-plan";
import { MAX_FILE_BYTES } from "@/platform/files/csv";
import { normalizePhoneCountry } from "@/contexts/tenancy/domain/phone-country";
import { PayloadTooLargeError, ValidationError } from "@/shared/errors";

const target = z.union([z.literal("skip"), z.enum(CORE_TARGETS), z.string().regex(/^custom:.+$/)]);
const mappingSchema = z.record(z.string(), target);

export interface ImportForm {
  file: File;
  mapping: Mapping;
  defaultCountry: string | undefined;
}

/** The uploaded file. A missing file is a `ValidationError` (422), a file over 5 MB a `PayloadTooLargeError` (413). */
export async function readImportFile(request: Request): Promise<{ file: File; form: FormData | null }> {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new ValidationError("Attach a CSV or XLSX file.");
  if (file.size > MAX_FILE_BYTES) throw new PayloadTooLargeError("The file is larger than 5 MB.");
  return { file, form };
}

/** Reads the upload, the column mapping and the optional country the import and its dry run both take. */
export async function readImportForm(request: Request): Promise<ImportForm> {
  const { file, form } = await readImportFile(request);
  let mapping: Mapping;
  try {
    mapping = mappingSchema.parse(JSON.parse(String(form?.get("mapping") ?? ""))) as Mapping;
  } catch {
    throw new ValidationError("The column mapping is missing or invalid.");
  }
  const country = String(form?.get("defaultCountry") ?? "").toUpperCase();
  return { file, mapping, defaultCountry: normalizePhoneCountry(country) ?? undefined };
}
