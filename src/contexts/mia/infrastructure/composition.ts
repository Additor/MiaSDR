import { aiFakeMode, agentModels } from "@/contexts/ai/infrastructure/composition";
import { brainStore } from "@/contexts/brain/infrastructure/composition";
import { kickJob } from "@/platform/jobs/kick";
import type { Job } from "@/platform/jobs/types";
import { env } from "@/shared/env";
import type { AgentModelResolver } from "@/contexts/ai/application/agent-ports";
import type { MiaBrainPort } from "../application/mia-ports";
import type { MiaDeps } from "../application/mia-use-cases";
import { createMiaRunJob, MIA_KICK_LANE, MIA_RUN_JOB, type MiaWorkerDeps } from "../application/mia-worker";
import { drizzleMiaRunStore, drizzleMiaSettingsStore, drizzleMiaSuggestionStore } from "./drizzle-mia-store";
import { fakeAgentModel, fakePageReader } from "./fake-mia";
import { createPageReader } from "./page-reader";

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
};

export const miaDeps = (): MiaDeps => ({
  runs: drizzleMiaRunStore,
  suggestions: drizzleMiaSuggestionStore,
  settings: drizzleMiaSettingsStore,
  brain: brainPort,
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
  settings: drizzleMiaSettingsStore,
  now: () => new Date(),
  kick: kickMia,
  installEnabled,
  ...overrides,
});

/** Registered once in the kernel registry, last, so mail goes first. With nothing queued a tick costs one empty claim query. */
export function miaJobs(): Job[] {
  return [createMiaRunJob(miaWorkerDeps())];
}
