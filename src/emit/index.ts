// Stage 2 entry: intermediate format → Files. It never sees the OpenAPI document or config (ARCH.md, "Why two
// stages"); test/boundaries.test.ts enforces that src/emit imports only types from Stage 1.
// VERIFIED: test/boundaries.test.ts fails on any non-type import from src/intermediate-format.
import type { IntermediateFormat } from "../intermediate-format/types.ts";
import { emitClient } from "./client.ts";
import { emitCodecs } from "./codecs.ts";
import { declarationPath, emitInterfaces } from "./interfaces.ts";
import { quote } from "./names.ts";
import { HEADER, importPath, type Files } from "./layout.ts";
import { RUNTIME_SOURCES } from "./runtime-sources.ts";
import { emitServices, servicePath } from "./services.ts";
import { emitValidators } from "./validators.ts";
import { emitWebhooks } from "./webhooks.ts";

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
    ...emitClient(intermediateFormat),
    ...emitWebhooks(intermediateFormat),
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
  // Explicit exports win over `export *`, so a schema named like a runtime export stays reachable only through its own file.
  lines.push(
    "export { createClient, isApiError, securitySchemes, servers, type ApiAuth, type ApiClient, type ApiErrors } from './client.js';",
    "export { serverUrl, type ClientOptions, type Server, type ServerVariable } from './runtime/client.js';",
    "export { createFetchSend, ApiError, type AuthCredentials, type BasicCredentials, type Credential, type FetchSendOptions, type Middleware, type SecurityScheme } from './runtime/fetch-send.js';",
    "export { RequestValidationError, ResponseValidationError, type RequestOptions, type RetryOptions, type Send, type SendRequest, type ServiceConfig } from './runtime/service.js';",
    "export { TransformError } from './runtime/transform.js';",
    "export type { Issue } from './runtime/validation.js';",
  );
  if (intermediateFormat.incoming.length > 0) {
    lines.push(
      "export { parseWebhook, type WebhookPayloads } from './webhooks.js';",
      "export { WebhookValidationError, type ParseWebhookOptions } from './runtime/webhooks.js';",
    );
  }
  return `${HEADER}${lines.join("\n")}\n`;
}
