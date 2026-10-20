import Link from "next/link";

const INBOUND_EVENTS_PATH = "/settings/inbound-events";

/** Shows a stored error text and turns the inbound events path in it into a link. */
export function ErrorWithLinks({ text }: { text: string }) {
  const at = text.indexOf(INBOUND_EVENTS_PATH);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <Link href={INBOUND_EVENTS_PATH} className="underline underline-offset-2">
        {INBOUND_EVENTS_PATH}
      </Link>
      {text.slice(at + INBOUND_EVENTS_PATH.length)}
    </>
  );
}
