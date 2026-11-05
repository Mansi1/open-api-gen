import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/intermediate-format/config.ts";
import { filterSpec } from "../src/intermediate-format/filter.ts";
import { normalize } from "../src/intermediate-format/normalize.ts";
import { applyOverlay } from "../src/intermediate-format/overlay.ts";
import { resolve } from "../src/intermediate-format/refs.ts";
import { stripRefSiblings } from "../src/intermediate-format/validate-spec.ts";

const response = { responses: { "200": { description: "ok" } } };
const info = { title: "Regressions", version: "1" };

const removeOverlay = (target: string) => ({ overlay: "1.0.0", info, actions: [{ target, remove: true }] });

function methodNames(document: Record<string, unknown>, version: "3.0" | "3.1" = "3.1"): string[] {
  return normalize(document, version, "spec.yaml").services.flatMap((service) => service.operations.map((operation) => operation.name));
}

describe("overlay remove", () => {
  test("removes exactly the matched elements of nested arrays", () => {
    const document = { list: [{ del: true }, [{ del: true }], [{ keep: true }]] };
    expect(applyOverlay(document, removeOverlay("$..[?@.del]"), "overlay").document).toEqual({ list: [[], [{ keep: true }]] });
  });

  test("removes a match whose ancestor is removed in the same action", () => {
    const document = { a: { del: true, b: { c: { del: true } } }, z: 1 };
    expect(applyOverlay(document, removeOverlay("$..[?@.del]"), "overlay").document).toEqual({ z: 1 });
  });
});

describe("Path Items with $ref", () => {
  const document = (openapi: string) => ({
    openapi,
    info,
    paths: { "/a": { get: { ...response, operationId: "getA", tags: ["a"] } }, "/b": { $ref: "#/paths/~1a", post: { ...response, operationId: "postB", tags: ["b"] } } },
  });

  test("3.0: fields next to a Path Item $ref are kept, not stripped as Reference siblings", () => {
    const { document: stripped, warnings } = stripRefSiblings(document("3.0.3"), "3.0");
    expect((stripped.paths as Record<string, Record<string, unknown>>)["/b"]!.post).toBeDefined();
    expect(warnings).toEqual([]);
  });

  test("normalize merges a referenced Path Item with its own operations", () => {
    expect(methodNames(document("3.1.0")).sort()).toEqual(["getA", "getA2", "postB"]);
  });

  test("the tag filter reaches operations of a referenced Path Item", () => {
    const referenced = { openapi: "3.1.0", info, paths: { "/p": { $ref: "#/components/pathItems/P" } }, components: { pathItems: { P: { get: { ...response, tags: ["a"] }, post: { ...response, tags: ["b"] } } } } };
    const { document: filtered, warnings } = filterSpec(referenced, "3.1", { tags: ["a"] });
    expect(Object.keys((filtered.paths as Record<string, object>)["/p"]!)).toEqual(["get"]);
    expect(warnings).toEqual([]);
  });
});

test("method names made unique never collide with a later operation's own name", () => {
  const paths = { "/1": { get: { ...response, operationId: "get-pet" } }, "/2": { get: { ...response, operationId: "getPet" } }, "/3": { get: { ...response, operationId: "getPet2" } } };
  const names = methodNames({ openapi: "3.1.0", info, paths });
  expect(new Set(names).size).toBe(3);
});

describe("config", () => {
  test("a prototype key is an unknown config key, not a crash", async () => {
    await expect(loadConfig(undefined, { input: "a", output: "b", constructor: true } as never)).rejects.toThrow('unknown config key "constructor"');
  });

  test("filter flags merge with the config file's filter", async () => {
    const configPath = join(import.meta.dir, "..", "tmp", "review-regressions.config.json");
    await Bun.write(configPath, JSON.stringify({ input: "spec.yaml", output: "out", filter: { excludeTags: ["internal"] } }));
    const config = await loadConfig(configPath, { filter: { tags: ["pets"] } });
    expect(config.filter).toEqual({ excludeTags: ["internal"], tags: ["pets"] });
  });
});

test("a $ref with malformed percent-encoding names the ref", () => {
  expect(() => resolve({}, "#/components/schemas/100%")).toThrow('cannot resolve $ref "#/components/schemas/100%"');
});

