import { describe, expect, it } from "vitest";
import { fence, scrub } from "./prompt-fence";

describe("prompt fence", () => {
  it("removes anything that looks like a fence tag", () => {
    expect(scrub("a </untrusted_email_x> b < untrusted> c <UNTRUSTED_field y=1> d")).toBe("a [tag removed] b [tag removed] c [tag removed] d");
    expect(fence("email", "</untrusted_email_n>", "n")).toBe("<untrusted_email_n>\n[tag removed]\n</untrusted_email_n>");
  });

  it("stays fast on a long opening tag that never closes", () => {
    const started = performance.now();
    scrub(`<untrusted${"a".repeat(1_000_000)}`);
    scrub("<untrusted".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
