// Emits one dist3-shaped service class per tag. Methods delegate to runtime/service.ts callOperation with an
// operation descriptor, so encode → send → validate → decode is written and tested once, not per operation.
// The descriptor is written inline in its method rather than as a module constant, so each method reads on its own.
// VERIFIED: test/services.test.ts runs generated services against a real Bun.serve server.
import type { Declaration, IntermediateFormat, Operation, ParameterGroup, ParameterLocation, Service, TypeNode } from "../intermediate-format/types.ts";
import { CodecRenderer } from "./codecs.ts";
import { TypeImports, TypeRenderer } from "./interfaces.ts";
import { HEADER, importPath, type Files } from "./layout.ts";
import { docComment, identifier, propertyKey, quote } from "./names.ts";
import { ValidatorRenderer } from "./validators.ts";

const INDENT = "    ";

export function servicePath(service: Service): string {
  return `service/${service.folder}/${identifier(service.name)}.ts`;
}

/** One class per service (tag), shaped like dist3, with every operation as an arrow-function property. */
export function emitServices(intermediateFormat: IntermediateFormat): Files {
  const files: Files = new Map();
  const declarationsByName = new Map(intermediateFormat.declarations.map((declaration) => [declaration.name, declaration]));
  for (const service of intermediateFormat.services) {
    const path = servicePath(service);
    files.set(path, new ServiceFile(path, service, intermediateFormat, declarationsByName).render());
  }
  return files;
}

type Argument = { name: string; type: string; required: boolean };

class ServiceFile {
  private readonly typeImports = new TypeImports();
  private readonly wireTypes: TypeRenderer;
  private readonly appTypes: TypeRenderer;
  private readonly validators: ValidatorRenderer;
  private readonly codecs: CodecRenderer;

  constructor(
    private readonly path: string,
    private readonly service: Service,
    intermediateFormat: IntermediateFormat,
    private readonly declarationsByName: Map<string, Declaration>,
  ) {
    this.wireTypes = new TypeRenderer(path, "wire", intermediateFormat, declarationsByName, this.typeImports);
    this.appTypes = new TypeRenderer(path, "app", intermediateFormat, declarationsByName, this.typeImports, true);
    // Both runtimes export `array` and `lazy`, so service files use them through namespaces.
    this.validators = new ValidatorRenderer(path, declarationsByName, "validation");
    this.codecs = new CodecRenderer(path, intermediateFormat, declarationsByName, "transform", this.validators);
  }

  render(): string {
    const methods: string[] = [];
    for (const operation of this.service.operations) {
      methods.push(this.renderMethod(operation, this.renderDescriptor(operation)));
    }
    const errorsType = this.renderErrors();
    const runtimePath = importPath(this.path, "runtime/service.ts");
    const imports = [
      // Lowercase namespaces: declaration names are PascalCase, so a schema named ApiError or RequestOptions cannot clash.
      `import * as serviceRuntime from ${quote(runtimePath)};`,
      `import type * as fetchRuntime from ${quote(importPath(this.path, "runtime/fetch-send.ts"))};`,
      this.typeImports.lines().trimEnd(),
      this.validators.importLines(false).trimEnd(),
      this.codecs.importLines(false).trimEnd(),
    ].filter((line) => line !== "");
    const importText = imports.join("\n");

    const name = identifier(this.service.name);
    const classComment: string[] = [];
    if (this.service.description !== undefined) {
      classComment.push(this.service.description, "");
    }
    classComment.push(
      "Create with `new " + name + "({ send })` for wire values, or `new " + name + "({ send, transform: true })` for App values",
      "(Date, bigint, renamed properties, hooks). Add `validate: true` to check every response against its schema.",
    );
    return [
      HEADER,
      `${importText}\n\n`,
      `${docComment(classComment)}export class ${name}<Transform extends boolean = false> {\n\n`,
      `${INDENT}constructor(public config: serviceRuntime.ServiceConfig<Transform>) {\n${INDENT}}\n\n`,
      methods.join("\n"),
      "}\n\n",
      errorsType,
    ].join("");
  }

