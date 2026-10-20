import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AuthCardSkeleton } from "../../auth-skeleton";
import { apiUser } from "@/contexts/identity/infrastructure/session";
import { canCreateOrganization } from "@/contexts/identity/infrastructure/signup-facts";
import { OrganizationForm } from "./organization-form";

export const metadata: Metadata = { title: "New organization" };

export default function NewOrganizationPage() {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <NewOrganization />
    </Suspense>
  );
}

async function NewOrganization() {
  await connection();
  const user = await apiUser();
  if (!user) redirect("/sign-in?next=%2Forganizations%2Fnew");
  if (!(await canCreateOrganization(user.userId))) redirect("/leads");
  return <OrganizationForm />;
}
