import { z } from "zod";

export const linkedinStepSchema = z.object({
  stepNumber: z.number().int(),
  kind: z.enum(["invitation", "message"]),
  subject: z.string().max(300).optional(),
  body: z.string().max(5000),
  waitDays: z.number(),
});