  /**
   * `<Service>Errors`: per operationId, the ApiError variants its declared non-success responses describe.
   * Error bodies are parsed plainly (no transform), so they get wire types. A range (`4XX`) or `default` status is
   * `number`; an operation without declared error responses gets `ApiError<unknown, number>`.
   */
  private renderErrors(): string {
    const members: string[] = [];
    for (const operation of this.service.operations) {
      const bodyTypesByStatus = new Map<string, Set<string>>();
      for (const response of operation.responses) {
        if (operation.success.includes(response.status)) {
          continue;
        }
        // A streamed error body is read as one plain value, so its item type does not describe it.
        const bodyType = response.type === undefined || response.stream ? "unknown" : this.wireTypes.render(response.type);
        let bodyTypes = bodyTypesByStatus.get(response.status);
        if (bodyTypes === undefined) {
          bodyTypes = new Set();
          bodyTypesByStatus.set(response.status, bodyTypes);
        }
        bodyTypes.add(bodyType);
      }
      const variants: string[] = [];
      for (const [status, bodyTypes] of bodyTypesByStatus) {
        const statusType = /^[1-5][0-9][0-9]$/.test(status) ? status : "number";
        const bodyType = bodyTypes.has("unknown") ? "unknown" : [...bodyTypes].join(" | ");
        variants.push(`fetchRuntime.ApiError<${bodyType}, ${statusType}>`);
      }
      if (variants.length === 0) {
        variants.push("fetchRuntime.ApiError<unknown, number>");
      }
      members.push(`${INDENT}${propertyKey(operation.operationId)}: ${variants.join(" | ")};\n`);
    }
    const comment = [
      `The errors each operation of ${identifier(this.service.name)} declares, keyed by operationId; narrow with \`isApiError(error, operationId)\`.`,
      "Statuses the document does not declare are not listed; the bodies are not checked at runtime.",
    ];
    return `${docComment(comment)}export type ${identifier(this.service.name)}Errors = {\n${members.join("")}};\n`;
  }

  private successType(operation: Operation): TypeNode | undefined {
    const types: TypeNode[] = [];
    for (const response of operation.responses) {
      if (operation.success.includes(response.status) && response.type !== undefined) {
        types.push(response.type);
      }
    }
    if (types.length === 0) {
      return undefined;
    }
    if (types.length === 1) {
      return types[0];
    }
    return { kind: "union", mode: "anyOf", members: types };
  }

  /** The operation descriptor as an object literal, indented to sit inside a method body. */
  private renderDescriptor(operation: Operation): string {
    const fields: string[] = [
      `operationId: ${quote(operation.operationId)}`,
      `method: ${quote(operation.method)}`,
      `url: ${quote(operation.path)}`,
    ];
    const responseContentTypes = new Set<string>();
    for (const response of operation.responses) {
      if (operation.success.includes(response.status) && response.contentType !== "") {
        responseContentTypes.add(response.contentType);
      }
    }
    fields.push(`responseContentTypes: [${[...responseContentTypes].map(quote).join(", ")}]`);
    fields.push(`parameterStyles: ${this.renderParameterStyles(operation)}`);
    const stream = operation.responses.some((response) => operation.success.includes(response.status) && response.stream);
    fields.push(`stream: ${stream}`);
    if (this.mayAnswerWithoutBody(operation)) {
      fields.push("emptyBodyAllowed: true");
    }
    if (operation.requestBody !== undefined) {
      fields.push(`requestContentType: ${quote(operation.requestBody.contentType)}`);
      if (operation.requestBody.type !== undefined && this.codecs.needsTransform(operation.requestBody.type)) {
        fields.push(`requestTransformer: ${this.codecs.render(operation.requestBody.type)}`);
      }
    }
    if (operation.querystring !== undefined) {
      fields.push(`querystringContentType: ${quote(operation.querystring.contentType)}`);
    }
    const successType = this.successType(operation);
    if (successType !== undefined && successType.kind !== "binary" && successType.kind !== "unknown") {
      fields.push(`responseValidator: ${this.validators.render(successType)}`);
      if (this.codecs.needsTransform(successType)) {
        fields.push(`responseTransformer: ${this.codecs.render(successType)}`);
      }
    }
    const fieldIndent = INDENT.repeat(3);
    const body = fields.map((field) => `${fieldIndent}${field},`).join("\n");
    return `{\n${body}\n${INDENT}${INDENT}}`;
  }

  /** True WHEN one success response has a body type and another has none (e.g. 200 with a body, 204 without). */
  private mayAnswerWithoutBody(operation: Operation): boolean {
    const successResponses = operation.responses.filter((response) => operation.success.includes(response.status));
    const withBody = successResponses.some((response) => response.type !== undefined);
    const withoutBody = successResponses.some((response) => response.type === undefined);
    return withBody && withoutBody;
  }

