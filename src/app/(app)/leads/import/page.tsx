import type { Metadata } from "next";
import { PageHeader } from "@/components/shell/page-header";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "Import leads" };

export default function ImportLeadsPage() {
  return (
    <>
      <PageHeader title="Import leads" back={{ href: "/leads", label: "Leads" }} />
      <div className="page stack-group">
        <ImportWizard />
      </div>
    </>
  );
}
