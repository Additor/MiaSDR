import { REPLY_TYPE_GROUPS } from "@/contexts/conversations/domain/reply-handling";
import { AI_PICK_CONFIDENCE_FLOOR, SYSTEM_ROLE_REASONS, type SystemRole, type TypeRules } from "@/contexts/conversations/domain/reply-type";
import { rulesSummary } from "@/app/(app)/inbox/[id]/_lib/type-line";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/utils";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface ReplyTypeItem {
  id: string;
  groupKey: string;
  name: string;
  description: string | null;
  rules: TypeRules;
  systemRole: SystemRole | null;
}

/** The fixed reply types, read-only: what each one does when it applies. */
export function ReplyTypesPanel({ replyTypes }: { replyTypes: ReplyTypeItem[] }) {
  return (
    // Two levels only: a group is an h3, its reply types are the rows of one ruled list.
    <SettingsSection
      title="Reply types"
      description="The AI picks one of these for each reply."
    >
      <div className="stack-section">
        <p className="max-w-prose text-sm" data-testid="ai-pick-rule">
          A pick applies at once and sends nothing. It waits for a person when it is a stop request, when the AI is under {Math.round(AI_PICK_CONFIDENCE_FLOOR * 100)}% confident, or when it would move someone locked as Existing customer to another group. Correct a wrong pick with Change type or Undo.
        </p>
        {REPLY_TYPE_GROUPS.map((g) => (
          <div key={g.key} className="stack-group" data-testid={`group-${g.key}`}>
            <h3 className="heading-item">{g.label}</h3>
            <ul className={RULED_LIST} aria-label={`${g.label} reply types`}>
              {replyTypes
                .filter((t) => t.groupKey === g.key)
                .map((t) => (
                  <li key={t.id} data-testid="reply-type-row" className={cn(RULED_ROW, "grid gap-1 text-sm")}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{t.name}</span>
                      {t.systemRole === "customer" && <Badge variant="secondary">Locked</Badge>}
                    </div>
                    <p className="text-muted-foreground" data-testid="reply-type-rules">
                      {rulesSummary(t.rules)}
                    </p>
                    {t.systemRole && <p className="text-muted-foreground">{SYSTEM_ROLE_REASONS[t.systemRole]}</p>}
                    {t.description && <p className="text-muted-foreground">{t.description}</p>}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
