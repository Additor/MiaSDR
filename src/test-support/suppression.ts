/** The real suppression store, wired to conversations' follow-up stop as src/composition wires it. Imported late, after `useTestEnv`. */
export async function suppressionStore() {
  const [{ createSuppressionStore }, { followUpStop }] = await Promise.all([
    import("@/contexts/outreach/infrastructure/suppression-store"),
    import("@/contexts/conversations/after-reply/infrastructure/sequence-stop"),
  ]);
  return createSuppressionStore(followUpStop);
}

/** Conversations' follow-up stop, for tests that build outreach's inbound store. */
export async function followUpStop() {
  return (await import("@/contexts/conversations/after-reply/infrastructure/sequence-stop")).followUpStop;
}
