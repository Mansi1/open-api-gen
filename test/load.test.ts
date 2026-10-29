import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/intermediate-format/config.ts";
import { load } from "../src/intermediate-format/load.ts";

const fixturePath = (name: string) => join(import.meta.dir, "fixtures", name);
const scratchPath = (name: string) => join(import.meta.dir, "..", "tmp", name);

describe("load", () => {
  test.each([
    ["petstore-3.0.yaml", "3.0"],
    ["petstore-3.1.yaml", "3.1"],
    ["features-3.1.json", "3.1"],
    ["features-3.2.yaml", "3.2"],
  ])("%s → version %s", async (name, expectedVersion) => {
    const { document, version } = await load(fixturePath(name));
    expect(version).toBe(expectedVersion as "3.0" | "3.1" | "3.2");
    expect((document as { info: { title: string } }).info.title).toBeString();
  });

  test("rejects Swagger 2.0 with a clear message", async () => {
    await expect(load(fixturePath("swagger-2.0.json"))).rejects.toThrow("OpenAPI 2.0 (Swagger) is not supported");
  });

  test("rejects documents without a 3.x version", async () => {
    const path = scratchPath("no-version.json");
    await Bun.write(path, JSON.stringify({ openapi: "4.0.0", info: {}, paths: {} }));
    await expect(load(path)).rejects.toThrow('unsupported OpenAPI version "4.0.0"');
  });

  test("reports parse errors with the file name", async () => {
    const path = scratchPath("broken.json");
    await Bun.write(path, "{ not json");
    await expect(load(path)).rejects.toThrow("broken.json");
  });
});

describe("loadConfig", () => {
  test("applies defaults", async () => {
    const config = await loadConfig(undefined, { input: "a.yaml", output: "out" });
    expect(config).toEqual({
      input: "a.yaml",
      output: "out",
      validateSpec: true,
      overlay: [],
      filter: {},
      naming: { properties: "preserve" },
      formats: { "date-time": "Date", date: "Date", int64: "bigint" },
      transformers: {},
      force: false,
    });
  });

  test("flags override the config file, paths resolve against the file", async () => {
    const configPath = scratchPath("config/open-api-gen.config.json");
    await Bun.write(configPath, JSON.stringify({ input: "spec.yaml", output: "generated", naming: { properties: "camelCase" }, formats: { int64: "number" } }));
    const config = await loadConfig(configPath, { output: "elsewhere" });
    expect(config.input).toBe(scratchPath("config/spec.yaml"));
    expect(config.output).toBe("elsewhere");
    expect(config.naming.properties).toBe("camelCase");
    expect(config.formats).toEqual({ "date-time": "Date", date: "Date", int64: "number" });
  });

  test("unknown keys are errors naming the key", async () => {
    await expect(loadConfig(undefined, { input: "a", output: "b", namming: {} } as never)).rejects.toThrow('unknown config key "namming"');
    await expect(loadConfig(undefined, { input: "a", output: "b", formats: { uuid: "string" } } as never)).rejects.toThrow('unknown config key "formats.uuid"');
  });

  test("invalid values are errors", async () => {
    await expect(loadConfig(undefined, { input: "a", output: "b", naming: { properties: "kebab" } } as never)).rejects.toThrow("naming.properties");
    await expect(loadConfig(undefined, { output: "b" })).rejects.toThrow('"input" is required');
    const badTransformer = { uuid: { type: "Uuid", import: "./uuid", decode: "decodeUuid", encode: "encodeUuid" } };
    await expect(loadConfig(undefined, { input: "a", output: "b", transformers: badTransformer })).rejects.toThrow('transformer key "uuid" must start with "format:" or "schema:"');
  });
});
