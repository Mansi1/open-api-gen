import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import type { Files } from "../../src/emit/layout.ts";

/** Compiler options a strict consumer would use; nodenext also proves the `.js` import specifiers resolve. */
export const STRICT_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: false,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  types: [],
  skipLibCheck: true,
};

/**
 * Writes generated files to tmp/typecheck/<name>/ (plus any extra files) and type-checks them.
 * Returns the diagnostics as `path:line: message` strings; an empty list means the output compiles.
 */
export function typeCheck(files: Files, name: string, extraFiles: Record<string, string> = {}): string[] {
  const directory = join(import.meta.dir, "..", "..", "tmp", "typecheck", name);
  rmSync(directory, { recursive: true, force: true });
  const rootNames: string[] = [];
  const allFiles = new Map([...files, ...Object.entries(extraFiles)]);
  for (const [path, content] of allFiles) {
    const fullPath = join(directory, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
    if (fullPath.endsWith(".ts")) {
      rootNames.push(fullPath);
    }
  }
  // A package.json with "type": "module" makes nodenext treat the files as ES modules.
  writeFileSync(join(directory, "package.json"), '{ "type": "module" }\n');

  const program = ts.createProgram({ rootNames, options: STRICT_OPTIONS });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return diagnostics.slice(0, 20).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      return message;
    }
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${diagnostic.file.fileName.slice(directory.length + 1)}:${line + 1}: ${message}`;
  });
}
