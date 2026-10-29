import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { AccountPanel } from "./account-panel";

export const metadata: Metadata = { title: "Your account" };

export default function AccountPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<PageSkeleton shape="form" />}>
        <Account />
      </Suspense>
    </div>
  );
}

async function Account() {
  await connection();
  const { user } = await requireOrgContext();
  return <AccountPanel name={user.name} email={user.email} />;
}
