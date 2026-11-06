import { aiFakeMode, agentModels } from "@/contexts/ai/infrastructure/composition";
import { brainStore } from "@/contexts/brain/infrastructure/composition";
import { kickJob } from "@/platform/jobs/kick";
import type { Job } from "@/platform/jobs/types";
import { env } from "@/shared/env";
import type { AgentModelResolver } from "@/contexts/ai/application/agent-ports";
import type { MiaBrainPort } from "../application/mia-ports";
import type { MiaDeps } from "../application/mia-use-cases";
import { FIT_MAX_BRAIN_ITEMS } from "../domain/mia-run";
import { createMiaRunJob, MIA_KICK_LANE, MIA_RUN_JOB, type MiaWorkerDeps } from "../application/mia-worker";
import { drizzleMiaRunStore, drizzleMiaSettingsStore, drizzleMiaSuggestionStore } from "./drizzle-mia-store";
import { fakeAgentModel, fakePageReader } from "./fake-mia";
import { createFitAssessorResolver } from "./fit-assessor";
import { drizzleMiaLeadPort } from "./fit-inputs";
import { createPageReader } from "./page-reader";
import type { MiaChatDeps } from "../application/chat-use-cases";
import type { MiaChatReads } from "../application/chat-ports";
import { drizzleMiaChatReads } from "./chat-reads";
import { drizzleMiaChatStore } from "./drizzle-mia-chat-store";

const FIT_KINDS = ["icp", "qualification"] as const;

const fitModels = createFitAssessorResolver();

const kickMia = (): void => kickJob(MIA_RUN_JOB, MIA_KICK_LANE);

const installEnabled = (): boolean => env().MIA_ENABLED;

const models: AgentModelResolver = {
  forOrganization: (organizationId) => (aiFakeMode() ? Promise.resolve(fakeAgentModel) : agentModels.forOrganization(organizationId)),
  status: (organizationId) => agentModels.status(organizationId),
};

const brainPort: MiaBrainPort = {
  findTarget: (organizationId, kind, title) => brainStore.findActive(organizationId, kind, title),

  async legacyDocument(organizationId, id) {
    const item = await brainStore.get(organizationId, id);
    return item?.legacy && item.active ? { id: item.id, title: item.title, content: item.content } : null;
  },

  async currentFields(organizationId, id) {
    const item = await brainStore.get(organizationId, id);
    return item && { title: item.title, fields: item.structuredData, revision: item.revision };
  },

  async hasActiveIcp(organizationId) {
    const { rows } = await brainStore.list(organizationId, { kinds: ["icp"], legacyOnly: false, q: "", active: true, limit: 1, offset: 0 });
    return rows.length > 0;
  },

  async fitItems(organizationId) {
    const { rows } = await brainStore.list(organizationId, { kinds: FIT_KINDS, legacyOnly: false, q: "", active: true, limit: FIT_MAX_BRAIN_ITEMS, offset: 0 });
    const items = await Promise.all(rows.map((row) => brainStore.get(organizationId, row.id)));
    return items.flatMap((item) => (item && item.active && (item.kind === "icp" || item.kind === "qualification") ? [{ id: item.id, kind: item.kind, title: item.title, revision: item.revision, text: item.content }] : []));
  },
};

export const miaDeps = (): MiaDeps => ({
  runs: drizzleMiaRunStore,
  suggestions: drizzleMiaSuggestionStore,
  settings: drizzleMiaSettingsStore,
  brain: brainPort,
  leads: drizzleMiaLeadPort,
  aiStatus: (organizationId) => models.status(organizationId),
  installEnabled,
  now: () => new Date(),
  kick: kickMia,
});

export const miaWorkerDeps = (overrides: Partial<MiaWorkerDeps> = {}): MiaWorkerDeps => ({
  runs: drizzleMiaRunStore,
  models,
  pages: aiFakeMode() ? fakePageReader : createPageReader(),
  brain: brainPort,
  leads: drizzleMiaLeadPort,
  fitModels,
  settings: drizzleMiaSettingsStore,
  now: () => new Date(),
  kick: kickMia,
  installEnabled,
  ...overrides,
});

/** A chat reads Brain through Brain's store: active items only, and the text a person wrote in them. */
const chatReads: MiaChatReads = {
  ...drizzleMiaChatReads,
  async brainItems(organizationId, kind, limit) {
    const { rows } = await brainStore.list(organizationId, { kinds: kind ? [kind] : null, legacyOnly: false, q: "", active: true, limit, offset: 0 });
    return rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title }));
  },
  async brainItem(organizationId, id) {
    const item = await brainStore.get(organizationId, id);
    return item?.active ? { id: item.id, kind: item.kind, title: item.title, text: item.content } : null;
  },
};

export const miaChatDeps = (overrides: Partial<MiaChatDeps> = {}): MiaChatDeps => ({
  chats: drizzleMiaChatStore,
  reads: chatReads,
  models,
  settings: drizzleMiaSettingsStore,
  runs: drizzleMiaRunStore,
  aiStatus: (organizationId) => models.status(organizationId),
  installEnabled,
  now: () => new Date(),
  ...overrides,
});

/** Registered once in the kernel registry, last, so mail goes first. With nothing queued a tick costs one empty claim query. */
export function miaJobs(): Job[] {
  return [createMiaRunJob(miaWorkerDeps())];
}
