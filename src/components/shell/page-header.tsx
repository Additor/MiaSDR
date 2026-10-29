import { ChevronLeftIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { EditableTitle, type RenameResult } from "./editable-title";

export interface PageHeaderBack {
  href: string;
  /** The parent page's name, such as "Leads". Shown before the title on wider screens as "Leads / Title". */
  label: string;
}

/**
 * The one header every page uses, always on a single line: sidebar trigger, an optional parent link that reads as
 * a breadcrumb ("Leads / Ada Lovelace"), the title, and an actions area on the right. The title truncates first; on a narrow screen the actions
 * scroll sideways inside their own area, so the header never grows a second row.
 *
 * The bar is one line of text-sm. The parent step reads muted, the current page in the foreground at medium weight, so
 * "Leads / Ada Lovelace" reads as one breadcrumb. The page's display heading, when it has one, lives in the body. The bar
 * shares the body's gutter, so the title and the content start on one line.
 *
 * A page whose name you can change passes `rename`: the title becomes an `EditableTitle` you rename in place, and the
 * actions area stays for the page's own actions.
 */
export function PageHeader({
  title,
  back,
  actions,
  titleAs: Title = "h1",
  rename,
}: {
  title: string;
  back?: PageHeaderBack;
  actions?: ReactNode;
  /** A record page passes "p": its RecordHeader carries the page's h1, and the bar keeps the name as the breadcrumb's last step. */
  titleAs?: "h1" | "p";
  /** Makes the title editable in place. `label` names the thing for the field, such as "Workbook name". */
  rename?: { label: string; onSave: (name: string) => Promise<RenameResult> };
}) {
  return (
    <header className="flex h-14 items-center gap-3 border-b px-gutter">
      <SidebarTrigger className="shrink-0 max-sm:size-11" />
      {back && (
        <>
          <Link
            href={back.href}
            aria-label={`Back to ${back.label}`}
            title={`Back to ${back.label}`}
            className="-ml-1 inline-flex h-8 shrink-0 items-center gap-1 rounded-md pr-2 pl-1 text-sm max-sm:h-11 max-sm:min-w-11 max-sm:justify-center text-muted-foreground hover:bg-muted hover:text-foreground focus-ring"
          >
            <ChevronLeftIcon className="size-4 shrink-0" />
            <span className="hidden max-w-40 truncate sm:inline">{back.label}</span>
          </Link>
          <span aria-hidden className="-mx-1 hidden text-sm text-muted-foreground/60 sm:inline">
            /
          </span>
        </>
      )}
      {rename ? <EditableTitle as={Title} value={title} label={rename.label} onSave={rename.onSave} className="flex-1" /> : <Title className="min-w-0 flex-1 truncate text-sm font-medium">{title}</Title>}
      {actions && <div className="flex max-w-[65%] shrink-0 items-center gap-2 overflow-x-auto">{actions}</div>}
    </header>
  );
}
