import { NextResponse } from "next/server";
import { env } from "@/shared/env";
import { testHelpersBuilt } from "@/shared/test-route-gate";
import type { FakeBehavior } from "@/contexts/outreach/email/infrastructure/fake-mailbox-provider";
import { FakeMailboxProvider } from "@/contexts/outreach/email/infrastructure/fake-mailbox-provider";
import { mailboxProvider } from "@/contexts/outreach/infrastructure/composition";
import { linkedinGateways } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/platform/db/client";
import { accounts, linkedinAccounts, members, users } from "@/platform/db/schema";
import { receiveInboundLinkedIn } from "@/contexts/conversations/infrastructure/composition";
import { eq } from "drizzle-orm";
import { resetE2eRateLimits } from "@/contexts/identity/infrastructure/e2e-rate-limit";
import { FakeLinkedInGateway, type FakeLinkedInBehavior } from "@/contexts/outreach/linkedin/infrastructure/fake-linkedin-gateway";

/**
 * DEV ONLY. Lets a browser test drive the in-memory fake mailbox and fake LinkedIn gateway of this process
 * (deliver an inbound email, change send behavior, accept an invitation, read what was "sent", add a member).
 * Answers 404 unless testHelpersBuilt() (not a production build, or one made with E2E_BUILD=1), a fake provider is selected, and E2E_FAKE_CONTROLS=1.
 * Same bearer secret as the job tick.
 */
function allowed(request: Request): boolean {
  if (!testHelpersBuilt() || process.env.E2E_FAKE_CONTROLS !== "1") return false;
  if (env().MAILBOX_PROVIDER !== "fake" && env().LINKEDIN_PROVIDER !== "fake") return false;
  return request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}

export async function POST(request: Request) {
  if (!allowed(request)) return new NextResponse(null, { status: 404 });
  const body = (await request.json()) as Record<string, unknown>;
  const mail = mailboxProvider() as FakeMailboxProvider;
  const li = (await linkedinGateways().forOrganization("")) as FakeLinkedInGateway;
  switch (body.action) {
    case "deliverInbound":
      return NextResponse.json(mail.deliverInbound(String(body.mailbox), (body.email ?? {}) as never));
    case "mailBehavior": {
      const mode = body.mode as FakeBehavior;
      mail.behavior = () => mode;
      return NextResponse.json({ ok: true });
    }
    case "mailFlags":
      if (typeof body.findFails === "boolean") mail.findFails = body.findFails;
      if ("findInconclusive" in body) mail.findInconclusive = (body.findInconclusive as string | null) ?? null;
      if (typeof body.inboundFails === "boolean") mail.inboundFails = body.inboundFails;
      if (typeof body.unverifiable === "string") mail.unverifiable.add(body.unverifiable);
      return NextResponse.json({ ok: true });
    case "resetRateLimits":
      // Clears the auth rate-limit counters so each spec file starts with a full sign-in allowance.
      return NextResponse.json({ ok: resetE2eRateLimits() });
    case "delivered":
      return NextResponse.json(mail.delivered);
    case "seedMember": {
      // Adds a confirmed user with a password and a member role in the organization, shaped as sign-up plus
      // an accepted invitation leave it. A second call for the same email changes nothing and returns the same id.
      const email = String(body.email).toLowerCase();
      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (existing) return NextResponse.json({ userId: existing.id });
      const passwordHash = await hashPassword(String(body.password));
      const userId = await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ name: String(body.name), email, emailVerified: true }).returning({ id: users.id });
        await tx.insert(accounts).values({ userId: user.id, providerId: "credential", accountId: user.id, password: passwordHash });
        await tx.insert(members).values({ organizationId: String(body.organizationId), userId: user.id, role: "member" });
        return user.id;
      });
      return NextResponse.json({ userId });
    }
    case "liAccept":
      li.accept(String(body.member));
      return NextResponse.json({ ok: true });
    case "liBehavior": {
      const mode = body.mode as FakeLinkedInBehavior;
      if (body.kind === "invite") li.inviteBehavior = () => mode;
      else li.messageBehavior = () => mode;
      return NextResponse.json({ ok: true });
    }
    case "liSearchBehavior": {
      // `refuseUrlIncludes` makes searches whose URL contains the text fail with a definite refusal; empty restores normal reads.
      const needle = String(body.refuseUrlIncludes ?? "");
      li.searchBehavior = ({ url }) => (needle !== "" && url.includes(needle) ? { refuse: "rejected" } : "ok");
      return NextResponse.json({ ok: true });
    }
    case "liInbound": {
      // Files a LinkedIn message from a lead through the real inbox ingest, on a connected account of the organization
      // (created on demand, matching the fake gateway's demo account).
      const organizationId = String(body.organizationId);
      const providerAccountId = "demo-account";
      await db.insert(linkedinAccounts).values({ organizationId, providerAccountId, linkedinId: "ACo-demo", name: "Demo Seller", username: "demo-seller", status: "connected" }).onConflictDoNothing();
      const [account] = await db.select({ id: linkedinAccounts.id, organizationId: linkedinAccounts.organizationId }).from(linkedinAccounts).where(eq(linkedinAccounts.providerAccountId, providerAccountId));
      if (!account || account.organizationId !== organizationId) return NextResponse.json({ error: "demo account belongs to another organization" }, { status: 409 });
      const slug = String(body.slug);
      const outcome = await receiveInboundLinkedIn({
        organizationId,
        accountRef: account.id,
        accountName: "Demo Seller",
        providerThreadId: String(body.chat),
        providerMessageId: String(body.messageId),
        counterparty: { providerId: `ACo-${slug}`, name: String(body.name), profileUrl: `https://www.linkedin.com/in/${slug}`, slug },
        personId: null,
        bodyText: String(body.text),
        receivedAt: new Date(),
      });
      return NextResponse.json({ outcome, accountId: account.id });
    }
    case "liState":
      return NextResponse.json({ invitations: li.invitations, messages: li.messages, webhookRegistrations: li.webhookRegistrations, accounts: li.accounts });
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}
