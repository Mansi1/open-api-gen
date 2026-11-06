import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit } from "../src/emit/index.ts";
import { generate } from "../src/index.ts";
import { buildIntermediateFormat } from "../src/intermediate-format/build.ts";
import { loadConfig, type ConfigInput, type OperationInfo } from "../src/intermediate-format/config.ts";
import { typeCheck } from "./support/type-check.ts";

const repositoryRoot = join(import.meta.dir, "..");
const petstore = join(repositoryRoot, "test", "fixtures", "petstore-3.0.yaml");
const scratchDirectory = join(repositoryRoot, "tmp", "service-for");

/** Writes one config file below tmp/service-for/ and returns its path. */
function writeConfigFile(name: string, content: string): string {
  mkdirSync(scratchDirectory, { recursive: true });
  const path = join(scratchDirectory, name);
  writeFileSync(path, content);
  return path;
}

/** Service name → method names, for a config built from flags. */
async function servicesOf(flags: ConfigInput): Promise<Record<string, string[]>> {
  const intermediateFormat = await buildIntermediateFormat(await loadConfig(undefined, { input: petstore, output: "out", ...flags }));
  const methodsByService: Record<string, string[]> = {};
  for (const service of intermediateFormat.services) {
    methodsByService[service.name] = service.operations.map((operation) => operation.name);
  }
  return methodsByService;
}

describe("serviceFor", () => {
  test("a TypeScript config file groups operations by its function; the client compiles", async () => {
    const configPath = writeConfigFile("by-path.config.ts", [
      `import { defineConfig } from ${JSON.stringify(join(repositoryRoot, "src", "index.ts"))};`,
      "",
      "export default defineConfig({",
      `  input: ${JSON.stringify(petstore)},`,
      '  output: "out",',
      '  serviceFor: (operation) => (operation.path.includes("{petId}") ? "single pet" : undefined),',
      "});",
      "",
    ].join("\n"));
    const config = await loadConfig(configPath, {});
    expect(config.output).toBe(join(scratchDirectory, "out"));
    const intermediateFormat = await buildIntermediateFormat(config);
    const summary = intermediateFormat.services.map((service) => ({ name: service.name, property: service.property, folder: service.folder, operations: service.operations.map((operation) => operation.operationId) }));
    expect(summary).toEqual([
      { name: "PetsService", property: "pets", folder: "pets", operations: ["listPets", "createPet"] },
      { name: "SinglePetService", property: "singlePet", folder: "single-pet", operations: ["getPet", "deletePet"] },
    ]);
    expect(typeCheck(emit(intermediateFormat), "service-for")).toEqual([]);
  });

  test("the function sees each operation; undefined keeps the first tag, an empty string means the default service", async () => {
    const seen: OperationInfo[] = [];
    const services = await servicesOf({
      serviceFor: (operation) => {
        seen.push(operation);
        if (operation.method === "DELETE") {
          return "";
        }
        return undefined;
      },
    });
    expect(services).toEqual({ PetsService: ["listPets", "createPet", "getPet"], DefaultService: ["deletePet"] });
    expect(seen[0]).toEqual({ operationId: "listPets", method: "GET", path: "/pets", tags: ["pets"], deprecated: false });
  });

  test("a group that matches a document tag keeps the tag's description", async () => {
    const intermediateFormat = await buildIntermediateFormat(await loadConfig(undefined, { input: petstore, output: "out", serviceFor: () => "pets" }));
    expect(intermediateFormat.services.map((service) => [service.name, service.description])).toEqual([["PetsService", "Everything about pets"]]);
  });

  test("a throwing function or a wrong return value names the operation", async () => {
    const failing = () => {
      throw new Error("no rule for this path");
    };
    await expect(servicesOf({ serviceFor: failing })).rejects.toThrow("serviceFor failed for operation listPets: no rule for this path");
    await expect(servicesOf({ serviceFor: (() => 42) as never })).rejects.toThrow("serviceFor must return a string or undefined, got number for operation listPets");
    await expect(servicesOf({ serviceFor: (operation) => (operation.method === "GET" ? "Pets" : "pets ") })).rejects.toThrow("both map to service PetsService");
  });

  test("JSON cannot hold a function; a module needs a default export; an .mjs file works", async () => {
    const jsonPath = writeConfigFile("string.config.json", JSON.stringify({ input: petstore, output: "out", serviceFor: "pets" }));
    await expect(loadConfig(jsonPath, {})).rejects.toThrow("config: serviceFor must be a function");
    const namedPath = writeConfigFile("named.config.mjs", "export const config = { input: 'a', output: 'b' };\n");
    await expect(loadConfig(namedPath, {})).rejects.toThrow("a JS or TS config file needs a default export");
    const javascriptPath = writeConfigFile("tagless.config.mjs", `export default { input: ${JSON.stringify(petstore)}, output: "out", serviceFor: () => "api" };\n`);
    const intermediateFormat = await buildIntermediateFormat(await loadConfig(javascriptPath, {}));
    expect(intermediateFormat.services.map((service) => service.name)).toEqual(["ApiService"]);
  });

  test("version.json records the function's source", async () => {
    const outputDirectory = join(scratchDirectory, "generated");
    rmSync(outputDirectory, { recursive: true, force: true });
    const config = await loadConfig(undefined, { input: petstore, output: outputDirectory, serviceFor: (operation) => operation.tags[0] });
    await generate(config);
    const versionFile = JSON.parse(readFileSync(join(outputDirectory, "version.json"), "utf8"));
    expect(versionFile.config.serviceFor).toBe("(operation) => operation.tags[0]");
  });
});
