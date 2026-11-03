import { z } from "zod";
import { updateEmailRules } from "@/contexts/outreach/email/application/email-rules";
import { emailRulesDeps } from "@/contexts/outreach/infrastructure/composition";
import { withAdmin } from "@/app/_lib/api";

export const PATCH = (request: Request) =>
  withAdmin("Only an owner or admin can change email rules.", async (actor) =>
    updateEmailRules(
      emailRulesDeps(),
      actor,
      z.object({ minGapMinutes: z.number(), maxGapMinutes: z.number(), takeoverAfterHours: z.number().optional() }).parse(await request.json()),
    ),
  );
