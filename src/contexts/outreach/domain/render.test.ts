import { describe, expect, it } from "vitest";
import { applyMergeFields, applySignature, applySpin, applySpinLongest, renderEmail, toHtmlBody } from "./render";

describe("applySpin", () => {
  it("picks one option and leaves non-spin braces alone", () => {
    expect(applySpin("{Hi|Hello|Hey} there", () => 0)).toBe("Hi there");
    expect(applySpin("{Hi|Hello|Hey} there", () => 0.99)).toBe("Hey there");
    expect(applySpin("keep {this} as is", () => 0)).toBe("keep {this} as is");
  });
  it("does not touch merge fields", () => {
    expect(applySpin("{{firstName}}", () => 0)).toBe("{{firstName}}");
  });
});

describe("applyMergeFields", () => {
  it("is case-insensitive and blanks missing keys", () => {
    expect(applyMergeFields("Hi {{ FirstName }}, {{missing}}!", { firstName: "Ann" })).toBe("Hi Ann,!");
  });
  it("supports non-Latin keys", () => {
    expect(applyMergeFields("업종: {{업종}}", { 업종: "SaaS" })).toBe("업종: SaaS");
  });
  it("leaves the signature placeholder for the signature step", () => {
    expect(applyMergeFields("{{signature}}", {})).toBe("{{signature}}");
  });
  it("does not leave a double space after an empty field", () => {
    expect(applyMergeFields("Hi {{firstName}} there", { firstName: "" })).toBe("Hi there");
    expect(applyMergeFields("Hi {{firstName}} there", { firstName: null })).toBe("Hi there");
    expect(applyMergeFields("Hi {{firstName}} {{lastName}} there", {})).toBe("Hi there");
    expect(applyMergeFields("Hi {{a}}{{b}} there", {})).toBe("Hi there");
  });
  it("drops the space before punctuation or a line end after an empty field", () => {
    expect(applyMergeFields("Hi {{firstName}}, welcome", { firstName: "" })).toBe("Hi, welcome");
    expect(applyMergeFields("Best,\n{{firstName}}", { firstName: "" })).toBe("Best,\n");
    expect(applyMergeFields("Thanks {{firstName}}\nBye", { firstName: "" })).toBe("Thanks\nBye");
    expect(applyMergeFields("Thanks {{firstName}}", { firstName: " " })).toBe("Thanks  ");
  });
  it("trims a field at the start of a line without eating the line break", () => {
    expect(applyMergeFields("{{firstName}} hello\n{{firstName}} again", {})).toBe("hello\nagain");
  });
  it("leaves filled fields and the spaces around them alone", () => {
    expect(applyMergeFields("Hi {{firstName}}  there", { firstName: "Ann" })).toBe("Hi Ann  there");
    expect(applyMergeFields("Hi  there", {})).toBe("Hi  there");
  });
});

describe("applySpinLongest", () => {
  it("takes the longest option of each group and ignores plain braces", () => {
    expect(applySpinLongest("{Hi|Hello there|Hey} {a|bb}, keep {this}")).toBe("Hello there bb, keep {this}");
  });
});

describe("applySignature", () => {
  it("fills the placeholder in any common spelling", () => {
    expect(applySignature("Hi\n%signature%", "-- Ann")).toBe("Hi\n-- Ann");
    expect(applySignature("Hi\n% Signature %", "-- Ann")).toBe("Hi\n-- Ann");
    expect(applySignature("Hi\n{{SIGNATURE}}", "-- Ann")).toBe("Hi\n-- Ann");
  });
  it("appends when there is no placeholder", () => {
    expect(applySignature("Hi", "-- Ann")).toBe("Hi\n\n-- Ann");
  });
  it("removes the placeholder when no signature is set", () => {
    expect(applySignature("Hi\n%signature%", null)).toBe("Hi");
    expect(applySignature("Hi", "  ")).toBe("Hi");
  });
});

describe("toHtmlBody", () => {
  it("escapes HTML, links URLs without trailing punctuation, links addresses, keeps line breaks", () => {
    const html = toHtmlBody("<b>x</b> see https://a.co/p. mail me@a.co\nbye");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain('<a href="https://a.co/p">https://a.co/p</a>.');
    expect(html).toContain('<a href="mailto:me@a.co">me@a.co</a>');
    expect(html).toContain("<br />bye");
  });
});

describe("renderEmail", () => {
  const input = {
    subjectTemplate: "{Quick|Short} question for {{firstName}}",
    bodyTemplate: "Hi {{firstName}},\n\nAt {{company}}?\n\n%signature%",
    variables: { firstName: "Ann", company: "Acme" },
    signatureHtml: "Bob",
    unsubscribeUrl: "https://app.test/unsubscribe?token=t",
    random: () => 0,
  };
  it("renders subject and both bodies with the unsubscribe footer", () => {
    const out = renderEmail(input);
    expect(out.subject).toBe("Quick question for Ann");
    expect(out.bodyText).toContain("Hi Ann,\n\nAt Acme?\n\nBob");
    expect(out.bodyText).toContain("Unsubscribe: https://app.test/unsubscribe?token=t");
    expect(out.bodyHtml).toContain(">Unsubscribe</a>");
  });
  it("does not let lead data inject spin text or HTML", () => {
    const out = renderEmail({ ...input, variables: { firstName: "{A|B}<i>", company: "x" } });
    expect(out.subject).toContain("{A|B}<i>");
    expect(out.bodyHtml).toContain("{A|B}&lt;i&gt;");
  });
});
