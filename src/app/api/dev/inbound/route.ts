import { NextResponse } from "next/server";
import { mailboxProvider } from "@/contexts/outreach/infrastructure/composition";
import type { FakeMailboxProvider } from "@/contexts/outreach/email/infrastructure/fake-mailbox-provider";
import { env } from "@/shared/env";
import { testHelpersBuilt } from "@/shared/test-route-gate";

/**
 * Dev and e2e only: puts a message in a fake mailbox inbox so the inbox sync job picks it up on the next tick.
 * Off unless E2E_DEV_HELPERS=1, never in a production build without E2E_BUILD=1, and only with MAILBOX_PROVIDER=fake.
 */
export async function POST(request: Request) {
  if (!testHelpersBuilt() || process.env.E2E_DEV_HELPERS !== "1" || env().MAILBOX_PROVIDER !== "fake") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const provider = mailboxProvider() as Partial<FakeMailboxProvider>;
  if (typeof provider.deliverInbound !== "function") return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await request.json()) as {
    mailbox: string;
    fromEmail: string;
    fromName?: string | null;
    subject?: string;
    bodyText?: string;
    inReplyTo?: string | null;
    threadId?: string;
    cc?: string[];
  };
  const email = provider.deliverInbound(body.mailbox, {
    from: { email: body.fromEmail, name: body.fromName ?? null },
    ...(body.subject !== undefined ? { subject: body.subject } : {}),
    ...(body.bodyText !== undefined ? { bodyText: body.bodyText } : {}),
    ...(body.inReplyTo !== undefined ? { inReplyTo: body.inReplyTo } : {}),
    ...(body.threadId !== undefined ? { threadId: body.threadId } : {}),
    ...(Array.isArray(body.cc) ? { cc: body.cc } : {}),
  });
  return NextResponse.json({ delivered: email.providerMessageId, threadId: email.threadId });
}