describe("runtime", () => {
  test("a discriminator tag naming an inherited property is rejected, not dispatched", async () => {
    const validation = await import("../src/emit/runtime/validation.ts");
    const transform = await import("../src/emit/runtime/transform.ts");
    const member = validation.object({ type: { required: true, validator: validation.literal("cat") } });
    const validator = validation.oneOf([member], { property: "type", mapping: { cat: member } });
    for (const tag of ["constructor", "toString", "__proto__"]) {
      expect(validation.validate(validator, { type: tag })).toEqual([{ path: "/type", message: 'must be one of "cat"' }]);
    }
    const union = transform.union([{ validator: member, transformer: transform.identity }], { property: "type", mapping: { cat: transform.identity } });
    expect(union.decode({ type: "toString" }, "")).toEqual({ type: "toString" });
  });

  test("a __proto__ key from the wire stays a plain key and never becomes the prototype", async () => {
    const transform = await import("../src/emit/runtime/transform.ts");
    const decoded = transform.object({}).decode(JSON.parse('{"__proto__":{"polluted":1}}'), "") as Record<string, unknown>;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(decoded.polluted).toBeUndefined();
    expect(Object.keys(decoded)).toEqual(["__proto__"]);
  });

  test("impossible calendar dates are rejected by validation and decoding", async () => {
    const validation = await import("../src/emit/runtime/validation.ts");
    const transform = await import("../src/emit/runtime/transform.ts");
    expect(validation.validate(validation.string({ format: "date" }), "2024-02-30")).toHaveLength(1);
    expect(validation.validate(validation.string({ format: "date-time" }), "2024-02-30T10:00:00Z")).toHaveLength(1);
    expect(validation.validate(validation.string({ format: "date" }), "2024-02-29")).toEqual([]);
    expect(() => transform.date.decode("2024-02-30", "/day")).toThrow("is not a valid date");
    expect(() => transform.dateTime.decode("2024-02-30T10:00:00Z", "/at")).toThrow("is not a valid date-time");
  });

  test("label and matrix path parameters serialize objects; deepObject keeps Dates out of the object branch", async () => {
    const { createFetchSend } = await import("../src/emit/runtime/fetch-send.ts");
    const urls: string[] = [];
    const fetchStub = (async (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response("null", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const send = createFetchSend({ baseUrl: "https://api.test", fetch: fetchStub });
    const color = { R: 100, G: 200 };
    const styles = [
      { style: "label", explode: false },
      { style: "label", explode: true },
      { style: "matrix", explode: false },
      { style: "matrix", explode: true },
    ] as const;
    for (const style of styles) {
      await send({ method: "GET", url: "/c/{color}", urlParameter: { color }, operationId: "c", responseContentTypes: ["application/json"], parameterStyles: { path: { color: style } }, stream: false, lossless: false });
    }
    const since = new Date("2024-01-02T03:04:05.000Z");
    await send({ method: "GET", url: "/q", queryParameter: { since }, operationId: "q", responseContentTypes: ["application/json"], parameterStyles: { query: { since: { style: "deepObject", explode: true } } }, stream: false, lossless: false });
    expect(urls).toEqual([
      "https://api.test/c/.R,100,G,200",
      "https://api.test/c/.R=100.G=200",
      "https://api.test/c/;color=R,100,G,200",
      "https://api.test/c/;R=100;G=200",
      "https://api.test/q?since=2024-01-02T03%3A04%3A05.000Z",
    ]);
  });
});

test("an enum's Values constant clashing with another schema stops generation with both names", () => {
  const components = { schemas: { Status: { type: "string", enum: ["a"] }, StatusValues: { type: "object", properties: { x: { type: "string" } } } } };
  expect(() => methodNames({ openapi: "3.1.0", info, paths: {}, components })).toThrow("both export StatusValues");
});

test("a schema named like a tag's service class stops generation", () => {
  const document = { openapi: "3.1.0", info, paths: { "/p": { get: { ...response, tags: ["pet"] } } }, components: { schemas: { PetService: { type: "string" } } } };
  expect(() => methodNames(document)).toThrow("both export PetService");
});
