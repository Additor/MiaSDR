import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { HOME, HOME_LABEL } from "@/app/_lib/home";

export default function AppNotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <div className="page stack-group justify-items-start">
        <p className="text-sm text-muted-foreground">This page does not exist, or you no longer have access to it.</p>
        <Link href={HOME} className={buttonVariants()}>
          Back to {HOME_LABEL}
        </Link>
      </div>
    </>
  );
}
