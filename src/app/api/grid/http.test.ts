import { describe, expect, it } from "vitest";
import { NotFoundError, PayloadTooLargeError, ValidationError } from "@/shared/errors";
import { idList, idParam, intParam, readBodyLimited, readFormLimited, readJsonObject, readOptionalJsonObject } from "./http";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("http://localhost/api/grid", { method: "POST", body, headers });

describe("grid request helpers", () => {
  it("stops reading a body at the cap, whatever the headers claim", async () => {
    await expect(readBodyLimited(post("x".repeat(2000)), 1000)).rejects.toBeInstanceOf(PayloadTooLargeError);
    // A streamed body with no content-length.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i += 1) controller.enqueue(new Uint8Array(400));
        controller.close();
      },
    });
    const request = new Request("http://localhost/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readBodyLimited(request, 1000)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect((await readBodyLimited(post("ok"), 1000)).byteLength).toBe(2);
  });

  it("parses JSON objects and refuses everything else", async () => {
    expect(await readJsonObject(post('{"a":1}'), 100)).toEqual({ a: 1 });
    await expect(readJsonObject(post("[1]"), 100)).rejects.toBeInstanceOf(ValidationError);
    await expect(readJsonObject(post("null"), 100)).rejects.toBeInstanceOf(ValidationError);
    await expect(readJsonObject(post("{nope"), 100)).rejects.toBeInstanceOf(SyntaxError);
    await expect(readJsonObject(post(JSON.stringify({ a: "x".repeat(500) })), 100)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(await readOptionalJsonObject(post(null), 100)).toEqual({});
  });

  it("reads a multipart upload under the cap", async () => {
    const form = new FormData();
    form.set("file", new File(["a,b\n1,2"], "x.csv", { type: "text/csv" }));
    const request = new Request("http://localhost/x", { method: "POST", body: form });
    const read = await readFormLimited(request, 10_000);
    expect(read.get("file")).toBeInstanceOf(File);

    const big = new FormData();
    big.set("file", new File(["z".repeat(5000)], "big.csv"));
    const encoded = new Response(big);
    const bigRequest = new Request("http://localhost/x", { method: "POST", body: await encoded.arrayBuffer(), headers: { "content-type": encoded.headers.get("content-type") ?? "" } });
    await expect(readFormLimited(bigRequest, 1000)).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(readFormLimited(post("not a form", { "content-type": "text/plain" }), 1000)).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates ids and numbers", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(idParam(id)).toBe(id);
    expect(() => idParam("nope")).toThrow(NotFoundError);
    expect(() => idParam("1; drop table")).toThrow(NotFoundError);
    expect(idList([id], "ids", 5)).toEqual([id]);
    expect(() => idList([id, "x"], "ids", 5)).toThrow(ValidationError);
    expect(() => idList([id, id, id], "ids", 2)).toThrow(/more than 2/);
    expect(intParam(null, "n", 7)).toBe(7);
    expect(intParam("12", "n", 7, { max: 20 })).toBe(12);
    expect(() => intParam("-1", "n", 7)).toThrow(ValidationError);
    expect(() => intParam("1.5", "n", 7)).toThrow(ValidationError);
    expect(() => intParam("999", "n", 7, { max: 20 })).toThrow(ValidationError);
  });
});
