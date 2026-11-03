/** The real suppression store, wired to conversations' contact stop as src/composition wires it. Imported late, after `useTestEnv`. */
export async function suppressionStore() {
  const [{ createSuppressionStore }, { contactStop }] = await Promise.all([
    import("@/contexts/outreach/infrastructure/suppression-store"),
    import("@/contexts/conversations/stopping/infrastructure/stop-contact"),
  ]);
  return createSuppressionStore(contactStop);
}

/** Conversations' contact stop, for tests that build outreach's inbound store. */
export async function contactStop() {
  return (await import("@/contexts/conversations/stopping/infrastructure/stop-contact")).contactStop;
}
