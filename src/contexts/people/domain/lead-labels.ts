import { humanizeToken } from "@/shared/humanize";

/** "import:<run id>" is an internal reference, so the page shows the kind of source only. */
export function sourceLabel(source: string): string {
  return source === "import" || source.startsWith("import:") ? "File import" : humanizeToken(source.split(":")[0]);
}
