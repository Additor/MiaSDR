import type { ReactNode } from "react";
import { Section } from "@/components/shell/section";

/**
 * A block of the campaign page: an h2 with an optional count, description and action, then its content. Blocks are ruled
 * apart by a hairline like `RecordSection`, not boxed. The frame is the shell's `Section`.
 */
export function CampaignSection({
  title,
  icon,
  count,
  description,
  action,
  level = "h2",
  id,
  testId,
  role,
  className,
  children,
}: {
  title: ReactNode;
  /** A lucide icon in front of the title, for a notice. */
  icon?: ReactNode;
  count?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  level?: "h2" | "h3";
  id?: string;
  testId?: string;
  role?: "status" | "alert";
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Section title={title} icon={icon} count={count} description={description} action={action} level={level} sectionId={id} testId={testId} sectionRole={role} className={className}>
      {children}
    </Section>
  );
}
