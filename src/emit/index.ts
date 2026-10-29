// Stage 2 entry: intermediate format → Files. It never sees the OpenAPI document or config (ARCH.md, "Why two
// stages"); test/boundaries.test.ts enforces that src/emit imports only types from Stage 1.
// VERIFIED: test/boundaries.test.ts fails on any non-type import from src/intermediate-format.
import type { IntermediateFormat } from "../intermediate-format/types.ts";
import { emitCodecs } from "./codecs.ts";
import { declarationPath, emitInterfaces } from "./interfaces.ts";
import { quote } from "./names.ts";
import { HEADER, importPath, type Files } from "./layout.ts";
import { RUNTIME_SOURCES } from "./runtime-sources.ts";
import { emitServices, servicePath } from "./services.ts";
import { emitValidators } from "./validators.ts";

export type { Files } from "./layout.ts";

/** Stage 2: intermediate format → every generated file, keyed by its path inside the output directory. */
export function emit(intermediateFormat: IntermediateFormat): Files {
  if (intermediateFormat.intermediateFormatVersion !== 1) {
    throw new Error(`unsupported intermediate format version ${String(intermediateFormat.intermediateFormatVersion)} (expected 1)`);
  }
  const files: Files = new Map([
    ...emitInterfaces(intermediateFormat),
    ...emitValidators(intermediateFormat),
    ...emitCodecs(intermediateFormat),
    ...emitServices(intermediateFormat),
    // The header marks the runtime copies as generated too, so the next run may replace them.
    ...Object.entries(RUNTIME_SOURCES).map(([runtimePath, source]): [string, string] => [runtimePath, `${HEADER}${source}`]),
  ]);
  files.set("index.ts", renderIndex(intermediateFormat));
  return files;
}

/** The package entry: services, wire types and the runtime API. App types stay in interface/app/ (same names). */
function renderIndex(intermediateFormat: IntermediateFormat): string {
  const lines: string[] = [];
  for (const service of intermediateFormat.services) {
    lines.push(`export * from ${quote(importPath("index.ts", servicePath(service)))};`);
  }
  for (const declaration of intermediateFormat.declarations) {
    lines.push(`export * from ${quote(importPath("index.ts", declarationPath(declaration, "wire")))};`);
  }
  lines.push(
    "export { createFetchSend, ApiError, type FetchSendOptions } from './runtime/fetch-send.js';",
    "export { ResponseValidationError, type Send, type SendRequest, type ServiceConfig } from './runtime/service.js';",
    "export { TransformError } from './runtime/transform.js';",
    "export type { Issue } from './runtime/validation.js';",
  );
  return `${HEADER}${lines.join("\n")}\n`;
}
