import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerSchema, validate } from "@hyperjump/json-schema/draft-07";
import { buildIntermediateFormat } from "../src/intermediate-format/build.ts";
import { loadConfig } from "../src/intermediate-format/config.ts";
import type { IntermediateFormat } from "../src/intermediate-format/types.ts";

// The intermediate format is the contract between the stages: every Stage 1 output must match src/intermediate-format/intermediate-format.schema.json,
// survive a JSON round trip (pure data), and equal its golden file. Regenerate goldens with UPDATE_GOLDEN=1.
const repositoryRoot = join(import.meta.dir, "..");
const goldenDirectory = join(import.meta.dir, "golden", "intermediate-format");
const SCHEMA_URI = "https://open-api-gen.local/intermediate-format.schema.json";
registerSchema(JSON.parse(readFileSync(join(repositoryRoot, "src/intermediate-format/intermediate-format.schema.json"), "utf8")), SCHEMA_URI);

const fullGoldens = [
  "test/fixtures/petstore-3.0.yaml",
  "test/fixtures/petstore-3.1.yaml",
  "test/fixtures/features-3.1.json",
  "test/fixtures/features-3.2.yaml",
  "examples/SpaceTraders.json",
  "examples/petstore-api.yaml",
  "examples/unified-api.yaml",
  "examples/unified-api-next.yaml",
];
// Too large to check in whole (3.6 MiB for Jira); their golden is a summary.
const summaryGoldens = ["examples/open-api-jira.json", "examples/open-api-milkscout.json", "examples/openapi-elastic.json"];

async function build(input: string): Promise<IntermediateFormat> {
  return buildIntermediateFormat(await loadConfig(undefined, { input, output: "out" }));
}

function summarize(intermediateFormat: IntermediateFormat) {
  const kinds = ["components", "request", "response", "parameter"];
  return {
    declarations: intermediateFormat.declarations.length,
    byKind: Object.fromEntries(kinds.map((kind) => [kind, intermediateFormat.declarations.filter((declaration) => declaration.kind === kind).length])),
    services: intermediateFormat.services.map((service) => `${service.name}:${service.operations.length}`),
    transformed: intermediateFormat.declarations.filter((declaration) => declaration.transformed).length,
    runtime: intermediateFormat.declarations.filter((declaration) => declaration.runtime).length,
    warnings: intermediateFormat.warnings,
  };
}

function expectGolden(input: string, value: unknown): void {
  const fileName = input.split("/").pop()!.replace(/\.(json|yaml)$/, ".json");
  const goldenPath = join(goldenDirectory, fileName);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(goldenDirectory, { recursive: true });
    writeFileSync(goldenPath, text);
  }
  if (!existsSync(goldenPath)) {
    throw new Error(`missing golden ${goldenPath}; run UPDATE_GOLDEN=1 bun test test/intermediate-format.test.ts`);
  }
  expect(text).toBe(readFileSync(goldenPath, "utf8"));
}

describe("buildIntermediateFormat", () => {
  for (const input of [...fullGoldens, ...summaryGoldens]) {
    test(`${input}: valid IntermediateFormat, pure data, matches golden`, async () => {
      const intermediateFormat = await build(input);
      const output = await validate(SCHEMA_URI, intermediateFormat as never, "BASIC");
      const schemaErrors = output.valid ? [] : (output.errors ?? []).slice(0, 5).map((error) => `${error.instanceLocation} ${error.keyword}`);
      expect(schemaErrors).toEqual([]);
      expect(JSON.parse(JSON.stringify(intermediateFormat))).toEqual(intermediateFormat);
      expectGolden(input, summaryGoldens.includes(input) ? summarize(intermediateFormat) : intermediateFormat);
    }, 30_000);
  }

  test("the schema rejects a malformed IntermediateFormat", async () => {
    const intermediateFormat = await build("test/fixtures/petstore-3.1.yaml");
    (intermediateFormat.declarations[0]!.type as { kind: string }).kind = "struct";
    expect((await validate(SCHEMA_URI, intermediateFormat as never)).valid).toBe(false);
  });

  test("validateSpec: false skips validation, invalid documents fail by default", async () => {
    await expect(build("test/fixtures/invalid-3.1.yaml")).rejects.toThrow("invalid OpenAPI document");
    const intermediateFormat = await buildIntermediateFormat(await loadConfig(undefined, { input: "test/fixtures/invalid-3.1.yaml", output: "out", validateSpec: false }));
    expect(intermediateFormat.services[0]?.operations[0]?.responses[0]?.type).toEqual({ kind: "unknown" });
  });

  test("$ref sibling warnings come first", async () => {
    const intermediateFormat = await build("examples/petstore-api.yaml");
    expect(intermediateFormat.warnings[0]).toEqual({ pointer: "/components/schemas/Pet/properties/tags/items", message: 'ignored "xml" next to $ref (not allowed in OpenAPI 3.0)' });
  });
});
