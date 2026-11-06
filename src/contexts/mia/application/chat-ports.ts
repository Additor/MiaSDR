import type { AiUsage } from "@/contexts/ai/domain/generation";
import type { BrainKind } from "@/contexts/brain/domain/brain-kinds";
import type { FitCriterion, FitVerdict } from "@/contexts/people/domain/lead-fit";
import type { ChatPart, MiaMessageRole, MiaMessageStatus } from "../domain/mia-chat";

export interface ThreadRow {
  id: string;
  title: string | null;
  /** The lead the chat started from, while that person exists. */
  personId: string | null;
  /** Set when a deleted person took part of the chat with them. */
  purgedAt: Date | null;
  lastMessageAt: Date;
  createdAt: Date;
}

export interface MessageRow {
  id: string;
  turnId: string;
  role: MiaMessageRole;
  status: MiaMessageStatus;
  parts: ChatPart[];
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A turn this process answers. Every write checks the answer row first, so a stopped or deleted answer takes no more. */
export interface ClaimedTurn {
  organizationId: string;
  userId: string;
  threadId: string;
  turnId: string;
  turnToken: string;
  answerId: string;
  /** The lead the chat started from. */
  personId: string | null;
  /** Earlier messages as text, oldest first, then this turn's question. */
  history: Array<{ role: MiaMessageRole; content: string }>;
}

export type TurnStart =
  | { kind: "started"; turn: ClaimedTurn }
  /** This question was sent already. */
  | { kind: "duplicate"; answerId: string }
  /** Another answer is going in this chat. */
  | { kind: "busy" }
  | { kind: "gone" };

export interface TurnEnd {
  status: Extract<MiaMessageStatus, "complete" | "stopped" | "failed">;
  parts: ChatPart[];
  usage: AiUsage;
  provider: string | null;
  model: string | null;
  error: string | null;
  now: Date;
}

/** One person's chats. Every read and write takes the user, so another member's chat answers as missing. */
export interface MiaChatStore {
  /** A new chat. With a person, the chat starts linked to them, so deleting them deletes the chat. Null when that person is gone. */
  createThread(organizationId: string, userId: string, personId: string | null): Promise<{ id: string } | null>;
  listThreads(organizationId: string, userId: string, limit: number): Promise<ThreadRow[]>;
  thread(organizationId: string, userId: string, id: string): Promise<ThreadRow | null>;
  messages(organizationId: string, threadId: string): Promise<MessageRow[]>;
  rename(organizationId: string, userId: string, id: string, title: string): Promise<boolean>;
  remove(organizationId: string, userId: string, id: string): Promise<boolean>;
  /** Questions this person asked in the last hour, across their chats. */
  questionsSince(organizationId: string, userId: string, since: Date): Promise<number>;
  /** Stores the question and an empty answer and takes the chat's turn, in one transaction. */
  startTurn(organizationId: string, userId: string, threadId: string, question: { clientId: string; text: string; now: Date }): Promise<TurnStart>;
  /** A new answer to the chat's last question, in place of the one that failed or stopped. */
  retryTurn(organizationId: string, userId: string, threadId: string, now: Date): Promise<TurnStart | { kind: "nothing" }>;
  /** False when the answer was stopped or deleted, so the turn stops. */
  saveAnswer(turn: ClaimedTurn, parts: ChatPart[]): Promise<boolean>;
  /** Ends the answer and frees the chat's turn. The tokens count against the day even when the answer is gone. */
  endTurn(turn: ClaimedTurn, end: TurnEnd): Promise<boolean>;
  /** Marks the chat's going answer stopped. Its id, or null when none is going. */
  stop(organizationId: string, userId: string, threadId: string): Promise<string | null>;
  /**
   * Records that this turn read these people, before their data reaches the model. Returns the ones that exist: a person
   * deleted meanwhile is not linked and not read.
   */
  linkPeople(turn: ClaimedTurn, personIds: readonly string[]): Promise<Set<string>>;
}

export interface ChatPersonRow {
  id: string;
  name: string | null;
  title: string | null;
  company: string | null;
  lifecycle: "lead" | "contact";
}

export interface ChatPerson extends ChatPersonRow {
  email: string | null;
  linkedinUrl: string | null;
  companyId: string | null;
  companyDomain: string | null;
  /** Custom fields, as a person filled them. */
  custom: Record<string, unknown>;
  createdAt: Date;
}

export interface ChatCompany {
  id: string;
  name: string | null;
  domain: string;
  custom: Record<string, unknown>;
  people: ChatPersonRow[];
}

export interface ChatConversation {
  /** Inbox threads, newest first, for links. */
  threadIds: string[];
  messages: Array<{ direction: "inbound" | "outbound"; channel: string; sentAt: Date; subject: string | null; text: string }>;
}

export interface ChatFit {
  verdict: FitVerdict;
  criteria: FitCriterion[];
  missing: string[];
  assessedAt: Date;
}

/**
 * What a chat may read, and nothing else. No method returns a phone number or imported raw columns, and none writes.
 * Each person method answers for the organization only.
 */
export interface MiaChatReads {
  searchPeople(organizationId: string, query: string, limit: number): Promise<ChatPersonRow[]>;
  person(organizationId: string, id: string): Promise<ChatPerson | null>;
  company(organizationId: string, id: string): Promise<ChatCompany | null>;
  /** The latest messages with this person. Machine mail stays out. */
  conversation(organizationId: string, personId: string, limit: number): Promise<ChatConversation>;
  fit(organizationId: string, personId: string): Promise<ChatFit | null>;
  /** Active items, by title. */
  brainItems(organizationId: string, kind: BrainKind | null, limit: number): Promise<Array<{ id: string; kind: BrainKind; title: string }>>;
  brainItem(organizationId: string, id: string): Promise<{ id: string; kind: BrainKind; title: string; text: string } | null>;
}
