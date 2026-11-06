// Emits webhooks.ts for documents with webhooks or callbacks: the payload type of each incoming operation, keyed by
// operationId, and parseWebhook, which parses, validates and decodes a payload through runtime/webhooks.ts.
// A server receives these requests, so this is the one generated module meant for server code.
// VERIFIED: test/services.test.ts parses webhook and callback payloads through the generated parseWebhook.
import type { Declaration, Incoming, IntermediateFormat } from "../intermediate-format/types.ts";
import { CodecRenderer } from "./codecs.ts";
import { TypeImports, TypeRenderer } from "./interfaces.ts";
import { HEADER, importPath, type Files } from "./layout.ts";
import { docComment, propertyKey, quote } from "./names.ts";
import { ValidatorRenderer } from "./validators.ts";

export const WEBHOOKS_PATH = "webhooks.ts";
const INDENT = "  ";

export function emitWebhooks(intermediateFormat: IntermediateFormat): Files {
  if (intermediateFormat.incoming.length === 0) {
    return new Map();
  }
  const declarationsByName = new Map<string, Declaration>(intermediateFormat.declarations.map((declaration) => [declaration.name, declaration]));
  const typeImports = new TypeImports();
  const wireTypes = new TypeRenderer(WEBHOOKS_PATH, "wire", intermediateFormat, declarationsByName, typeImports);
  const appTypes = new TypeRenderer(WEBHOOKS_PATH, "app", intermediateFormat, declarationsByName, typeImports, true);
  // Both runtimes export `array` and `lazy`, so this file uses them through namespaces, as service files do.
  const validators = new ValidatorRenderer(WEBHOOKS_PATH, declarationsByName, "validation");
  const codecs = new CodecRenderer(WEBHOOKS_PATH, intermediateFormat, declarationsByName, "transform", validators);

  const payloadMembers: string[] = [];
  const descriptors: string[] = [];
  for (const incoming of intermediateFormat.incoming) {
    const bodyType = incoming.requestBody?.type;
    let payloadType = "unknown";
    if (bodyType !== undefined) {
      const wire = wireTypes.render(bodyType);
      const app = appTypes.render(bodyType);
      payloadType = wire === app ? wire : `Transform extends true ? ${app} : ${wire}`;
    } else if (incoming.requestBody === undefined) {
      payloadType = "undefined";
    }
    payloadMembers.push(`${docComment(describeIncoming(incoming), INDENT)}${INDENT}${propertyKey(incoming.operationId)}: ${payloadType};\n`);

    const fields = [`operationId: ${quote(incoming.operationId)}`];
    if (incoming.requestBody !== undefined) {
      fields.push(`contentType: ${quote(incoming.requestBody.contentType)}`);
    }
    if (bodyType !== undefined && bodyType.kind !== "binary" && bodyType.kind !== "unknown") {
      fields.push(`validator: ${validators.render(bodyType)}`);
      if (codecs.needsTransform(bodyType)) {
        fields.push(`transformer: ${codecs.render(bodyType)}`);
      }
    }
    descriptors.push(`${INDENT}${propertyKey(incoming.operationId)}: { ${fields.join(", ")} },\n`);
  }

  const imports = [
    `import { parseIncoming, type IncomingDescriptor, type ParseWebhookOptions } from ${quote(importPath(WEBHOOKS_PATH, "runtime/webhooks.ts"))};`,
    typeImports.lines().trimEnd(),
    validators.importLines(false).trimEnd(),
    codecs.importLines(false).trimEnd(),
  ].filter((line) => line !== "");
  const content = [
    HEADER,
    `${imports.join("\n")}\n\n`,
    docComment(["The payload of every webhook and callback, keyed by operationId; App types with `Transform` true."]),
    `export type WebhookPayloads<Transform extends boolean = false> = {\n${payloadMembers.join("")}};\n\n`,
    `const incomingOperations: Record<string, IncomingDescriptor> = {\n${descriptors.join("")}};\n\n`,
    docComment([
      "Reads the body of a webhook or callback request the API sent: JSON text (string or bytes) or an already parsed value.",
      "`validate: true` checks it against its schema (WebhookValidationError); `transform: true` returns App values.",
    ]),
    "export function parseWebhook<OperationId extends keyof WebhookPayloads, Transform extends boolean = false>(\n",
    `${INDENT}operationId: OperationId,\n`,
    `${INDENT}body: unknown,\n`,
    `${INDENT}options: ParseWebhookOptions<Transform> = {},\n`,
    "): WebhookPayloads<Transform>[OperationId] {\n",
    `${INDENT}const descriptor = incomingOperations[operationId as string];\n`,
    `${INDENT}if (descriptor === undefined) {\n`,
    `${INDENT}${INDENT}throw new TypeError(\`parseWebhook: unknown operationId "\${String(operationId)}"\`);\n`,
    `${INDENT}}\n`,
    `${INDENT}return parseIncoming(descriptor, body, options) as WebhookPayloads<Transform>[OperationId];\n`,
    "}\n",
  ].join("");
  return new Map([[WEBHOOKS_PATH, content]]);
}

/** The doc comment of a payload type: summary, description, and where the request comes from. */
function describeIncoming(incoming: Incoming): string[] {
  const lines: string[] = [];
  if (incoming.summary !== undefined) {
    lines.push(incoming.summary, "");
  }
  if (incoming.description !== undefined) {
    lines.push(incoming.description, "");
  }
  if (incoming.kind === "webhook") {
    lines.push(`Webhook \`${incoming.name}\`: \`${incoming.method}\` to the URL you registered.`);
  } else {
    lines.push(`Callback \`${incoming.name}\`: \`${incoming.method} ${incoming.expression ?? ""}\`.`);
  }
  if (incoming.deprecated === true) {
    lines.push("@deprecated");
  }
  return lines;
}
