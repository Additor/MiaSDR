import type { ClassifyInput, ClassifyOutput, DraftInput, DraftOutput } from "../domain/ai-contract";
import type { ReplyAi } from "../application/ai-ports";

/**
 * Keyword classifier and template drafter for tests and demos (AI_PROVIDER=fake). It never calls a
 * network. Tests replace `classifyWith` or `draftWith` to return anything, including answers a real
 * model might give after a prompt injection, so the closed-schema checks in the use cases get exercised.
 */
export class FakeReplyAi implements ReplyAi {
  readonly name = "fake";
  readonly model = "fake-1";
  classifyCalls = 0;
  draftCalls = 0;
  /** Prompts the last calls were given, for assertions about what reached the model. */
  lastClassifyInput: ClassifyInput | null = null;
  lastDraftInput: DraftInput | null = null;
  classifyWith: ((input: ClassifyInput) => unknown) | null = null;
  draftWith: ((input: DraftInput) => unknown) | null = null;
  failWith: Error | null = null;

  async classify(input: ClassifyInput) {
    this.classifyCalls += 1;
    this.lastClassifyInput = input;
    if (this.failWith) throw this.failWith;
    if (this.classifyWith) return { output: this.classifyWith(input) as ClassifyOutput };
    const latest = [...input.thread].reverse().find((e) => e.direction === "inbound");
    const text = `${latest?.subject ?? ""}\n${latest?.text ?? ""}`.toLowerCase();
    const has = (key: string) => input.taxonomy.some((t) => t.key === key);
    const pick = (key: string, confidence: number, reason: string): ClassifyOutput => ({ subcategoryKey: has(key) ? key : input.taxonomy[0].key, confidence, reason });
    if (/unsubscribe|stop (emailing|contacting)|remove me|do not contact/.test(text)) return { output: pick("do_not_contact", 0.97, "The sender asks us to stop.") };
    if (/out of (the )?office|on vacation|auto-?reply/.test(text)) return { output: pick("out_of_office", 0.95, "An out-of-office notice.") };
    if (/demo/.test(text)) return { output: pick("demo_request", 0.92, "The sender asks for a demo.") };
    if (/meeting|call|calendar|schedule/.test(text)) return { output: pick("meeting_requested", 0.9, "The sender proposes a meeting.") };
    if (/pricing|price|more info|information|case study/.test(text)) return { output: pick("information_requested", 0.88, "The sender asks for information.") };
    if (/not interested|no thanks|not now/.test(text)) return { output: pick("not_required_right_now", 0.9, "The sender declines for now.") };
    return { output: pick("other", 0.5, "No clear intent.") };
  }

  async draft(input: DraftInput) {
    this.draftCalls += 1;
    this.lastDraftInput = input;
    if (this.failWith) throw this.failWith;
    if (this.draftWith) return { output: this.draftWith(input) as DraftOutput };
    const first = input.person.name?.split(/\s+/)[0] ?? "there";
    const note = input.feedback ? `\n\n(Revised: ${input.feedback})` : "";
    if (input.channel === "linkedin") {
      return { output: { subject: "", bodyText: `Hi ${first}, thanks for the reply. ${input.classification ? `We read this as: ${input.classification.subcategoryName}. ` : ""}What works best for you next?${note}` } };
    }
    return {
      output: {
        subject: input.subject,
        bodyText: `Hi ${first},\n\nThanks for getting back to us. ${input.classification ? `We read this as: ${input.classification.subcategoryName}. ` : ""}Happy to help, what works best for you next?${note}\n\nBest,\n${input.senderName ?? "The team"}`,
      },
    };
  }
}
