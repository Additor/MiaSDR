import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AuthCardSkeleton } from "../auth-skeleton";
import { needsSetup } from "@/contexts/tenancy/application/setup-instance";
import { setupDeps } from "@/contexts/tenancy/infrastructure/onboarding-composition";
import { isPublicSignupAvailable } from "@/contexts/identity/infrastructure/signup-facts";
import { env } from "@/shared/env";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <SignIn />
    </Suspense>
  );
}

const googleEnabled = () => Boolean(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET);

async function SignIn() {
  await connection();
  // A fresh instance has no accounts to sign in to: send the operator to first-run setup.
  if (await needsSetup(setupDeps())) redirect("/setup");
  return <SignInForm signupAvailable={await isPublicSignupAvailable()} googleEnabled={googleEnabled()} />;
}
