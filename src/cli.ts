#!/usr/bin/env node
// The command-line front end: flags → config → generate, with ISO-8601 UTC timestamped log lines.
// It holds no generation logic, so the library API (src/index.ts) and the CLI cannot drift apart.
// VERIFIED: scripts/e2e.ts runs this CLI from the installed tarball on every example spec.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildIntermediateFormat, prepareDocument } from "./intermediate-format/build.ts";
import { loadConfig, parseTransformerFlag, type ConfigInput } from "./intermediate-format/config.ts";
import { generate, VERSION } from "./index.ts";

const USAGE = `Usage: open-api-gen <input> -o <output-directory> [options]

Generates a TypeScript client from an OpenAPI 3.0, 3.1 or 3.2 document (JSON or YAML).

Options:
  -o, --output <dir>                 output directory
  -c, --config <file>                config file: JSON, or a JS/TS module whose default
                                     export is the config; flags override it
      --overlay <file>               apply an OpenAPI Overlay before generating (repeatable)
      --tag <tag>                    keep only operations with this tag (repeatable)
      --exclude-tag <tag>            drop operations with this tag (repeatable)
      --operation-id <id>            keep only this operation (repeatable)
      --naming <preserve|camelCase>  property names in App types (default preserve)
      --transformer <key>=<type>,<import>,<decode>,<encode>
                                     add a transformer (repeatable); <key> is format:<name> or
                                     schema:<Name>, <import> is relative to the output directory
      --ref-root <dir>               directory external $ref files may come from
                                     (default: the input document's directory)
      --no-validate-spec             skip validating the input against the OpenAPI schema
      --force                        write into a directory with files open-api-gen did not create
      --emit-intermediate-format <file>
                                     also write the intermediate format (JSON) to this file
  -h, --help                         show this help
  -v, --version                      show the version
`;

function log(level: "INFO" | "WARN" | "ERROR", message: string): void {
  // One timestamped line per message line, so multi-line errors and spec-provided warnings keep the log format.
  const prefix = `${new Date().toISOString()} ${level} `;
  const line = message.split("\n").map((messageLine) => `${prefix}${messageLine}\n`).join("");
  if (level === "INFO") {
    process.stdout.write(line);
  } else {
    process.stderr.write(line);
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      config: { type: "string", short: "c" },
      overlay: { type: "string", multiple: true },
      tag: { type: "string", multiple: true },
      "exclude-tag": { type: "string", multiple: true },
      "operation-id": { type: "string", multiple: true },
      naming: { type: "string" },
      transformer: { type: "string", multiple: true },
      "ref-root": { type: "string" },
      "no-validate-spec": { type: "boolean" },
      force: { type: "boolean" },
      "emit-intermediate-format": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (positionals.length > 1) {
    throw new Error(`expected one input document, got ${positionals.length}: ${positionals.join(", ")}`);
  }

  const flags: ConfigInput = {};
  if (positionals[0] !== undefined) {
    flags.input = positionals[0];
  }
  if (values.output !== undefined) {
    flags.output = values.output;
  }
  if (values.overlay !== undefined) {
    flags.overlay = values.overlay;
  }
  const filter: NonNullable<ConfigInput["filter"]> = {};
  if (values.tag !== undefined) {
    filter.tags = values.tag;
  }
  if (values["exclude-tag"] !== undefined) {
    filter.excludeTags = values["exclude-tag"];
  }
  if (values["operation-id"] !== undefined) {
    filter.operationIds = values["operation-id"];
  }
  if (Object.keys(filter).length > 0) {
    flags.filter = filter;
  }
  if (values.naming !== undefined) {
    flags.naming = { properties: values.naming as "preserve" | "camelCase" };
  }
  if (values.transformer !== undefined) {
    const transformerEntries = values.transformer.map((transformerFlag) => parseTransformerFlag(transformerFlag));
    flags.transformers = Object.fromEntries(transformerEntries);
  }
  if (values["ref-root"] !== undefined) {
    flags.refRoot = values["ref-root"];
  }
  if (values["no-validate-spec"] === true) {
    flags.validateSpec = false;
  }
  if (values.force === true) {
    flags.force = true;
  }

  const config = await loadConfig(values.config, flags);
  const result = await generate(config);
  // Written after generate, so a run the write guard refuses leaves no file behind.
  const intermediateFormatPath = values["emit-intermediate-format"];
  if (intermediateFormatPath !== undefined) {
    const intermediateFormat = await buildIntermediateFormat(config, await prepareDocument(config));
    await writeFile(intermediateFormatPath, `${JSON.stringify(intermediateFormat, null, 2)}\n`);
    log("INFO", `wrote the intermediate format to ${intermediateFormatPath}`);
  }
  for (const warning of result.warnings) {
    log("WARN", warning.pointer === "" ? warning.message : `${warning.pointer}: ${warning.message}`);
  }
  const details: string[] = [];
  if (result.removed > 0) {
    details.push(`${result.removed} stale files removed`);
  }
  if (result.warnings.length > 0) {
    const plural = result.warnings.length === 1 ? "" : "s";
    details.push(`${result.warnings.length} warning${plural}, listed in version.json`);
  }
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  log("INFO", `generated ${result.files} files into ${config.output}${suffix}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log("ERROR", message);
    process.exitCode = 1;
  },
);
