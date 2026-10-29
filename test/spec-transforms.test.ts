import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildIntermediateFormat, prepareDocument } from "../src/intermediate-format/build.ts";
import { loadConfig, type ConfigInput } from "../src/intermediate-format/config.ts";
import { filterSpec } from "../src/intermediate-format/filter.ts";
import { load } from "../src/intermediate-format/load.ts";
import { applyOverlay } from "../src/intermediate-format/overlay.ts";
import { validateSpec } from "../src/intermediate-format/validate-spec.ts";

const repositoryRoot = join(import.meta.dir, "..");
const loadFile = (path: string) => load(join(repositoryRoot, path));
const overlayOf = (actions: unknown[], extra: Record<string, unknown> = {}) => ({ overlay: "1.2.0", info: { title: "test", version: "1" }, actions, ...extra });

describe("applyOverlay (Overlay 1.0 to 1.2)", () => {
  const base = () => ({
    openapi: "3.1.2",
    info: { title: "Base", version: "1" },
    tags: [{ name: "pets" }],
    paths: {
      "/pets": { get: { tags: ["pets", "dummy"], parameters: [{ name: "dummy", in: "query" }, { name: "keep", in: "query" }], responses: {} } },
      "/toys": { get: { responses: {} } },
    },
    components: { schemas: { Source: { type: "string", description: "copied" }, Target: { type: "object" } } },
  });

  test("structured update merges recursively: primitives replace, arrays concatenate, objects merge", () => {
    const { document } = applyOverlay(base(), overlayOf([{ target: "$", update: { info: { title: "New", "x-extra": true }, tags: [{ name: "toys" }] } }]), "overlay");
    expect(document.info).toEqual({ title: "New", version: "1", "x-extra": true });
    expect(document.tags).toEqual([{ name: "pets" }, { name: "toys" }]);
  });

  test("wildcard targets update every match", () => {
    const { document } = applyOverlay(base(), overlayOf([{ target: "$.paths.*.get", update: { description: "Lists things" } }]), "overlay");
    const paths = document.paths as Record<string, { get: { description?: string } }>;
    expect(paths["/pets"]!.get.description).toBe("Lists things");
    expect(paths["/toys"]!.get.description).toBe("Lists things");
  });

  test("arrays: update appends, remove deletes by filter, also for primitives", () => {
    const { document } = applyOverlay(
      base(),
      overlayOf([
        { target: "$.paths.*.get.parameters", update: { name: "newParam", in: "query" } },
        { target: "$.paths.*.get.parameters[?@.name == 'dummy']", remove: true },
        { target: "$.paths.*.get.tags[?@ == 'dummy']", remove: true },
      ]),
      "overlay",
    );
    const get = (document.paths as Record<string, { get: { parameters: { name: string }[]; tags: string[] } }>)["/pets"]!.get;
    expect(get.parameters.map((parameter) => parameter.name)).toEqual(["keep", "newParam"]);
    expect(get.tags).toEqual(["pets"]);
  });

  test("copy (1.1) merges one selected node into the targets", () => {
    const { document } = applyOverlay(base(), overlayOf([{ target: "$.components.schemas.Target", copy: "$.components.schemas.Source" }]), "overlay");
    expect((document.components as { schemas: Record<string, unknown> }).schemas.Target).toEqual({ type: "string", description: "copied" });
  });

  test("reusable actions (1.2): the reference supplies the target and overrides fields", () => {
    const overlay = overlayOf([{ $ref: "#/components/actions/describe", target: "$.paths['/toys'].get" }], {
      components: { actions: { describe: { fields: { update: { summary: "from component" } } } } },
    });
    const { document } = applyOverlay(base(), overlay, "overlay");
    expect((document.paths as Record<string, { get: { summary?: string } }>)["/toys"]!.get.summary).toBe("from component");
  });

  test("a target that selects nothing changes nothing and warns", () => {
    const original = base();
    const result = applyOverlay(original, overlayOf([{ target: "$.paths['/nope']", update: { summary: "x" } }]), "my-overlay.yaml");
    expect(result.document).toEqual(original);
    expect(result.warnings).toEqual([{ pointer: "/actions/0", message: 'my-overlay.yaml: target "$.paths[\'/nope\']" selects nothing' }]);
  });

  test("does not mutate its input", () => {
    const original = base();
    const before = JSON.stringify(original);
    applyOverlay(original, overlayOf([{ target: "$.info", update: { title: "Changed" } }]), "overlay");
    expect(JSON.stringify(original)).toBe(before);
  });

  test.each<[string, unknown, string]>([
    ["unsupported version", { overlay: "2.0.0", info: {}, actions: [{ target: "$" }] }, 'unsupported overlay version "2.0.0"'],
    ["no actions", { overlay: "1.0.0", info: {}, actions: [] }, '"actions" must be a non-empty array'],
    ["incompatible merge", overlayOf([{ target: "$.info", update: { title: { nested: true } } }]), 'cannot merge object into primitive at "title"'],
    ["mixed node kinds", overlayOf([{ target: "$.paths['/pets'].get.*", update: { x: 1 } }]), "mix of"],
    ["invalid JSONPath", overlayOf([{ target: "$.paths[", update: {} }]), "invalid JSONPath"],
    ["copy selecting two nodes", overlayOf([{ target: "$.info", copy: "$.paths.*" }]), "must select exactly one node, selected 2"],
    ["missing reusable action", overlayOf([{ $ref: "#/components/actions/nope", target: "$" }]), 'no reusable action "nope"'],
  ])("%s is an error", (_case, overlay, message) => {
    expect(() => applyOverlay(base(), overlay as Record<string, unknown>, "overlay")).toThrow(message);
  });
});

