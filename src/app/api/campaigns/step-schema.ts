import { z } from "zod";

export const stepSchema = z.object({
  stepNumber: z.number().int(),
  kind: z.literal("email"),
  subject: z.string().max(300).optional(),
  body: z.string().max(20000),
  waitDays: z.number(),
});
