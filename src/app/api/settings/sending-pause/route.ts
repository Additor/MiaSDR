import { z } from "zod";
import { setSendPause } from "@/contexts/outreach/application/send-pause";
import { sendPauseDeps } from "@/contexts/outreach/infrastructure/composition";
import { withAdmin } from "@/app/_lib/api";

export const PUT = (request: Request) =>
  withAdmin("Only an owner or admin can pause or resume sending.", async (actor, ctx) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(await request.json());
    return { paused: await setSendPause(sendPauseDeps(), actor, { paused, byName: ctx.user.name || ctx.user.email, now: new Date() }) };
  });
