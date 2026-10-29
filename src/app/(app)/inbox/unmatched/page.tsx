import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { listIdentityExceptions } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { toActor } from "@/app/_lib/api";
import { ListSkeleton } from "@/components/shell/list-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { ExceptionsPanel } from "./exceptions-panel";

export const metadata: Metadata = { title: "Unmatched senders" };

export default function UnmatchedSendersPage() {
  return (
    <>
      <PageHeader title="Unmatched senders" back={{ href: "/inbox", label: "Inbox" }} />
      <div className="page stack-group">
        <Suspense
          fallback={
            // A ruled list of messages with no toolbar above it.
            <div className="max-w-3xl">
              <ListSkeleton toolbar={false} label="Loading unmatched senders" />
            </div>
          }
        >
          <Exceptions />
        </Suspense>
      </div>
    </>
  );
}

async function Exceptions() {
  await connection();
  const rows = await listIdentityExceptions(replyHandlingDeps(), toActor(await requireOrgContext()), "open");
  return (
    <ExceptionsPanel
      rows={rows.map((r) => {
        const message = ((r.payload ?? {}) as { message?: { bodyText?: string; subject?: string; from?: { email?: string; name?: string | null }; counterparty?: { name?: string | null } } }).message ?? {};
        return {
          id: r.id,
          channel: r.channel,
          accountRef: r.accountRef,
          identityValue: r.identityValue,
          reason: r.reason,
          createdAt: r.createdAt.toISOString(),
          sender: message.from?.email ?? message.counterparty?.name ?? r.identityValue,
          subject: message.subject ?? null,
          excerpt: (message.bodyText ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
        };
      })}
    />
  );
}
