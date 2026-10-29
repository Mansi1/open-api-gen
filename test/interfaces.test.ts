import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { emitInterfaces } from "../src/emit/interfaces.ts";
import { buildIntermediateFormat } from "../src/intermediate-format/build.ts";
import { loadConfig } from "../src/intermediate-format/config.ts";
import type { IntermediateFormat } from "../src/intermediate-format/types.ts";
import { typeCheck } from "./support/type-check.ts";

// Stage 2 tests start from golden intermediate format files, never from OpenAPI documents.
const goldenDirectory = join(import.meta.dir, "golden");
const readGoldenIntermediateFormat = (name: string): IntermediateFormat => JSON.parse(readFileSync(join(goldenDirectory, "intermediate-format", `${name}.json`), "utf8"));

type Shape = { kind: "interface"; properties: Record<string, string> } | { kind: "type"; text: string } | { kind: "const" };

/** The exported declarations of one file, with whitespace-insensitive type texts, for comparing dist3 and our output. */
function exportedShapes(source: string): Record<string, Shape> {
  const sourceFile = ts.createSourceFile("compare.ts", source, ts.ScriptTarget.Latest, true);
  const normalize = (text: string) => text.replace(/\s+/g, "");
  const shapes: Record<string, Shape> = {};
  // Our enums derive the type from an `as const` array (`typeof XValues[number]`); dist3 spells the union out.
  // Resolve the derived form to the same `'A'|'B'` text so both compare by their members.
  const constArrayMembers = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (initializer !== undefined && ts.isAsExpression(initializer) && ts.isArrayLiteralExpression(initializer.expression)) {
        const members = initializer.expression.elements.map((element) => normalize(element.getText(sourceFile)));
        constArrayMembers.set(declaration.name.getText(sourceFile), members.join("|"));
      }
    }
  }
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      const properties: Record<string, string> = {};
      for (const member of statement.members) {
        if (ts.isPropertySignature(member) && member.type !== undefined) {
          const optionalMark = member.questionToken !== undefined ? "?" : "";
          properties[member.name.getText(sourceFile)] = optionalMark + normalize(member.type.getText(sourceFile));
        }
      }
      shapes[statement.name.text] = { kind: "interface", properties };
    } else if (ts.isTypeAliasDeclaration(statement)) {
      const text = normalize(statement.type.getText(sourceFile));
      const derivedFrom = /^typeof(\w+)\[number\]$/.exec(text)?.[1];
      const resolved = derivedFrom === undefined ? undefined : constArrayMembers.get(derivedFrom);
      shapes[statement.name.text] = { kind: "type", text: resolved ?? text };
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        shapes[declaration.name.getText(sourceFile)] = { kind: "const" };
      }
    }
  }
  return shapes;
}

describe("dist3 parity (interfaces)", () => {
  // Deliberate deviations, each with its reason. dist3 types date-time values as Date, but JSON delivers a
  // string; our wire interfaces say string and interface/app/ says Date.
  const DATE_TIME_DEVIATION = { dist3: "Date", ours: "string" };

  test("SpaceTraders: same files, same exported names, same property types", () => {
    const files = emitInterfaces(readGoldenIntermediateFormat("SpaceTraders"));
    const dist3Directory = join(goldenDirectory, "dist3", "interface");
    const differences: string[] = [];
    const dateTimeDeviations: string[] = [];
    for (const kind of ["components", "request", "response", "parameter"]) {
      for (const fileName of readdirSync(join(dist3Directory, kind))) {
        const path = `interface/${kind}/${fileName}`;
        const ours = files.get(path);
        if (ours === undefined) {
          differences.push(`${path}: missing`);
          continue;
        }
        const expectedShapes = exportedShapes(readFileSync(join(dist3Directory, kind, fileName), "utf8"));
        const actualShapes = exportedShapes(ours);
        for (const [name, expected] of Object.entries(expectedShapes)) {
          const actual = actualShapes[name];
          if (actual === undefined || actual.kind !== expected.kind) {
            differences.push(`${path}: ${name} is ${actual?.kind ?? "missing"}, dist3 has ${expected.kind}`);
            continue;
          }
          if (expected.kind === "interface" && actual.kind === "interface") {
            for (const [property, expectedType] of Object.entries(expected.properties)) {
              const actualType = actual.properties[property];
              const isDateTimeDeviation = expectedType.replace("?", "") === DATE_TIME_DEVIATION.dist3 && actualType?.replace("?", "") === DATE_TIME_DEVIATION.ours;
              if (isDateTimeDeviation) {
                dateTimeDeviations.push(`${name}.${property}`);
              } else if (actualType !== expectedType) {
                differences.push(`${path}: ${name}.${property} is ${actualType ?? "missing"}, dist3 has ${expectedType}`);
              }
            }
            for (const property of Object.keys(actual.properties)) {
              if (!(property in expected.properties)) {
                differences.push(`${path}: ${name}.${property} is extra`);
              }
            }
          }
          if (expected.kind === "type" && actual.kind === "type" && actual.text !== expected.text) {
            differences.push(`${path}: type ${name} = ${actual.text}, dist3 has ${expected.text}`);
          }
        }
      }
    }
    expect(differences).toEqual([]);
    // dist3 has exactly 10 date-time properties (VERIFIED by grep of `open-api format: date-time`).
    expect(dateTimeDeviations).toHaveLength(10);
  });

  test("app types replace date-time with Date for transformed declarations", () => {
    const files = emitInterfaces(readGoldenIntermediateFormat("SpaceTraders"));
    const contract = exportedShapes(files.get("interface/app/Contract.ts")!);
    expect(contract.Contract).toMatchObject({ kind: "interface", properties: { expiration: "Date" } });
  });
});

describe("generated interfaces type-check under strict", () => {
  const goldenIrs = ["petstore-3.0", "petstore-3.1", "features-3.1", "features-3.2", "SpaceTraders", "petstore-api", "unified-api", "unified-api-next"];
  for (const name of goldenIrs) {
    test(`${name}`, () => {
      expect(typeCheck(emitInterfaces(readGoldenIntermediateFormat(name)), `interfaces-${name}`)).toEqual([]);
    });
  }

  // No golden intermediate format for the large specs; build it here (Stage 1 is tested separately).
  for (const example of ["open-api-jira.json", "open-api-milkscout.json", "openapi-elastic.json"]) {
    test(`${example}`, async () => {
      const intermediateFormat = await buildIntermediateFormat(await loadConfig(undefined, { input: `examples/${example}`, output: "out" }));
      expect(typeCheck(emitInterfaces(intermediateFormat), `interfaces-${example}`)).toEqual([]);
    }, 60_000);
  }
});
