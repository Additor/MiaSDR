import { providerUsage, USAGE_DAYS } from "@/contexts/grid/enrichment/application/enrichment-run";
import { gridRunDeps } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { withActor } from "@/app/_lib/api";

/** Each provider's calls, found and missed answers, errors, reuses, credits and cost over `days` (default 30). */
export const GET = (request: Request) =>
  withActor(async (actor) => {
    const days = Number(new URL(request.url).searchParams.get("days") ?? USAGE_DAYS);
    return providerUsage(gridRunDeps(), actor, Number.isFinite(days) ? days : USAGE_DAYS);
  });
