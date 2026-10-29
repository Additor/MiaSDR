import Link from "next/link";
import { rowLinkClasses } from "@/components/shell/row-link";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PersonDealRow } from "@/contexts/deals/application/deal-ports";
import { DealRowLink } from "./deal-row-link";
import { moneyText } from "./money-text";

/** An open deal reads filled, a won or lost one outlined, so closed deals step back in a list. Both stay neutral. */
export const stageVariant = (kind: string) => (kind === "open" ? "secondary" : "outline");

/**
 * Deals of a contact or of a company's contacts, newest first. Each row opens the deal page. With `contactNames`, a
 * Contact column links each deal to its person. Stage badges stay neutral (PRODUCT.md: the brand hue marks waiting work). A deal
 * link names the page it sits on as `from`, so a delete on the deal page returns there.
 */
export function DealsList({ deals, contactNames }: { deals: PersonDealRow[]; contactNames?: Map<string, string> }) {
  return (
    <ScrollableTable>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Deal</TableHead>
            {contactNames && <TableHead>Contact</TableHead>}
            <TableHead>Stage</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>In stage since</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deals.map((deal) => (
            <TableRow key={deal.id} className={rowLinkClasses}>
              <TableCell className="min-w-44 whitespace-normal">
                <DealRowLink dealId={deal.id}>{deal.title}</DealRowLink>
              </TableCell>
              {contactNames && (
                <TableCell>
                  <Link href={`/crm/contacts/${deal.personId}`} className="relative z-10 rounded-sm hover:underline focus-ring">
                    {contactNames.get(deal.personId) ?? "Contact"}
                  </Link>
                </TableCell>
              )}
              <TableCell>
                <Badge variant={stageVariant(deal.stageKind)}>{deal.stageName}</Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">{moneyText(deal.amountMinor, deal.currency) ?? ""}</TableCell>
              <TableCell className="text-muted-foreground">
                <Time value={deal.stageChangedAt} dateOnly />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollableTable>
  );
}
