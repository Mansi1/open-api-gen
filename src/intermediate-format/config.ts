// The one owner of configuration. Unknown keys are errors rather than ignored, so a typo in a config file fails
// loudly instead of silently generating a different client.
// A config file is JSON, or a JS/TS module whose default export is the config: only a module can hold `serviceFor`.
// VERIFIED: test/review-regressions.test.ts covers unknown and prototype keys and the filter merge;
// test/service-for.test.ts covers module config files and serviceFor.
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Transformer = { type: string; import: string; decode: string; encode: string };

/** What `serviceFor` sees of one operation: the document's values, with the operationId the generator settled on. */
export type OperationInfo = {
  operationId: string;
  /** Upper case, e.g. `GET`. */
  method: string;
  /** Templated path as in the document, e.g. `/pets/{petId}`. */
  path: string;
  tags: string[];
  summary?: string;
  deprecated: boolean;
};

/**
 * Picks the service of one operation. The returned name is used like a tag: `"pet store"` becomes `PetStoreService`
 * in `service/pet-store/`, `""` means the default service. `undefined` keeps the default rule, the first tag.
 */
export type ServiceFor = (operation: OperationInfo) => string | undefined;

export type Config = {
  input: string;
  output: string;
  /** Validate the input against the official OpenAPI schema before generating. */
  validateSpec: boolean;
  overlay: string[];
  filter: { tags?: string[]; excludeTags?: string[]; operationIds?: string[] };
  naming: { properties: "preserve" | "camelCase" };
  formats: { "date-time": "Date" | "string"; date: "Date" | "string"; int64: "bigint" | "number" };
  /** Keys are `format:<name>` or `schema:<ComponentName>`. */
  transformers: Record<string, Transformer>;
  /** Allow writing into an output directory that contains files this generator did not create. */
  force: boolean;
  /** Directory external `$ref` files must lie in; undefined = the input document's directory. */
  refRoot?: string;
  /** Groups operations into services; undefined = by first tag. */
  serviceFor?: ServiceFor;
};

/** What a config file or CLI flags may contain: every key optional, nested objects partial. */
export type ConfigInput = {
  input?: string;
  output?: string;
  validateSpec?: boolean;
  overlay?: string | string[];
  filter?: Config["filter"];
  naming?: Partial<Config["naming"]>;
  formats?: Partial<Config["formats"]>;
  transformers?: Record<string, Transformer>;
  force?: boolean;
  refRoot?: string;
  serviceFor?: ServiceFor;
};

/** Returns its argument; gives a JS or TS config file type checking and completion. */
export function defineConfig(config: ConfigInput): ConfigInput {
  return config;
}

type ValueKind = "boolean" | "string" | "strings" | "object" | "function" | readonly string[];

// Every allowed key, by dotted path. Anything else in a config file or in flags is an error.
const ALLOWED_KEYS: Record<string, ValueKind> = {
  input: "string",
  output: "string",
  validateSpec: "boolean",
  overlay: "strings",
  filter: "object",
  "filter.tags": "strings",
  "filter.excludeTags": "strings",
  "filter.operationIds": "strings",
  naming: "object",
  "naming.properties": ["preserve", "camelCase"],
  formats: "object",
  "formats.date-time": ["Date", "string"],
  "formats.date": ["Date", "string"],
  "formats.int64": ["bigint", "number"],
  transformers: "object",
  force: "boolean",
  refRoot: "string",
  serviceFor: "function",
};

/** The one owner of configuration: reads the optional config file, applies flags over it, validates, fills defaults. */
export async function loadConfig(configPath: string | undefined, flags: ConfigInput): Promise<Config> {
  let fromFile: ConfigInput = {};
  if (configPath !== undefined) {
    fromFile = await readConfigFile(configPath);
  }
  checkKeys(flags as Record<string, unknown>, "");

  const merged: ConfigInput = { ...fromFile, ...withoutUndefined(flags) };
  const naming = { ...fromFile.naming, ...withoutUndefined(flags.naming ?? {}) };
  const formats = { ...fromFile.formats, ...withoutUndefined(flags.formats ?? {}) };
  const filter = { ...fromFile.filter, ...withoutUndefined(flags.filter ?? {}) };
  // A flag transformer replaces a file transformer with the same key; the others from the file stay.
  const transformers = { ...fromFile.transformers, ...flags.transformers };

  if (merged.input === undefined) {
    throw new Error('config: "input" is required');
  }
  if (merged.output === undefined) {
    throw new Error('config: "output" is required');
  }
  checkTransformers(transformers);

  return {
    input: merged.input,
    output: merged.output,
    validateSpec: merged.validateSpec ?? true,
    overlay: toList(merged.overlay),
    filter,
    naming: { properties: naming.properties ?? "preserve" },
    formats: {
      "date-time": formats["date-time"] ?? "Date",
      date: formats.date ?? "Date",
      int64: formats.int64 ?? "bigint",
    },
    transformers,
    force: merged.force ?? false,
    ...(merged.refRoot !== undefined ? { refRoot: merged.refRoot } : {}),
    ...(merged.serviceFor !== undefined ? { serviceFor: merged.serviceFor } : {}),
  };
}

