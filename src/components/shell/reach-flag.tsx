import { BanIcon, MailXIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * A person or address that cannot get mail, as a neutral badge with the reach icon. Red stays for the sentence that
 * explains why a send is disabled.
 */
export function ReachFlag({ kind }: { kind: "do_not_contact" | "suppressed" }) {
  return (
    <Badge variant="secondary">
      {kind === "suppressed" ? <MailXIcon aria-hidden /> : <BanIcon aria-hidden />}
      {kind === "suppressed" ? "Email suppressed" : "Do not contact"}
    </Badge>
  );
}