describe("filterSpec", () => {
  test("keeps tagged operations, drops empty paths and prunes unused components; the result stays valid", async () => {
    const { document, version } = await loadFile("examples/petstore-api.yaml");
    const result = filterSpec(document, version, { tags: ["store"] });
    const paths = Object.keys(result.document.paths as Record<string, unknown>);
    expect(paths.every((path) => path.startsWith("/store"))).toBe(true);
    const schemas = Object.keys((result.document.components as { schemas: Record<string, unknown> }).schemas);
    expect(schemas).toContain("Order");
    expect(schemas).not.toContain("Pet");
    expect(schemas).not.toContain("User");
    await validateSpec(result.document, version);
  });

  test("excludeTags and operationIds combine", async () => {
    const { document, version } = await loadFile("test/fixtures/petstore-3.0.yaml");
    const onlyGetPet = filterSpec(document, version, { operationIds: ["getPet"] });
    expect(Object.keys(onlyGetPet.document.paths as Record<string, unknown>)).toEqual(["/pets/{petId}"]);
    expect(Object.keys((onlyGetPet.document.paths as Record<string, Record<string, unknown>>)["/pets/{petId}"]!)).toEqual(["parameters", "get"]);
    const nothing = filterSpec(document, version, { excludeTags: ["pets"] });
    expect(nothing.document.paths).toEqual({});
    expect(nothing.warnings.map((warning) => warning.message)).toContain("filter: no operation is left; the client will have no services");
  });

  test("schemas reached only through discriminator mappings or recursion are kept", async () => {
    const { document, version } = await loadFile("test/fixtures/features-3.1.json");
    const result = filterSpec(document, version, { tags: ["shapes"] });
    const schemas = Object.keys((result.document.components as { schemas: Record<string, unknown> }).schemas).sort();
    expect(schemas).toEqual(["Circle", "Shape", "Square"]);
    const trees = filterSpec(document, version, { operationIds: [] });
    expect(trees.document.paths).toEqual({});
    await validateSpec(result.document, version);
  });

  test("unknown tags and operationIds warn; an empty filter returns the same document", async () => {
    const { document, version } = await loadFile("test/fixtures/petstore-3.1.yaml");
    const result = filterSpec(document, version, { tags: ["nope"], operationIds: ["missing"] });
    expect(result.warnings.map((warning) => warning.message)).toEqual([
      'filter: no operation has the tag "nope"',
      'filter: no operation has the operationId "missing"',
      "filter: no operation is left; the client will have no services",
    ]);
    expect(filterSpec(document, version, {}).document).toBe(document);
  });

  test("3.2 additionalOperations and query operations are filtered too", async () => {
    const { document, version } = await loadFile("test/fixtures/features-3.2.yaml");
    const result = filterSpec(document, version, { operationIds: ["purgeItem", "searchItems"] });
    expect(Object.keys(result.document.paths as Record<string, unknown>).sort()).toEqual(["/items/{id}", "/search"]);
    await validateSpec(result.document, version);
  });
});

describe("pipeline: overlay → validate → filter", () => {
  const build = async (flags: ConfigInput) => buildIntermediateFormat(await loadConfig(undefined, { input: "test/fixtures/petstore-3.0.yaml", output: "out", ...flags }));

  test("overlays apply before generation", async () => {
    const intermediateFormat = await build({ overlay: "test/fixtures/overlays/petstore-rename.yaml" });
    expect(intermediateFormat.source.title).toBe("Petstore (overlaid)");
    const operationNames = intermediateFormat.services.flatMap((service) => service.operations.map((operation) => operation.name));
    expect(operationNames).not.toContain("deletePet");
  });

  test("the overlaid document is what gets validated", async () => {
    await expect(build({ overlay: "test/fixtures/overlays/break-schema.yaml" })).rejects.toThrow("/components/schemas/Error/type");
  });

  test("filters shape the services and declarations", async () => {
    const intermediateFormat = await build({ filter: { operationIds: ["getPet"] } });
    expect(intermediateFormat.services.map((service) => service.operations.map((operation) => operation.name))).toEqual([["getPet"]]);
    expect(intermediateFormat.declarations.map((declaration) => declaration.name).sort()).toEqual(["GetPetPathParameter", "NewPet", "Pet", "PetStatus"]);
  });

  test("prepareDocument returns the transformed document for the spec copy in the output", async () => {
    const prepared = await prepareDocument(await loadConfig(undefined, { input: "test/fixtures/petstore-3.0.yaml", output: "out", overlay: "test/fixtures/overlays/petstore-rename.yaml" }));
    expect((prepared.document.info as { title: string }).title).toBe("Petstore (overlaid)");
  });
});
