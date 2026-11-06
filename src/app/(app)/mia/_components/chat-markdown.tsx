import Link from "next/link";
import type { ReactNode } from "react";
import { isAppLink } from "@/contexts/mia/domain/mia-chat";

/**
 * The little Markdown an answer uses: paragraphs, lists, bold, code and links. It builds React elements and never HTML,
 * so a steered answer cannot add a tag, an image or a script. A link opens only when it points into the app
 * (`isAppLink`); any other link shows as its text, since an outside address could carry what Mia read away in its query.
 */
export function ChatMarkdown({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return (
    <div className="grid gap-2">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

function Block({ block }: { block: string }) {
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  if (lines.every((line) => BULLET.test(line))) {
    const ordered = /^\s*\d/.test(lines[0]);
    const List = ordered ? "ol" : "ul";
    return (
      <List className={ordered ? "ml-5 list-decimal space-y-1" : "ml-5 list-disc space-y-1"}>
        {lines.map((line, i) => (
          <li key={i}>{inline(line.replace(BULLET, ""))}</li>
        ))}
      </List>
    );
  }
  const heading = /^#{1,6}\s+(.*)$/.exec(lines[0]);
  if (heading && lines.length === 1) return <p className="font-medium">{inline(heading[1])}</p>;
  return (
    <p className="whitespace-pre-wrap">
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 && "\n"}
          {inline(line.replace(/^#{1,6}\s+/, ""))}
        </span>
      ))}
    </p>
  );
}

/** Links, code and bold, left to right. An image's `!` stays as text, and its address with it. */
const TOKEN = /\[([^\]\n]+)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, label, href, code, bold] = match;
    if (label !== undefined) {
      out.push(
        isAppLink(href) ? (
          <Link key={key++} href={href} className="font-medium underline underline-offset-2 focus-ring">
            {label}
          </Link>
        ) : (
          label
        ),
      );
    } else if (code !== undefined) {
      out.push(
        <code key={key++} className="rounded bg-muted px-1 text-[0.85em]">
          {code}
        </code>,
      );
    } else if (bold !== undefined) out.push(<strong key={key++}>{bold}</strong>);
    else out.push(whole);
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
