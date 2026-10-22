import { searchPeople } from "@/contexts/leads/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

/** People of the organization, any lifecycle: `?q=` over name, email, title, company, LinkedIn and phone. At most 20 rows. */
export function GET(request: Request) {
  return withActor(async (actor) => {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return { rows: await searchPeople(actor, q) };
  });
}
