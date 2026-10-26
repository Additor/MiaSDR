import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AuthCardSkeleton } from "../auth-skeleton";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { isPublicSignupAvailable, pendingInvitationEmail } from "@/contexts/identity/infrastructure/signup-facts";
import { env } from "@/shared/env";
import { needsSetup } from "@/contexts/tenancy/application/setup-instance";
import { setupDeps } from "@/contexts/tenancy/infrastructure/onboarding-composition";
import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create account" };

export default function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <SignUp searchParams={searchParams} />
    </Suspense>
  );
}

async function SignUp({ searchParams }: { searchParams: PageProps<"/sign-up">["searchParams"] }) {
  await connection();
  // The first account comes from /setup. Better Auth refuses a sign-up while no user exists.
  if (await needsSetup(setupDeps())) redirect("/setup");
  const googleEnabled = Boolean(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET);
  const { invitation } = await searchParams;
  const invitedEmail = typeof invitation === "string" ? await pendingInvitationEmail(invitation) : null;
  if (invitedEmail) return <SignUpForm invitedEmail={invitedEmail} invitationId={String(invitation)} googleEnabled={googleEnabled} />;
  if (await isPublicSignupAvailable()) return <SignUpForm googleEnabled={googleEnabled} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">Invitation only</CardTitle>
        <CardDescription>
          This MiaSDR instance accepts new accounts by invitation. Ask an admin to invite your email address, then open the link in the invitation.
        </CardDescription>
      </CardHeader>
      <CardFooter>
        <Link href="/sign-in" className="text-sm underline">Back to sign in</Link>
      </CardFooter>
    </Card>
  );
}
