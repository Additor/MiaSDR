import { z } from "zod";
import { listIdentityExceptions } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/shared/api";

export async function GET(request: Request) {
  const status = z.enum(["open", "resolved", "ignored"]).catch("open").parse(new URL(request.url).searchParams.get("status") ?? "open");
  return withActor((actor) => listIdentityExceptions(crmDeps(), actor, status));
}
