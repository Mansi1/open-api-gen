// Emits client.ts: the document's servers and createClient, which builds every service with one shared configuration.
// The logic lives in runtime/client.ts; this file only lists the servers and services of this API.
// VERIFIED: test/services.test.ts calls the generated createClient against a real Bun.serve server.
import type { IntermediateFormat, Server } from "../intermediate-format/types.ts";
import { HEADER, importPath, type Files } from "./layout.ts";
import { docComment, identifier, propertyKey, quote } from "./names.ts";
import { servicePath } from "./services.ts";

export const CLIENT_PATH = "client.ts";
const INDENT = "  ";

export function emitClient(intermediateFormat: IntermediateFormat): Files {
  return new Map([[CLIENT_PATH, renderClient(intermediateFormat)]]);
}

function renderServer(server: Server): string {
  const fields = [`url: ${quote(server.url)}`];
  if (server.description !== undefined) {
    fields.push(`description: ${quote(server.description)}`);
  }
  if (server.variables !== undefined) {
    const variables: string[] = [];
    for (const [variableName, variable] of Object.entries(server.variables)) {
      const variableFields = [`default: ${quote(variable.default)}`];
      if (variable.enum !== undefined) {
        variableFields.push(`enum: [${variable.enum.map((value) => quote(value)).join(", ")}]`);
      }
      if (variable.description !== undefined) {
        variableFields.push(`description: ${quote(variable.description)}`);
      }
      variables.push(`${propertyKey(variableName)}: { ${variableFields.join(", ")} }`);
    }
    fields.push(`variables: { ${variables.join(", ")} }`);
  }
  return `${INDENT}{ ${fields.join(", ")} },\n`;
}

function renderClient(intermediateFormat: IntermediateFormat): string {
  const imports = [
    `import { createServiceConfig, type ClientOptions, type Server } from ${quote(importPath(CLIENT_PATH, "runtime/client.ts"))};`,
    `import { isApiErrorOf } from ${quote(importPath(CLIENT_PATH, "runtime/fetch-send.ts"))};`,
  ];
  const errorTypes: string[] = [];
  const clientTypeMembers: string[] = [];
  const clientValueMembers: string[] = [];
  for (const service of intermediateFormat.services) {
    const className = identifier(service.name);
    imports.push(`import { ${className}, type ${className}Errors } from ${quote(importPath(CLIENT_PATH, servicePath(service)))};`);
    errorTypes.push(`${className}Errors`);
    if (service.description !== undefined) {
      clientTypeMembers.push(docComment([service.description], INDENT));
    }
    clientTypeMembers.push(`${INDENT}${propertyKey(service.property)}: ${className}<Transform>;\n`);
    clientValueMembers.push(`${INDENT}${INDENT}${propertyKey(service.property)}: new ${className}(config),\n`);
  }

  const servers = intermediateFormat.servers.map((server) => renderServer(server)).join("");
  const defaultServer = intermediateFormat.servers[0]?.url ?? "/";
  const title = intermediateFormat.source.title === "" ? "the API" : intermediateFormat.source.title;
  return [
    HEADER,
    `${imports.join("\n")}\n\n`,
    docComment([`The servers ${title} declares, in the document's order; pick one with \`serverUrl(servers[index], variables)\`.`]),
    `export const servers: Server[] = [\n${servers}];\n\n`,
    docComment([`Every service of ${title}, sharing one configuration.`]),
    `export type ApiClient<Transform extends boolean = false> = {\n${clientTypeMembers.join("")}};\n\n`,
    docComment([
      "Creates every service with one transport and one set of options.",
      `\`baseUrl\` defaults to \`${defaultServer.replaceAll("`", "'")}\`; \`transform: true\` switches all methods to App types.`,
    ]),
    `export function createClient<Transform extends boolean = false>(options: ClientOptions<Transform> = {}): ApiClient<Transform> {\n`,
    `${INDENT}const config = createServiceConfig(options, servers);\n`,
    `${INDENT}return {\n${clientValueMembers.join("")}${INDENT}};\n`,
    "}\n\n",
    docComment(["The declared errors of every operation, keyed by operationId."]),
    `export type ApiErrors = ${errorTypes.length === 0 ? "{}" : errorTypes.join(" & ")};\n\n`,
    docComment([
      "True WHEN `error` is an ApiError thrown by the operation `operationId`; narrows `status` and `body` to the",
      "responses the document declares for it. The operationId is checked at runtime, the body shape is not.",
    ]),
    `export function isApiError<OperationId extends keyof ApiErrors>(error: unknown, operationId: OperationId): error is ApiErrors[OperationId] {\n`,
    `${INDENT}return isApiErrorOf(error, operationId as string);\n`,
    "}\n",
  ].join("");
}
