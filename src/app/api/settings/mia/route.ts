import { z } from "zod";
import { withActor, withAdmin } from "@/app/_lib/api";
import { getMiaSettings, updateMiaSettings } from "@/contexts/mia/application/mia-use-cases";
import { miaDeps } from "@/contexts/mia/infrastructure/composition";

export const GET = () => withActor((actor) => getMiaSettings(miaDeps(), actor));

const PATCH_SETTINGS = z.object({ enabled: z.unknown().optional(), dailyTokenLimit: z.unknown().optional() });

export const PATCH = (request: Request) => withAdmin("Only an owner or admin can change Mia's settings.", async (actor) => updateMiaSettings(miaDeps(), actor, PATCH_SETTINGS.parse(await request.json())));
