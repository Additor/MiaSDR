import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { HOME, HOME_LABEL } from "@/app/_lib/home";

export default function AppNotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <div className="page">
        <EmptyState className="py-0" title="Nothing at this address" description="This page does not exist, or you no longer have access to it." action={{ label: `Back to ${HOME_LABEL}`, href: HOME }} />
      </div>
    </>
  );
}
