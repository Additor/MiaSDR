import { z } from "zod";
import { getEmailRules, updateEmailRules } from "@/contexts/outreach/email/application/email-rules";
import { emailRulesDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor, withAdmin } from "@/app/_lib/api";

export const GET = () => withActor((actor) => getEmailRules(emailRulesDeps(), actor));

export const PATCH = (request: Request) =>
  withAdmin("Only an owner or admin can change email rules.", async (actor) =>
    updateEmailRules(
      emailRulesDeps(),
      actor,
      z.object({ minGapMinutes: z.number(), maxGapMinutes: z.number(), timeZone: z.string().max(100), takeoverAfterHours: z.number().optional() }).parse(await request.json()),
    ),
  );
