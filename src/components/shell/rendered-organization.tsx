"use client";

import { useState } from "react";
import { setRenderedOrganization } from "@/app/_lib/api-client";

/**
 * Tells `callApi` which organization this page was rendered for. It sets the value while rendering, ahead of any effect
 * below it that calls the API. A switch reloads the page, so one value holds for the life of the page.
 */
export function RenderedOrganization({ id }: { id: string }) {
  useState(() => setRenderedOrganization(id));
  return null;
}
