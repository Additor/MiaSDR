import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AuthCardSkeleton } from "../auth-skeleton";
import { needsSetup } from "@/contexts/tenancy/application/setup-instance";
import { setupDeps } from "@/contexts/tenancy/infrastructure/onboarding-composition";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up" };

export default function SetupPage() {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <Setup />
    </Suspense>
  );
}

async function Setup() {
  await connection();
  if (!(await needsSetup(setupDeps()))) redirect("/sign-in");
  return <SetupForm />;
}
