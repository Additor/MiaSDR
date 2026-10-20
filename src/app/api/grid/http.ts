import { NotFoundError, PayloadTooLargeError, ValidationError } from "@/shared/errors";

/*
 * Request helpers shared by the grid routes. This is not a route file, so Next does not serve it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** A path segment that must be an id. Anything else cannot exist, so it answers 404. */
export function idParam(value: string, what = "Not found"): string {
  if (!isUuid(value)) throw new NotFoundError(what);
  return value;
}

/** An id in a body or query string. A malformed one is the caller's mistake, so it answers 422. */
export function idField(value: unknown, label: string): string {
  if (!isUuid(value)) throw new ValidationError(`${label} is not a valid id`);
  return value;
}

export function nullableIdField(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return idField(value, label);
}

/**
 * Reads the body with a byte cap. The Content-Length header is a hint only: a client can lie or
 * stream chunked, so the cap is enforced on the bytes as they arrive.
 */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError(`The request is larger than ${Math.round(maxBytes / 1024 / 1024 * 100) / 100} MB.`);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError(`The request is larger than ${Math.round(maxBytes / 1024 / 1024 * 100) / 100} MB.`);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** A JSON object body under the size cap. A body that is not JSON throws SyntaxError, which answers 400. */
export async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await readBodyLimited(request, maxBytes));
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ValidationError("The body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** Like readJsonObject, but an empty body counts as {}. For endpoints where every field is optional. */
export async function readOptionalJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const bytes = await readBodyLimited(request, maxBytes);
  if (bytes.byteLength === 0) return {};
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ValidationError("The body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** Multipart form under the size cap. The upload is held in memory only up to that cap. */
export async function readFormLimited(request: Request, maxBytes: number): Promise<FormData> {
  const bytes = await readBodyLimited(request, maxBytes);
  try {
    return await new Request(request.url, { method: "POST", headers: request.headers, body: bytes as BodyInit }).formData();
  } catch {
    throw new ValidationError("Expected a multipart form with a file");
  }
}

/** Integer query parameter. Absent gives the fallback. Present but not a whole number in range throws 422. */
export function intParam(raw: string | null, label: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}): number {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new ValidationError(`${label} must be a whole number`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ValidationError(`${label} must be between ${min} and ${max}`);
  return n;
}

export function stringList(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
  if (value.length > max) throw new ValidationError(`${label} cannot contain more than ${max.toLocaleString("en-US")} values`);
  if (value.some((v) => typeof v !== "string" || !v.trim())) throw new ValidationError(`${label} must contain only non-empty text`);
  return value as string[];
}

export function idList(value: unknown, label: string, max: number): string[] {
  const list = stringList(value, label, max);
  if (!list.every(isUuid)) throw new ValidationError(`${label} must contain valid ids`);
  return list;
}
