import { afterAll, expect, it } from "vitest";
import type { AgentChatRequest, AgentModel } from "@/contexts/ai/application/agent-ports";
import { AiError } from "@/contexts/ai/domain/ai-error";
import type { AiStatus } from "@/contexts/integrations/domain/ai-status";
import { deleteContact } from "@/contexts/people/application/contact-delete";
import { deleteLeads } from "@/contexts/people/application/lead-management";
import { contactDeleteDeps, leadDeleteDeps } from "@/composition/person-lifecycle";
import { releaseMiaOfMemberTx } from "../drizzle-mia-chat-store";
import { db } from "@/platform/db/client";
import { pruneHistory, DEFAULT_RETENTION } from "@/platform/jobs/prune";
import type { Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { askMia, deleteChat, newChat, openChat, retryAnswer, stopAnswer, type MiaChatDeps, type TurnListener } from "../../application/chat-use-cases";
import { miaChatDeps } from "../composition";
import { fakeAgentModel } from "../fake-mia";

describeDb("Mia chat", () => {
  useTestEnv();
  const sql = testSql({ max: 2 });
  const orgs: TestOrg[] = [];
  const extraUsers: string[] = [];

  async function fixture(): Promise<Actor> {
    const org = await createTestOrg(sql, "Chat", "member");
    orgs.push(org);
    return { userId: org.userId, organizationId: org.organizationId, role: "member" };
  }

  /** A colleague in the same organization. */
  async function colleague(actor: Actor): Promise<Actor> {
    const [{ id }] = await sql<{ id: string }[]>`insert into users (name, email, email_verified) values ('Colleague', ${`c-${Math.random().toString(36).slice(2)}@chat.test`}, true) returning id`;
    extraUsers.push(id);
    await sql`insert into members (organization_id, user_id, role) values (${actor.organizationId}, ${id}, 'member')`;
    return { ...actor, userId: id };
  }

  const on = async () => ({ state: "on" }) as unknown as AiStatus;
  const deps = (model: AgentModel = fakeAgentModel): MiaChatDeps => miaChatDeps({ aiStatus: on, models: { forOrganization: async () => model, status: on } });

  const silent: TurnListener = { text: () => undefined, tool: () => undefined, end: () => undefined };

  async function ask(actor: Actor, threadId: string, text: string, d = deps(), clientId = crypto.randomUUID(), listener = silent) {
    const handle = await askMia(d, actor, threadId, { clientId, text }, listener);
    await handle.done;
    return handle;
  }

  async function person(actor: Actor, name: string, lifecycle: "lead" | "contact" = "lead") {
    const [row] = await sql<{ id: string }[]>`
      insert into people (organization_id, full_name, title, email, lifecycle, converted_at)
      values (${actor.organizationId}, ${name}, 'VP Sales', ${`${name.split(" ")[0].toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@chat.test`}, ${lifecycle}, ${lifecycle === "contact" ? new Date() : null})
      returning id`;
    return row.id;
  }

  afterAll(async () => {
    await dropOrgs(sql, orgs, extraUsers);
    await sql.end();
  });

  it("answers from what its tools read, links what it read, and counts the tokens", async () => {
    const actor = await fixture();
    const ana = await person(actor, "Ana Quokka");
    const { id } = await newChat(deps(), actor, null);
    const seen: string[] = [];
    await ask(actor, id, "Who is Quokka?", deps(), crypto.randomUUID(), { ...silent, text: (d) => void seen.push(d) });

    const view = await openChat(deps(), actor, id);
    expect(view.thread.title).toBe("Who is Quokka?");
    expect(view.going).toBe(false);
    const [question, answer] = view.messages;
    expect(question).toMatchObject({ role: "user", status: "complete" });
    expect(answer).toMatchObject({ role: "assistant", status: "complete" });
    expect(seen.join("")).toContain(`[Ana Quokka](/leads/${ana})`);
    expect(answer.parts).toEqual(expect.arrayContaining([{ type: "tool", name: "search_leads", failed: false, links: [{ href: `/leads/${ana}`, label: "Ana Quokka" }] }]));
    expect(await sql`select person_id from mia_thread_people where thread_id = ${id}`).toEqual([{ person_id: ana }]);
    const [usage] = await sql`select input_tokens, output_tokens from mia_usage_daily where organization_id = ${actor.organizationId}`;
    expect(usage).toMatchObject({ input_tokens: 300, output_tokens: 60 });
  });

  it("sends a question once however often it is sent, and lets one answer go at a time", async () => {
    const actor = await fixture();
    const { id } = await newChat(deps(), actor, null);
    const clientId = crypto.randomUUID();
    const first = await ask(actor, id, "Any leads?", deps(), clientId);
    const again = await askMia(deps(), actor, id, { clientId, text: "Any leads?" }, silent);
    expect(again).toMatchObject({ answerId: first.answerId, started: false });
    expect(await sql`select 1 from mia_messages where thread_id = ${id}`).toHaveLength(2);

    const slow = await askMia(deps(), actor, id, { clientId: crypto.randomUUID(), text: "Tell me slowly about leads" }, silent);
    await expect(askMia(deps(), actor, id, { clientId: crypto.randomUUID(), text: "And now?" }, silent)).rejects.toMatchObject({ details: { code: "turn_running" } });
    await stopAnswer(deps(), actor, id);
    await slow.done;
  });

  it("stops an answer and keeps what it wrote, then a retry answers the same question again", async () => {
    const actor = await fixture();
    const { id } = await newChat(deps(), actor, null);
    const handle = await askMia(deps(), actor, id, { clientId: crypto.randomUUID(), text: "List the leads slowly" }, silent);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await stopAnswer(deps(), actor, id);
    await handle.done;
    let answer = (await openChat(deps(), actor, id)).messages[1];
    expect(answer.status).toBe("stopped");
    expect(answer.parts.some((p) => p.type === "text" && p.text.length > 0)).toBe(true);

    // The same question again, answered at a normal pace this time.
    const quick: AgentModel = { ...fakeAgentModel, chat: (r) => fakeAgentModel.chat({ ...r, messages: r.messages.map((m) => ({ ...m, content: m.content.replace("slowly", "") })) }) };
    await (await retryAnswer(deps(quick), actor, id, silent)).done;
    const view = await openChat(deps(), actor, id);
    expect(view.messages).toHaveLength(2);
    answer = view.messages[1];
    expect(answer.status).toBe("complete");
    await expect(retryAnswer(deps(), actor, id, silent)).rejects.toMatchObject({ details: { code: "nothing_to_retry" } });
  });

  it("records a failed answer with the provider's reason and charges what it sent", async () => {
    const actor = await fixture();
    const failing: AgentModel = { ...fakeAgentModel, chat: async () => Promise.reject(new AiError("Anthropic rejected the API key. Replace it in Settings, Integrations.", "permanent")) };
    const { id } = await newChat(deps(), actor, null);
    await ask(actor, id, "Hello", deps(failing));
    const answer = (await openChat(deps(), actor, id)).messages[1];
    expect(answer).toMatchObject({ status: "failed", error: expect.stringContaining("rejected the API key") });
    const [usage] = await sql`select input_tokens from mia_usage_daily where organization_id = ${actor.organizationId}`;
    expect(usage.input_tokens).toBeGreaterThan(0);
    // The turn is free again.
    expect((await sql`select turn_token from mia_threads where id = ${id}`)[0].turn_token).toBeNull();
  });

  it("keeps a chat to the person who started it", async () => {
    const actor = await fixture();
    const other = await colleague(actor);
    const { id } = await newChat(deps(), actor, null);
    await expect(openChat(deps(), other, id)).rejects.toThrow("Chat not found");
    await expect(askMia(deps(), other, id, { clientId: "x", text: "Hi" }, silent)).rejects.toThrow("Chat not found");
    await expect(deleteChat(deps(), other, id)).rejects.toThrow("Chat not found");
    await expect(stopAnswer(deps(), other, id)).rejects.toThrow();
    expect(await openChat(deps(), actor, id)).toBeDefined();
  });

  it("refuses past the day's tokens with when to ask again", async () => {
    const actor = await fixture();
    const { id } = await newChat(deps(), actor, null);
    await sql`insert into mia_usage_daily (organization_id, day, input_tokens) values (${actor.organizationId}, ${new Date().toISOString().slice(0, 10)}, 6000000)`;
    await expect(askMia(deps(), actor, id, { clientId: "x", text: "Hi" }, silent)).rejects.toMatchObject({ details: { code: "mia_daily_limit", retryAfterSeconds: expect.any(Number) } });
  });

  it("passes the model only the read tools, and the lead a chat started from", async () => {
    const actor = await fixture();
    const lead = await person(actor, "Pia Page");
    let request: AgentChatRequest | null = null;
    const watching: AgentModel = { ...fakeAgentModel, chat: async (r) => ((request = r), fakeAgentModel.chat(r)) };
    const { id } = await newChat(deps(), actor, lead);
    await ask(actor, id, "Does this lead fit?", deps(watching));
    const sent = request as unknown as AgentChatRequest;
    expect(sent.tools.map((t) => t.name)).toEqual(["search_leads", "read_lead", "read_company", "read_conversation", "read_fit", "list_brain_items", "read_brain_item"]);
    expect(sent.system.map((s) => s.text).join("\n")).toContain(lead);
    // Tool results arrive fenced, and leave out the phone and imported columns.
    const read = await sent.tools.find((t) => t.name === "read_lead")!.execute({ id: lead } as never);
    expect(read).toMatch(/^<untrusted_tool_result_[0-9a-f]+>/);
    expect(read).not.toContain("phone");
    expect(read).not.toContain("raw");
  });

  it("deletes what a chat said about a lead with the lead, and keeps the turns before it", async () => {
    const actor = await fixture();
    const kim = await person(actor, "Kim Walrus");
    const { id } = await newChat(deps(), actor, null);
    await ask(actor, id, "Is anyone called Nobody here?");
    await ask(actor, id, "Who is Walrus?");
    await ask(actor, id, "Thanks, and the weather?");
    expect(await sql`select 1 from mia_messages where thread_id = ${id}`).toHaveLength(6);

    const outcome = await deleteLeads(leadDeleteDeps, actor, { ids: [kim] });
    expect(outcome.deleted).toBe(1);
    const view = await openChat(deps(), actor, id);
    // The first turn read nobody, so it stays; the turn that found Kim and everything after it go.
    expect(view.messages).toHaveLength(2);
    expect(view.messages[0].parts).toEqual([{ type: "text", text: "Is anyone called Nobody here?" }]);
    expect(view.thread).toMatchObject({ title: null, purgedAt: expect.any(Date) });
    expect(JSON.stringify(view.messages)).not.toContain("Walrus");
    expect(await sql`select 1 from mia_thread_people where person_id = ${kim}`).toHaveLength(0);
  });

  it("deletes a chat started from a contact's page with the contact", async () => {
    const actor = { ...(await fixture()), role: "owner" as const };
    const contact = await person(actor, "Cara Contact", "contact");
    const { id } = await newChat(deps(), actor, contact);
    await ask(actor, id, "Who is Contact?");
    await deleteContact(contactDeleteDeps, actor, contact, { expected: { deals: 0, notes: 0, tasks: 0, events: 0, threads: 0, messages: 0, sends: 0 } });
    expect(await sql`select 1 from mia_messages where thread_id = ${id}`).toHaveLength(0);
    expect((await sql`select person_id, purged_at from mia_threads where id = ${id}`)[0]).toMatchObject({ person_id: null, purged_at: expect.any(Date) });
  });

  it("does not link or read a person deleted before the read", async () => {
    const actor = await fixture();
    const gone = await person(actor, "Gus Gone");
    const { id } = await newChat(deps(), actor, null);
    let read = "";
    const reader: AgentModel = {
      ...fakeAgentModel,
      chat: async (r) => {
        await sql`delete from people where id = ${gone}`;
        read = await r.tools.find((t) => t.name === "read_lead")!.execute({ id: gone } as never).catch((e: Error) => e.message);
        return { text: "Done.", stop: "end", usage: { inputTokens: 1, outputTokens: 1 }, steps: 1 };
      },
    };
    await ask(actor, id, "Read Gus", deps(reader));
    expect(read).toContain("Not found");
    expect(await sql`select 1 from mia_thread_people where thread_id = ${id}`).toHaveLength(0);
  });

  it("takes a member's chats with them when they leave", async () => {
    const actor = await fixture();
    const leaving = await colleague(actor);
    await newChat(deps(), leaving, null);
    const owner = { ...actor, role: "owner" as const };
    await db.transaction(async (tx) => releaseMiaOfMemberTx(tx, owner.organizationId, leaving.userId));
    expect(await sql`select 1 from mia_threads where user_id = ${leaving.userId}`).toHaveLength(0);
  });

  it("prunes old messages, then a chat with none left", async () => {
    const actor = await fixture();
    const { id } = await newChat(deps(), actor, null);
    await ask(actor, id, "Any leads?");
    await sql`update mia_messages set created_at = now() - interval '100 days' where thread_id = ${id}`;
    await sql`update mia_threads set last_message_at = now() - interval '100 days' where id = ${id}`;
    await pruneHistory({ now: new Date(), retention: DEFAULT_RETENTION, deadline: Date.now() + 30_000 });
    expect(await sql`select 1 from mia_threads where id = ${id}`).toHaveLength(0);
  });
});
