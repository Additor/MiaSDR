import { cache } from "react";
import { toActor } from "@/app/_lib/api";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { listChats } from "@/contexts/mia/application/chat-use-cases";
import { miaChatDeps } from "@/contexts/mia/infrastructure/composition";

/** The signed-in person's chats, read once per request: the layout lists them on a desktop, the Mia page on a phone. */
export const myChats = cache(async () => listChats(miaChatDeps(), toActor(await requireOrgContext())));
