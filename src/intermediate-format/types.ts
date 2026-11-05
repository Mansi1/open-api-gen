/**
 * The internal format joining the two stages. Stage 1 (src/intermediate-format) builds it from an OpenAPI document,
 * Stage 2 (src/emit) turns it into files without ever seeing the document, its version or the config.
 *
 * Rules: plain JSON data only (no functions, classes, Maps or cycles; references are by name), and every
 * decision is already made here, so Stage 2 only formats. Bump `intermediateFormatVersion` on any incompatible change.
 */
export type IntermediateFormat = {
  intermediateFormatVersion: 1;
  source: { path: string; openapi: string; title: string; version: string; description?: string };
  /**
   * The document's top-level `servers`, in order; the first one is the generated client's default base URL.
   * VERIFIED: an absent or empty list means one server with url `/` (spec/openapi-3.1.2.md:328); the runtime applies that default.
   */
  servers: Server[];
  /** `components.securitySchemes` by name, references resolved; `auth` credentials of the generated client are keyed by these names. */
  securitySchemes: Record<string, SecurityScheme>;
  /** Every named type; Stage 2 writes one file per declaration. */
  declarations: Declaration[];
  services: Service[];
  /** Transformers from the config, keyed `format:<name>` | `schema:<Name>`; referenced by `Codec.hook`. */
  hooks: Record<string, Hook>;
  warnings: Diagnostic[];
};

/** A problem found in the input; `pointer` is a JSON Pointer into the OpenAPI document. */
export type Diagnostic = { pointer: string; message: string };

/** An OpenAPI Server Object; `url` may hold `{variable}` templates that `variables` defines. */
export type Server = { url: string; description?: string; variables?: Record<string, ServerVariable> };

export type ServerVariable = { default: string; enum?: string[]; description?: string };

/** An OpenAPI Security Scheme Object, reduced to what a client needs to send credentials. */
export type SecurityScheme =
  | { type: "apiKey"; in: "header" | "query" | "cookie"; name: string; description?: string }
  /** `scheme` is lower case, e.g. `bearer`, `basic`, `digest`. */
  | { type: "http"; scheme: string; description?: string }
  | { type: "oauth2" | "openIdConnect" | "mutualTLS"; description?: string };

export type Hook = { type: string; import: string; decode: string; encode: string };

export type DeclarationKind = "components" | "request" | "response" | "parameter";

export type Declaration = {
  /** Final TypeScript identifier, unique across all declarations. */
  name: string;
  /** Folder under `interface/`. */
  kind: DeclarationKind;
  description?: string;
  deprecated?: boolean;
  /** Original schema JSON, embedded in the doc comment as dist3 does. */
  source: unknown;
  /** JSON Pointer of `source` in the OpenAPI document. */
  pointer: string;
  type: TypeNode;
  /** True WHEN the App type differs from the wire type (a codec or rename here or in any referenced declaration). */
  transformed: boolean;
  /** True WHEN a request or response reaches this declaration, so validators and codecs are emitted for it. */
  runtime: boolean;
};

export type Scalar = string | number | boolean | null;

/** JSON Schema constraints the validators check; names match JSON Schema 2020-12 (3.0 forms are normalized). */
export type Constraints = {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
};

/** How a value changes between wire and App shape when a client enables `transform`. */
export type Codec = { kind: "date-time" } | { kind: "date" } | { kind: "bigint" } | { kind: "hook"; hook: string };

export type TypeNode = (
  | { kind: "ref"; name: string }
  | { kind: "string"; constraints: Constraints }
  | { kind: "number"; integer: boolean; constraints: Constraints }
  | { kind: "boolean" }
  | { kind: "null" }
  /** `format: binary` bodies: a Blob in TypeScript, never validated as JSON. */
  | { kind: "binary" }
  | { kind: "literal"; value: Scalar }
  | { kind: "enum"; values: Scalar[] }
  | { kind: "array"; items: TypeNode; constraints: Constraints }
  /** `rest: false` = no further items allowed; `rest: null` = any further items. */
  | { kind: "tuple"; prefix: TypeNode[]; rest: TypeNode | false | null; constraints: Constraints }
  | { kind: "object"; properties: Property[]; additional: TypeNode | boolean; constraints: Constraints }
  | { kind: "union"; mode: "oneOf" | "anyOf"; members: TypeNode[]; discriminator?: Discriminator }
  | { kind: "intersection"; members: TypeNode[] }
  /** Anything the schema allows that TypeScript cannot express (unsupported keywords, `{}`, `true`). */
  | { kind: "unknown" }
  /** A schema that allows nothing (`false`). */
  | { kind: "never" }
) & { description?: string; deprecated?: boolean; codec?: Codec };

export type Property = {
  /** Name on the wire. */
  name: string;
  /** Name in App types; differs from `name` only under a naming transform. */
  appName: string;
  required: boolean;
  type: TypeNode;
  description?: string;
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
};

/** `mapping` goes from discriminator value to declaration name. */
export type Discriminator = { property: string; mapping: Record<string, string> };

export type Service = {
  /** Class name, e.g. `PetsService`. */
  name: string;
  /** Property of the generated `createClient` result that holds this service, e.g. `pets`. */
  property: string;
  /** Folder under `service/`. */
  folder: string;
  description?: string;
  operations: Operation[];
};

export type HttpMethod = string;

export type ParameterLocation = "path" | "query" | "header" | "cookie";

/** Parameters keep their wire names and wire types: transforms apply to bodies only. */
export type Parameter = {
  name: string;
  required: boolean;
  type: TypeNode;
  style: "form" | "simple" | "deepObject" | "spaceDelimited" | "pipeDelimited" | "label" | "matrix";
  explode: boolean;
  description?: string;
  deprecated?: boolean;
};

export type ParameterGroup = {
  /** Interface name, e.g. `GetPetPathParameter`. */
  declaration: string;
  required: boolean;
  parameters: Parameter[];
};

export type Body = {
  contentType: string;
  /** Omitted WHEN the media type has no schema. */
  type?: TypeNode;
  /** OpenAPI 3.2 `itemSchema`: the body is a sequence of items (JSON Lines, SSE, ...), `type` is one item. */
  stream: boolean;
};

export type Response = Body & { status: string; description?: string };

export type Operation = {
  /** Method name on the service, camelCase. */
  name: string;
  operationId: string;
  /** Upper case, e.g. `GET`, `QUERY`, or a 3.2 `additionalOperations` method. */
  method: HttpMethod;
  /** Templated path as in the document, e.g. `/pets/{petId}`. */
  path: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters: Partial<Record<ParameterLocation, ParameterGroup>>;
  /** OpenAPI 3.2 `in: querystring`: the whole query string as one value. */
  querystring?: { name: string; contentType: string; type: TypeNode; required: boolean };
  requestBody?: Body & { required: boolean };
  /** Sorted by status; `default` last. */
  responses: Response[];
  /** Status codes that count as success (2xx, or `default` when there is no 2xx). */
  success: string[];
  /**
   * Effective security requirements: alternatives, each a list of scheme names that apply together (scopes dropped).
   * The operation's own `security`, else the document's; empty WHEN the operation needs no credentials.
   */
  security: string[][];
};