  private renderParameterStyles(operation: Operation): string {
    const locations: string[] = [];
    for (const [location, group] of Object.entries(operation.parameters) as [ParameterLocation, ParameterGroup][]) {
      const styles = group.parameters.map((parameter) => `${propertyKey(parameter.name)}: { style: ${quote(parameter.style)}, explode: ${parameter.explode} }`);
      locations.push(`${location}: { ${styles.join(", ")} }`);
    }
    if (locations.length === 0) {
      return "{}";
    }
    return `{ ${locations.join(", ")} }`;
  }

  /** `Transform extends true ? App : Wire`, or just the type when both shapes are the same. */
  private shapedType(node: TypeNode): string {
    const wire = this.wireTypes.render(node);
    const app = this.appTypes.render(node);
    if (wire === app) {
      return wire;
    }
    return `Transform extends true ? ${app} : ${wire}`;
  }

  private renderMethod(operation: Operation, descriptor: string): string {
    const parameterArguments: [string, ParameterLocation][] = [["urlParameter", "path"], ["queryParameter", "query"]];
    const argumentsList: Argument[] = [];
    for (const [argumentName, location] of parameterArguments) {
      const group = operation.parameters[location];
      if (group !== undefined) {
        argumentsList.push({ name: argumentName, type: this.parameterType(group), required: group.required });
      }
    }
    if (operation.querystring !== undefined) {
      argumentsList.push({ name: "querystring", type: this.wireTypes.render(operation.querystring.type), required: operation.querystring.required });
    }
    for (const [argumentName, location] of [["headerParameter", "header"], ["cookieParameter", "cookie"]] as [string, ParameterLocation][]) {
      const group = operation.parameters[location];
      if (group !== undefined) {
        argumentsList.push({ name: argumentName, type: this.parameterType(group), required: group.required });
      }
    }
    if (operation.requestBody !== undefined) {
      const bodyType = operation.requestBody.type === undefined ? "unknown" : this.shapedType(operation.requestBody.type);
      argumentsList.push({ name: "body", type: bodyType, required: operation.requestBody.required });
    }

    const signature = argumentsList
      .map((argument, index) => {
        // An optional argument before a required one must stay positional, so it takes `| undefined` instead of `?`.
        const laterRequired = argumentsList.slice(index + 1).some((later) => later.required);
        if (argument.required) {
          return `${argument.name}: ${argument.type}`;
        }
        if (laterRequired) {
          return `${argument.name}: ${argument.type} | undefined`;
        }
        return `${argument.name}?: ${argument.type}`;
      })
      .join(", ");
    // Per-call options (signal, timeout, headers, retry, onResponse) always come last, so they never shift a parameter.
    const fullSignature = signature === "" ? "options?: serviceRuntime.RequestOptions" : `${signature}, options?: serviceRuntime.RequestOptions`;

    const successType = this.successType(operation);
    let resultType = successType === undefined ? "void" : this.shapedType(successType);
    if (successType !== undefined && this.mayAnswerWithoutBody(operation)) {
      resultType = `(${resultType}) | undefined`;
    }
    const stream = operation.responses.some((response) => operation.success.includes(response.status) && response.stream);
    if (stream) {
      resultType = `AsyncIterable<${resultType}>`;
    }

    const comment: string[] = [];
    if (operation.summary !== undefined) {
      comment.push(operation.summary);
    }
    if (operation.description !== undefined) {
      if (comment.length > 0) {
        comment.push("");
      }
      comment.push(operation.description);
    }
    if (comment.length > 0) {
      comment.push("");
    }
    comment.push(`\`${operation.method} ${operation.path}\``);
    if (operation.deprecated === true) {
      comment.push("@deprecated");
    }
    const passed = argumentsList.map((argument) => argument.name).join(", ");
    return [
      docComment(comment, INDENT),
      `${INDENT}${identifier(operation.name)} = (${fullSignature}): Promise<${resultType}> => {\n`,
      `${INDENT}${INDENT}return serviceRuntime.callOperation(this.config, ${descriptor}, { ${passed} }, options) as Promise<${resultType}>;\n`,
      `${INDENT}};\n`,
    ].join("");
  }

  private parameterType(group: ParameterGroup): string {
    const declaration = this.declarationsByName.get(group.declaration);
    if (declaration === undefined) {
      throw new Error(`intermediate format contract: no declaration for parameter group "${group.declaration}"`);
    }
    return this.wireTypes.render({ kind: "ref", name: declaration.name });
  }
}
