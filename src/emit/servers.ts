// Renders an OpenAPI Server Object as a TypeScript object literal: the client's server list and the operation
// descriptors of operations with their own servers share it. Every string goes through quote().
// VERIFIED: test/services.test.ts generates both and calls them against a real Bun.serve server.
import type { Server } from "../intermediate-format/types.ts";
import { propertyKey, quote } from "./names.ts";

/** `{ url: '…', description: '…', variables: { … } }` on one line. */
export function renderServer(server: Server): string {
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
  return `{ ${fields.join(", ")} }`;
}
