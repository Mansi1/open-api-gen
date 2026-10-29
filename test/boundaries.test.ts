import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

// Stage 2 (src/emit) may read Stage 1 only through the intermediate format types, so it can never re-derive Stage 1 decisions.
const sourceDirectory = join(import.meta.dir, "..", "src");

function typescriptFiles(directory: string): string[] {
  const entries = readdirSync(directory, { recursive: true, encoding: "utf8" });
  return entries.filter((entry) => entry.endsWith(".ts")).map((entry) => join(directory, entry));
}

function importedModules(file: string): string[] {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const modules: string[] = [];
  for (const statement of sourceFile.statements) {
    const isImportOrExport = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement);
    if (isImportOrExport && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
      modules.push(statement.moduleSpecifier.text);
    }
  }
  return modules;
}

/** Relative imports of every file in `fromDirectory`, as paths relative to src/. */
function relativeImports(fromDirectory: string): { file: string; target: string }[] {
  const found: { file: string; target: string }[] = [];
  for (const file of typescriptFiles(join(sourceDirectory, fromDirectory))) {
    for (const moduleSpecifier of importedModules(file)) {
      if (moduleSpecifier.startsWith(".")) {
        found.push({ file: relative(sourceDirectory, file), target: relative(sourceDirectory, resolve(file, "..", moduleSpecifier)) });
      }
    }
  }
  return found;
}

test("src/emit imports nothing from src/intermediate-format except src/intermediate-format/types.ts", () => {
  const violations = relativeImports("emit").filter((entry) => entry.target.startsWith("intermediate-format/") && entry.target !== "intermediate-format/types.ts");
  expect(violations).toEqual([]);
});

test("src/intermediate-format imports nothing from src/emit", () => {
  const violations = relativeImports("intermediate-format").filter((entry) => entry.target.startsWith("emit/"));
  expect(violations).toEqual([]);
});
