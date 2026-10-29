import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HEADER, type Files } from "../src/emit/layout.ts";
import { loadConfig } from "../src/intermediate-format/config.ts";
import { writeOutput } from "../src/write.ts";

const directory = join(import.meta.dir, "..", "tmp", "write-test");
const outside = join(import.meta.dir, "..", "tmp", "write-test-outside");
const document = { openapi: "3.1.2", info: { title: "Written", version: "1" }, paths: {} };

async function metadata(force = false) {
  const warnings = [{ pointer: "/components/schemas/Pet", message: "example warning" }];
  const intermediateFormat = { intermediateFormatVersion: 1, declarations: [], services: [] };
  return { generatorVersion: "0.1.0", config: await loadConfig(undefined, { input: "spec.yaml", output: directory, force }), document, warnings, intermediateFormat };
}

const generated = (paths: string[]): Files => new Map(paths.map((path) => [path, `${HEADER}export type Example = string;\n`]));

beforeEach(() => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(outside, { recursive: true });
});

describe("writeOutput", () => {
  test("writes the files, version.json (dist3 fields) and both spec copies", async () => {
    const result = writeOutput(directory, generated(["interface/components/A.ts", "service/a/AService.ts"]), await metadata());
    expect(result).toEqual({ written: 6, removed: 0 });
    expect(JSON.parse(readFileSync(join(directory, "intermediate-format.json"), "utf8"))).toEqual({ intermediateFormatVersion: 1, declarations: [], services: [] });
    const version = JSON.parse(readFileSync(join(directory, "version.json"), "utf8"));
    expect(version).toMatchObject({ generator: "open-api-gen", version: "0.1.0", path: "spec.yaml", config: { input: "spec.yaml" } });
    expect(version.warnings).toEqual([{ pointer: "/components/schemas/Pet", message: "example warning" }]);
    expect(Number.isNaN(Date.parse(version.creation))).toBe(false);
    expect(JSON.parse(readFileSync(join(directory, "open-api.json"), "utf8"))).toEqual(document);
    expect(readFileSync(join(directory, "open-api.yaml"), "utf8")).toContain("title: Written");
  });

  test("a second run removes stale generated files and their empty folders", async () => {
    writeOutput(directory, generated(["interface/components/A.ts", "service/old/OldService.ts"]), await metadata());
    const result = writeOutput(directory, generated(["interface/components/A.ts"]), await metadata());
    expect(result.removed).toBe(1);
    expect(existsSync(join(directory, "service"))).toBe(false);
    expect(existsSync(join(directory, "interface/components/A.ts"))).toBe(true);
  });

  test("refuses a directory with files it did not create, naming them", async () => {
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src/handwritten.ts"), "export const mine = 1;\n");
    writeFileSync(join(directory, "notes.md"), "# notes\n");
    await expect(async () => writeOutput(directory, generated(["index.ts"]), await metadata())).toThrow(/refusing to write into .*\n {2}notes\.md\n {2}src\/handwritten\.ts\nUse --force/);
    expect(existsSync(join(directory, "index.ts"))).toBe(false);
  });

  test("--force writes anyway and still never deletes hand-written files", async () => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "handwritten.ts"), "export const mine = 1;\n");
    writeOutput(directory, generated(["index.ts"]), await metadata(true));
    writeOutput(directory, generated(["other.ts"]), await metadata(true));
    expect(readFileSync(join(directory, "handwritten.ts"), "utf8")).toBe("export const mine = 1;\n");
    expect(existsSync(join(directory, "index.ts"))).toBe(false);
    expect(existsSync(join(directory, "other.ts"))).toBe(true);
  });

  // Regression: the runtime modules were copied without the generated-file header, so every second run into the
  // same directory refused to write (found by regenerating the GitHub client).
  test("generating twice into the same directory works with real generator output", async () => {
    const { generate } = await import("../src/index.ts");
    const config = await loadConfig(undefined, { input: "test/fixtures/petstore-3.0.yaml", output: directory });
    const first = await generate(config);
    const second = await generate(config);
    expect(second).toEqual({ ...first, removed: 0 });
    // The generator's own warnings land in version.json (petstore-3.0 has none; the overlay test below has one).
    expect(JSON.parse(readFileSync(join(directory, "version.json"), "utf8")).warnings).toEqual(second.warnings);
    // The intermediate format in the output is exactly what Stage 1 built.
    const { buildIntermediateFormat } = await import("../src/intermediate-format/build.ts");
    expect(JSON.parse(readFileSync(join(directory, "intermediate-format.json"), "utf8"))).toEqual(await buildIntermediateFormat(config));
    expect(readFileSync(join(directory, "runtime/validation.ts"), "utf8").startsWith(HEADER)).toBe(true);
  });

  test("an open-api.json not written by us counts as foreign", async () => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "open-api.json"), "{}\n");
    await expect(async () => writeOutput(directory, generated(["index.ts"]), await metadata())).toThrow("open-api.json");
  });

  test("a symbolic link to a file outside the directory stops the run, even with --force", async () => {
    writeFileSync(join(outside, "precious.ts"), "precious\n");
    mkdirSync(directory, { recursive: true });
    symlinkSync(join(outside, "precious.ts"), join(directory, "index.ts"));
    await expect(async () => writeOutput(directory, generated(["index.ts"]), await metadata(true))).toThrow("symbolic links: index.ts");
    expect(readFileSync(join(outside, "precious.ts"), "utf8")).toBe("precious\n");
  });

  test("a symbolic link to a folder outside the directory stops the run, even with --force", async () => {
    mkdirSync(directory, { recursive: true });
    symlinkSync(outside, join(directory, "service"));
    await expect(async () => writeOutput(directory, generated(["service/pet/PetService.ts"]), await metadata(true))).toThrow("symbolic links: service");
    expect(existsSync(join(outside, "pet"))).toBe(false);
  });

  test("an empty folder the user created survives a run", async () => {
    writeOutput(directory, generated(["index.ts"]), await metadata());
    mkdirSync(join(directory, "mine"));
    writeOutput(directory, generated(["index.ts"]), await metadata());
    expect(existsSync(join(directory, "mine"))).toBe(true);
  });
});
