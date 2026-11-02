import { z } from "zod";
import { CORE_TARGETS } from "./import-plan";

/** Where one column of an import goes: a core field, a custom field, or nowhere. */
export const importTargetSchema = z.union([z.literal("skip"), z.enum(CORE_TARGETS), z.string().regex(/^custom:.+$/)]);
