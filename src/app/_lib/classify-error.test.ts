import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyError } from "./classify-error";
import { ConflictError, ForbiddenError, NotFoundError, PayloadTooLargeError, ValidationError } from "@/shared/errors";

describe("classifyError", () => {
  it("maps each application error to its status, sentence and details", () => {
    expect(classifyError(new NotFoundError("Draft not found"))).toEqual({ status: 404, message: "Draft not found", details: {} });
    expect(classifyError(new ForbiddenError("Admins only."))).toEqual({ status: 403, message: "Admins only.", details: {} });
    expect(classifyError(new ConflictError("Changed.", { code: "stale_version", version: 3 }))).toEqual({ status: 409, message: "Changed.", details: { code: "stale_version", version: 3 } });
    expect(classifyError(new ConflictError("Changed."))).toEqual({ status: 409, message: "Changed.", details: {} });
    expect(classifyError(new PayloadTooLargeError("Too big."))).toEqual({ status: 413, message: "Too big.", details: {} });
    expect(classifyError(new ValidationError("Fix the steps.", [{ step: 1, message: "empty" }]))).toEqual({ status: 422, message: "Fix the steps.", details: { issues: [{ step: 1, message: "empty" }] } });
  });

  it("answers 400 for bad input and bad JSON", () => {
    const zod = z.object({ name: z.string() }).safeParse({});
    expect(classifyError(zod.error)).toEqual({ status: 400, message: "Invalid input", details: { issues: [{ message: expect.stringMatching(/^name: /) }] } });
    expect(classifyError(new SyntaxError("Unexpected token"))).toEqual({ status: 400, message: "Invalid JSON", details: {} });
  });

  it("answers 404 for an id Postgres cannot read as a UUID, directly or as the cause", () => {
    expect(classifyError(Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" }))?.status).toBe(404);
    expect(classifyError(Object.assign(new Error("query failed"), { cause: { code: "22P02" } }))).toEqual({ status: 404, message: "Not found", details: {} });
  });

  it("leaves anything else unclassified, so no caller shows its message", () => {
    expect(classifyError(new Error('relation "secret_table" does not exist'))).toBeNull();
    expect(classifyError("a string")).toBeNull();
    expect(classifyError(null)).toBeNull();
  });
});
