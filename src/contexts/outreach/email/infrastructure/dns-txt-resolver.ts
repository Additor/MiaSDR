import { Resolver } from "node:dns/promises";
import type { ResolveTxt } from "../application/sender-dns";

/** A slow name server ends in `ETIMEOUT`, which reads as "could not check", so the page does not wait long for it. */
export const resolveTxtRecords: ResolveTxt = (host) => new Resolver({ timeout: 2000, tries: 1 }).resolveTxt(host);
