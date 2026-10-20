import { NextResponse } from "next/server";
import { z } from "zod";
import { CORE_TARGETS, type Mapping } from "@/contexts/leads/domain/import-plan";
import { MAX_FILE_BYTES } from "@/contexts/leads/infrastructure/csv";
import { normalizePhoneCountry } from "@/contexts/tenancy/domain/phone-country";

const target = z.union([z.literal("skip"), z.enum(CORE_TARGETS), z.string().regex(/^custom:.+$/)]);
const mappingSchema = z.record(z.string(), target);

export interface ImportForm {
  file: File;
  mapping: Mapping;
  defaultCountry: string | undefined;
}

/** Reads the upload, the column mapping and the optional country the import and its dry run both take. */
export async function readImportForm(request: Request): Promise<ImportForm | NextResponse> {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Attach a CSV or XLSX file." }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: "The file is larger than 5 MB." }, { status: 413 });

  let mapping: Mapping;
  try {
    mapping = mappingSchema.parse(JSON.parse(String(form?.get("mapping") ?? ""))) as Mapping;
  } catch {
    return NextResponse.json({ error: "The column mapping is missing or invalid." }, { status: 400 });
  }
  const country = String(form?.get("defaultCountry") ?? "").toUpperCase();
  return { file, mapping, defaultCountry: normalizePhoneCountry(country) ?? undefined };
}
