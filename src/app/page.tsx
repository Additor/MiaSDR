import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { needsSetup } from "@/contexts/tenancy/application/setup-instance";
import { setupDeps } from "@/contexts/tenancy/infrastructure/onboarding-composition";

export default function Home() {
  return (
    <Suspense>
      <Entry />
    </Suspense>
  );
}

/** A fresh instance goes to first-run setup; everyone else to the app (the proxy sends anonymous visitors to sign-in). */
async function Entry(): Promise<never> {
  await connection();
  redirect((await needsSetup(setupDeps())) ? "/setup" : "/leads");
}
