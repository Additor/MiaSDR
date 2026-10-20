import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";

export default function AppNotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <div className="page stack-group justify-items-start">
        <p className="text-sm text-muted-foreground">This page does not exist, or you no longer have access to it.</p>
        <Link href="/leads" className={buttonVariants()}>
          Back to Leads
        </Link>
      </div>
    </>
  );
}
