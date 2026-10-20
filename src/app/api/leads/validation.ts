import { z } from "zod";
import { NotFoundError } from "@/shared/errors";

const text = z.string().max(2000).nullable().optional();

export const editSchema = z.object({
  firstName: text,
  lastName: text,
  fullName: text,
  email: text,
  phone: text,
  linkedin: text,
  title: text,
  companyDomain: text,
  companyName: text,
  custom: z.record(z.string().max(100), z.string().max(5000)).optional(),
  newCustom: z.array(z.object({ label: z.string().max(100), value: z.string().max(5000) })).max(20).optional(),
  defaultCountry: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase())
    .optional(),
});

/** A path id that is not a UUID cannot exist, so it answers 404 like any unknown lead. */
export function leadId(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new NotFoundError("Lead not found");
  return value;
}
