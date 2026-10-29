import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { docComment, identifier, literal, propertyKey, quote } from "../src/emit/names.ts";

// Parses source and returns the kinds of its top-level statements: injected code shows up as extra statements.
function statementKinds(source: string): string[] {
  const sourceFile = ts.createSourceFile("example.ts", source, ts.ScriptTarget.Latest, true);
  return sourceFile.statements.map((statement) => {
    // SyntaxKind's reverse mapping names VariableStatement by its alias FirstStatement.
    if (ts.isVariableStatement(statement)) {
      return "VariableStatement";
    }
    return ts.SyntaxKind[statement.kind]!;
  });
}

describe("escaping", () => {
  const hostileInputs = ["a*/ ; process.exit()", "it's", "back\\slash", "line\nbreak", "separator\u2028here", "'; alert(1); '", "</script>", "${variable}", "`"];

  test.each(hostileInputs)("quote(%p) round-trips as one string literal", (input) => {
    expect(statementKinds(`export const value = ${quote(input)};`)).toEqual(["VariableStatement"]);
    expect(new Function(`return ${quote(input)}`)()).toBe(input);
  });

  test.each(hostileInputs)("docComment(%p) stays one comment", (input) => {
    const source = `${docComment([input, `description ${input}`])}export type Example = string;`;
    expect(statementKinds(source)).toEqual(["TypeAliasDeclaration"]);
  });

  test.each(hostileInputs)("propertyKey(%p) is one member", (input) => {
    const source = `export interface Example { ${propertyKey(input)}: string }`;
    expect(statementKinds(source)).toEqual(["InterfaceDeclaration"]);
    const declaration = ts.createSourceFile("example.ts", source, ts.ScriptTarget.Latest).statements[0] as ts.InterfaceDeclaration;
    expect(declaration.members).toHaveLength(1);
  });

  test("plain identifiers stay bare", () => {
    expect(propertyKey("shipSymbol")).toBe("shipSymbol");
    expect(propertyKey("x-rate-limit")).toBe("'x-rate-limit'");
    expect(literal(null)).toBe("null");
    expect(literal(3)).toBe("3");
  });

  // Regression: hook module paths from the config were pasted into `from '...'` unescaped (found in review).
  test("hook import paths from the config cannot inject code", async () => {
    const { buildIntermediateFormat } = await import("../src/intermediate-format/build.ts");
    const { loadConfig } = await import("../src/intermediate-format/config.ts");
    const { emit } = await import("../src/emit/index.ts");
    const hostileImport = "./x'; throw new Error('injected'); //";
    const config = await loadConfig(undefined, { input: "test/fixtures/petstore-3.0.yaml", output: "unused", transformers: { "format:int64": { type: "Decimal", import: hostileImport, decode: "toDecimal", encode: "fromDecimal" } } });
    const files = emit(await buildIntermediateFormat(config));
    for (const path of ["interface/components/Pet.codec.ts", "interface/app/Pet.ts"]) {
      const source = ts.createSourceFile(path, files.get(path)!, ts.ScriptTarget.Latest, true);
      const thrown = source.statements.filter((statement) => ts.isThrowStatement(statement));
      expect({ path, thrown: thrown.length }).toEqual({ path, thrown: 0 });
    }
  });

  test("identifier rejects names that are not identifiers", () => {
    expect(identifier("Pet")).toBe("Pet");
    expect(() => identifier("a b")).toThrow("intermediate format contract");
    expect(() => identifier("delete")).toThrow("intermediate format contract");
  });
});