async function readConfigFile(configPath: string): Promise<ConfigInput> {
  let fromFile: ConfigInput;
  try {
    fromFile = MODULE_EXTENSIONS.includes(extname(configPath)) ? await importConfigModule(configPath) : JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read config ${configPath}: ${(error as Error).message}`);
  }
  if (typeof fromFile !== "object" || fromFile === null || Array.isArray(fromFile)) {
    throw new Error(`config ${configPath} must contain an object`);
  }
  checkKeys(fromFile as Record<string, unknown>, "");

  // Paths in a config file are relative to that file; paths from flags are relative to the working directory.
  const configDirectory = dirname(configPath);
  if (fromFile.input !== undefined) {
    fromFile.input = resolve(configDirectory, fromFile.input);
  }
  if (fromFile.output !== undefined) {
    fromFile.output = resolve(configDirectory, fromFile.output);
  }
  if (fromFile.refRoot !== undefined) {
    fromFile.refRoot = resolve(configDirectory, fromFile.refRoot);
  }
  if (fromFile.overlay !== undefined) {
    fromFile.overlay = toList(fromFile.overlay).map((overlayPath) => resolve(configDirectory, overlayPath));
  }
  return fromFile;
}

// TypeScript needs Bun or Node.js 22.18 or later, which strip types without a flag.
const MODULE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];

/** Runs a JS or TS config file and returns its default export (awaited, so it may be a promise), as a fresh copy. */
async function importConfigModule(configPath: string): Promise<ConfigInput> {
  const module = await import(pathToFileURL(resolve(configPath)).href);
  if (module.default === undefined) {
    throw new Error("a JS or TS config file needs a default export");
  }
  const exported = await module.default;
  // A copy, because relative paths are resolved in place below and the module object is shared by every import.
  return typeof exported === "object" && exported !== null && !Array.isArray(exported) ? { ...exported } : exported;
}

function checkKeys(values: Record<string, unknown>, prefix: string): void {
  for (const [key, value] of Object.entries(values)) {
    const path = prefix + key;
    const kind = Object.hasOwn(ALLOWED_KEYS, path) ? ALLOWED_KEYS[path] : undefined;
    if (kind === undefined) {
      throw new Error(`config: unknown config key "${path}"`);
    }
    if (value === undefined) {
      continue;
    }
    if (!hasKind(value, kind)) {
      throw new Error(`config: ${path} must be ${describeKind(kind)}`);
    }
    // Transformer entries are checked separately, because their keys are free-form.
    if (kind === "object" && path !== "transformers") {
      checkKeys(value as Record<string, unknown>, `${path}.`);
    }
  }
}

function hasKind(value: unknown, kind: ValueKind): boolean {
  if (kind === "boolean") {
    return typeof value === "boolean";
  }
  if (kind === "string") {
    return typeof value === "string";
  }
  if (kind === "strings") {
    return typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
  }
  if (kind === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  if (kind === "function") {
    return typeof value === "function";
  }
  return kind.includes(value as string);
}

function describeKind(kind: ValueKind): string {
  if (typeof kind === "string") {
    return `a ${kind}`;
  }
  return kind.map((choice) => `"${choice}"`).join(" | ");
}

function checkTransformers(transformers: Record<string, Transformer>): void {
  for (const [key, transformer] of Object.entries(transformers)) {
    if (!/^(format|schema):.+/.test(key)) {
      throw new Error(`config: transformer key "${key}" must start with "format:" or "schema:"`);
    }
    for (const field of ["type", "import", "decode", "encode"] as const) {
      const value = transformer?.[field];
      if (typeof value !== "string" || value === "") {
        throw new Error(`config: transformers["${key}"].${field} must be a non-empty string`);
      }
    }
  }
}

/**
 * Parses the CLI form of one transformer, `<format:name|schema:Name>=<type>,<import>,<decode>,<encode>`,
 * the four fields in the order of a config file entry. Commas rather than a JSON value, because JSON needs
 * shell quoting on every platform, while type names, identifiers and import paths practically never contain commas.
 * VERIFIED: scripts/e2e.ts generates the smoke client's Decimal hook through this flag.
 */
export function parseTransformerFlag(flag: string): [string, Transformer] {
  const separatorIndex = flag.indexOf("=");
  const fields = flag.slice(separatorIndex + 1).split(",");
  if (separatorIndex <= 0 || fields.length !== 4) {
    throw new Error(`--transformer "${flag}" must look like <format:name|schema:Name>=<type>,<import>,<decode>,<encode>`);
  }
  const [type, importPath, decode, encode] = fields as [string, string, string, string];
  return [flag.slice(0, separatorIndex), { type, import: importPath, decode, encode }];
}

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  return value;
}

function withoutUndefined<Value extends object>(values: Value): Partial<Value> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<Value>;
}
