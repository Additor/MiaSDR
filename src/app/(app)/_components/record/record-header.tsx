import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Count, Section } from "@/components/shell/section";

/**
 * The top of a lead, contact, company or deal page: who or what this is, how to reach it, where it stands, and what to
 * do next. The name is the page's h1; the top bar keeps it as the breadcrumb's last step. Facts beyond these live in the
 * page's Details panel.
 */
export function RecordHeader({
  name,
  subtitle,
  state,
  status,
  reach,
  actions,
  testId,
}: {
  name: string;
  /** "Title at Company", or the company's domain. */
  subtitle?: ReactNode;
  /** One state token beside the name, such as the lead status. A contact passes none. */
  state?: ReactNode;
  /** One metadata line (MetaLine) for company and deal pages: stage, owner, amount, counts. */
  status?: ReactNode;
  /** `ReachLinks`: email, phone and LinkedIn with their reach state. */
  reach?: ReactNode;
  /** The record's actions, the main one first: at most one filled button, then outline ones, then a ghost More menu. */
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <section aria-labelledby="page-title" className="stack-group border-b pb-section" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="stack-field min-w-0">
          {/* The token follows the name on its line and wraps under it on a phone, above the actions. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 id="page-title" className="heading-record min-w-0 text-balance break-words">
              {name}
            </h1>
            {state}
          </div>
          {subtitle && <div className="text-sm text-muted-foreground">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 max-sm:[&_a]:h-11 max-sm:[&_button]:h-11">{actions}</div>}
      </div>
      {status}
      {reach}
    </section>
  );
}

/**
 * One line of facts under the record's name, separated by middots, for company and deal pages. Plain text carries the
 * usual facts; a Badge inside an item marks the deal stage. Lead status and reach have their own forms (`state`, `reach`).
 */
export function MetaLine({ label, items, testId }: { label: string; items: ReactNode[]; testId?: string }) {
  const shown = items.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <ul
      aria-label={label}
      data-testid={testId}
      // The items run on one line with middots between them and wrap where the width runs out, a phone included.
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground [&>li+li]:before:mr-2 [&>li+li]:before:text-muted-foreground/60 [&>li+li]:before:content-['·']"
    >
      {shown.map((item, index) => (
        <li key={index} className="flex min-w-0 items-center">
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * The body under a RecordHeader: the work column, a ruled sheet of sections, and a 20rem side column with one panel of
 * facts and stop controls. One column on a phone, main first.
 */
export function RecordBody({ main, aside, asideLabel }: { main: ReactNode; aside: ReactNode; asideLabel: string }) {
  return (
    <div className="grid gap-section lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid min-w-0 content-start">{main}</div>
      <aside aria-label={asideLabel} className="min-w-0 content-start self-start rounded-lg border">
        <div className="divide-y">{aside}</div>
      </aside>
    </div>
  );
}

/**
 * A section of the work column: an h2 with an optional count and action, then its content flush to the column. Sections
 * are ruled apart by a hairline, not boxed.
 */
export function RecordSection({
  title,
  count,
  action,
  level = "h2",
  testId,
  children,
}: {
  title: string;
  /** A short tally beside the title, such as "2 open of 3". */
  count?: ReactNode;
  action?: ReactNode;
  /** h3 when the section sits inside another one. */
  level?: "h2" | "h3";
  testId?: string;
  children?: ReactNode;
}) {
  // The last section keeps its bottom space: the histories (`RecordDisclosure`) follow it with their own rule.
  return (
    <Section title={title} count={count} action={action} level={level} testId={testId} flushEnd={false}>
      {children}
    </Section>
  );
}

/** A section of the side panel: a title row with an optional action, then its content, padded by the inset role. */
export function AsideSection({ title, action, testId, children }: { title: string; action?: ReactNode; testId?: string; children: ReactNode }) {
  return (
    <Section frame="inset" role="subsection" title={title} action={action} testId={testId}>
      {children}
    </Section>
  );
}

/**
 * A side panel section you open when you need it: history and lists a person reads now and then, with their count in
 * the title row. `open` starts it open, for a list that waits for a decision.
 */
export function AsideDisclosure({ title, count, open = false, testId, children }: { title: string; count?: ReactNode; open?: boolean; testId?: string; children: ReactNode }) {
  return (
    <details className="group p-inset" open={open} data-testid={testId}>
      <summary className="-m-1 flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-md p-1 select-none focus-ring max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-panel) ease-out group-open:rotate-90" />
        <h2 className="heading-subsection">{title}</h2>
        {count !== undefined && count !== null && <Count value={count} />}
      </summary>
      <div className="stack-group mt-group">{children}</div>
    </details>
  );
}

/**
 * A history in the work column that you open when you need it: a hairline above, the title with its count, then the
 * content. Several in a row read as one ruled list.
 */
export function RecordDisclosure({ title, count, open = false, testId, children }: { title: string; count?: ReactNode; open?: boolean; testId?: string; children: ReactNode }) {
  return (
    <details className="group border-t py-group" open={open} data-testid={testId}>
      <summary className="-mx-1 flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-md px-1 select-none focus-ring max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-panel) ease-out group-open:rotate-90" />
        <h3 className="heading-subsection">{title}</h3>
        {count !== undefined && count !== null && <Count value={count} />}
      </summary>
      <div className="stack-group mt-group">{children}</div>
    </details>
  );
}

/** Page frame for a record: header, then body, with the page padding. */
export function RecordPage({ children }: { children: ReactNode }) {
  return <div className="page stack-section">{children}</div>;
}
