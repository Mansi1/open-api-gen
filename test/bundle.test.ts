import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emit } from "../src/emit/index.ts";
import { bundle } from "../src/intermediate-format/bundle.ts";
import { buildIntermediateFormat } from "../src/intermediate-format/build.ts";
import { loadConfig } from "../src/intermediate-format/config.ts";
import { load } from "../src/intermediate-format/load.ts";
import { typeCheck } from "./support/type-check.ts";

const fixture = join(import.meta.dir, "fixtures", "multi-file", "openapi.yaml");
const scratchDirectory = join(import.meta.dir, "..", "tmp", "bundle");

/** Writes files (path → YAML text) below tmp/bundle/<name>/ and returns that directory. */
function writeTree(name: string, files: Record<string, string>): string {
  const directory = join(scratchDirectory, name);
  rmSync(directory, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return directory;
}

async function bundleFile(path: string, refRoot?: string): Promise<Record<string, any>> {
  return bundle((await load(path)).document, path, refRoot);
}

function externalReferences(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((item) => externalReferences(item, found));
  } else if (typeof node === "object" && node !== null) {
    const object = node as Record<string, unknown>;
    if (typeof object.$ref === "string" && !object.$ref.startsWith("#") && object.$ref !== "this is example data, not a reference") {
      found.push(object.$ref);
    }
    Object.values(object).forEach((value) => externalReferences(value, found));
  }
  return found;
}

describe("bundle", () => {
  test("hoists referenced schemas, parameters and responses once, inlines path items and component definitions", async () => {
    const bundled = await bundleFile(fixture);
    expect(externalReferences(bundled)).toEqual([]);
    expect(Object.keys(bundled.components.schemas)).toEqual(["Error", "ErrorCode", "pet", "new-pet", "Tag", "owner"]);
    expect(Object.keys(bundled.components.parameters)).toEqual(["petId"]);
    expect(Object.keys(bundled.components.responses)).toEqual(["NotFound"]);
    expect(Object.keys(bundled.paths["/pets"])).toEqual(["get", "post"]);
    // pet.yaml is referenced three times, from two files, and becomes one component.
    expect(bundled.paths["/pets"].get.responses["200"].content["application/json"].schema.items).toEqual({ $ref: "#/components/schemas/pet" });
    expect(bundled.paths["/pets/{petId}"].get.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/pet" });
    // The cycle pet → owner → pet ends at the already placed component.
    expect(bundled.components.schemas.owner.properties.pets.items).toEqual({ $ref: "#/components/schemas/pet" });
    // `#/…` inside an external file means that file; a reference back into the root document becomes local.
    expect(bundled.components.schemas["new-pet"].properties.tag).toEqual({ $ref: "#/components/schemas/Tag" });
    expect(bundled.components.schemas.Error.properties.code).toEqual({ $ref: "#/components/schemas/ErrorCode" });
    expect(bundled.components.schemas.pet.example).toEqual({ $ref: "this is example data, not a reference" });
  });

  test("a single-file document comes back unchanged", async () => {
    const loaded = await load(join(import.meta.dir, "fixtures", "petstore-3.1.yaml"));
    expect(await bundle(loaded.document, "petstore-3.1.yaml")).toBe(loaded.document);
  });

  test("the multi-file document validates, generates and compiles like a single-file one", async () => {
    const intermediateFormat = await buildIntermediateFormat(await loadConfig(undefined, { input: fixture, output: "out" }));
    const names = intermediateFormat.declarations.map((declaration) => declaration.name);
    expect(names).toEqual(expect.arrayContaining(["Error", "ErrorCode", "Pet", "NewPet", "Tag", "Owner"]));
    expect(intermediateFormat.services[0]!.operations.map((operation) => operation.operationId)).toEqual(["listPets", "createPet", "getPet"]);
    expect(typeCheck(emit(intermediateFormat), "bundle-multi-file")).toEqual([]);
  });

  test("files outside the reference root are refused unless the root is widened", async () => {
    const directory = writeTree("outside-root", {
      "api/openapi.yaml": "openapi: 3.1.1\ninfo: { title: t, version: '1' }\npaths: {}\ncomponents:\n  schemas:\n    Shared:\n      $ref: ../shared/shared.yaml\n",
      "shared/shared.yaml": "type: string\n",
    });
    const root = join(directory, "api", "openapi.yaml");
    await expect(bundleFile(root)).rejects.toThrow('$ref "../shared/shared.yaml" points outside the reference root');
    const bundled = await bundleFile(root, directory);
    expect(bundled.components.schemas.Shared).toEqual({ type: "string" });

    // A symbolic link inside the root that leads outside it is refused too.
    symlinkSync(join(directory, "shared"), join(directory, "api", "linked"));
    writeFileSync(root, "openapi: 3.1.1\ninfo: { title: t, version: '1' }\npaths: {}\ncomponents:\n  schemas:\n    Shared:\n      $ref: ./linked/shared.yaml\n");
    await expect(bundleFile(root)).rejects.toThrow('$ref "./linked/shared.yaml" points outside the reference root');
  });

  test("discriminator mappings that point at files are bundled like references", async () => {
    const directory = writeTree("discriminator", {
      "openapi.yaml": [
        "openapi: 3.1.1",
        "info: { title: t, version: '1' }",
        "paths: {}",
        "components:",
        "  schemas:",
        "    Pet:",
        "      oneOf: [{ $ref: '#/components/schemas/Cat' }]",
        "      discriminator: { propertyName: kind, mapping: { cat: ./cat.yaml } }",
        "    Cat: { type: object }",
        "",
      ].join("\n"),
      "cat.yaml": "type: object\nproperties:\n  kind: { const: cat }\n",
    });
    const bundled = await bundleFile(join(directory, "openapi.yaml"));
    expect(bundled.components.schemas.Pet.discriminator.mapping).toEqual({ cat: "#/components/schemas/cat" });
    expect(bundled.components.schemas.cat.properties.kind).toEqual({ const: "cat" });
  });

  test("URLs are refused, a missing target names its file, colliding names get a suffix", async () => {
    const directory = writeTree("errors", {
      "remote.yaml": "openapi: 3.1.1\ninfo: { title: t, version: '1' }\npaths: {}\ncomponents:\n  schemas:\n    Remote:\n      $ref: https://example.com/schema.yaml\n",
      "missing.yaml": "openapi: 3.1.1\ninfo: { title: t, version: '1' }\npaths: {}\ncomponents:\n  schemas:\n    Missing:\n      $ref: ./parts.yaml#/Nope\n",
      "parts.yaml": "Item: { type: string }\n",
      "collide.yaml": [
        "openapi: 3.1.1",
        "info: { title: t, version: '1' }",
        "paths: {}",
        "components:",
        "  schemas:",
        "    Both:",
        "      type: object",
        "      properties:",
        "        first: { $ref: ./a/pet.yaml }",
        "        second: { $ref: ./b/pet.yaml }",
        "",
      ].join("\n"),
      "a/pet.yaml": "type: string\n",
      "b/pet.yaml": "type: integer\n",
    });
    await expect(bundleFile(join(directory, "remote.yaml"))).rejects.toThrow("URLs are not fetched");
    await expect(bundleFile(join(directory, "missing.yaml"))).rejects.toThrow(`no "Nope" in ${join(directory, "parts.yaml")}`);
    const collided = await bundleFile(join(directory, "collide.yaml"));
    expect(collided.components.schemas.Both.properties).toEqual({ first: { $ref: "#/components/schemas/pet" }, second: { $ref: "#/components/schemas/pet2" } });
    expect(collided.components.schemas.pet2).toEqual({ type: "integer" });
  });
});
