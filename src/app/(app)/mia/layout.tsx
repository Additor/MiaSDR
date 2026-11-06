import { connection } from "next/server";
import { Suspense } from "react";
import { toActor } from "@/app/_lib/api";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { listChats } from "@/contexts/mia/application/chat-use-cases";
import { miaChatDeps } from "@/contexts/mia/infrastructure/composition";
import { ChatList } from "./_components/chat-list";

/** Two columns on a desktop: the person's chats and the open one. A phone shows one at a time; the Mia page lists the chats there. */
export default function MiaLayout({ children }: LayoutProps<"/mia">) {
  return (
    <div className="flex h-svh min-h-0">
      <aside className="hidden w-64 shrink-0 overflow-y-auto border-r p-3 md:block">
        <Suspense fallback={null}>
          <Chats />
        </Suspense>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

async function Chats() {
  await connection();
  const threads = await listChats(miaChatDeps(), toActor(await requireOrgContext()));
  return <ChatList threads={threads} />;
}
