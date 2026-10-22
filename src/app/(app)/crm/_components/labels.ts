import { categoryLabel } from "@/contexts/conversations/domain/reply-handling";

export { categoryLabel };

/** `{Name}` in contact copy: the full name, else the email, else "this contact". */
export function contactLabel(person: { fullName?: string | null; email?: string | null }): string {
  return person.fullName?.trim() || person.email?.trim() || "this contact";
}
