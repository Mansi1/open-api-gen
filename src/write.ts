// Writes generated files safely. Ownership is recognized by the generated-file header and version.json rather
// than by a manifest, so a hand-edited or foreign file is detected even when a previous run's record is missing.
// VERIFIED: test/write.test.ts covers foreign files, --force, symlinks and user-created empty folders.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { Config } from "./intermediate-format/config.ts";
import type { Diagnostic } from "./intermediate-format/types.ts";
import { HEADER, type Files } from "./emit/layout.ts";

export const GENERATOR_NAME = "open-api-gen";
const VERSION_FILE = "version.json";
const INTERMEDIATE_FORMAT_FILE = "intermediate-format.json";
// Metadata files carry no header; they count as ours WHEN version.json says the directory is ours.
const METADATA_FILES = ["open-api.json", "open-api.yaml", INTERMEDIATE_FORMAT_FILE];

export type OutputMetadata = {
  generatorVersion: string;
  config: Config;
  /** The OpenAPI document after overlays and filters, copied into the output as dist3 does. */
  document: Record<string, unknown>;
  /** Everything the generator warned about, kept with the client in version.json. */
  warnings: Diagnostic[];
  /** What Stage 2 generated the client from, kept as intermediate-format.json. */
  intermediateFormat: unknown;
};

/**
 * Writes the generated files into `directory`. Refuses to touch a directory holding files this generator did not
 * create (unless `config.force`), and deletes only stale files it created itself, so hand-written work survives.
 * Never follows a symbolic link inside `directory`, even with `config.force`, so nothing outside it is written.
 */
export function writeOutput(directory: string, files: Files, metadata: OutputMetadata): { written: number; removed: number } {
  const existing = existsSync(directory) ? listFiles(directory) : [];
  const ownsSpecCopies = isOurVersionFile(join(directory, VERSION_FILE));
  const foreign = existing.filter((path) => !isGenerated(directory, path, ownsSpecCopies));
  if (foreign.length > 0 && !metadata.config.force) {
    const listed = foreign.slice(0, 5).map((path) => `  ${path}`).join("\n");
    const more = foreign.length > 5 ? `\n  ... and ${foreign.length - 5} more` : "";
    throw new Error(`refusing to write into ${directory}: it contains files open-api-gen did not create:\n${listed}${more}\nUse --force to write anyway.`);
  }

  const symbolicLinks = existing.filter((path) => isSymbolicLink(join(directory, path)));
  if (symbolicLinks.length > 0) {
    throw new Error(`refusing to write into ${directory}: it contains symbolic links: ${symbolicLinks.join(", ")}`);
  }

  const allFiles: Files = new Map(files);
  // A config function (serviceFor) is recorded by its source text, which JSON.stringify would drop without a trace.
  const functionsAsSource = (_key: string, value: unknown) => (typeof value === "function" ? String(value) : value);
  allFiles.set(VERSION_FILE, `${JSON.stringify(versionFile(metadata), functionsAsSource, 2)}\n`);
  allFiles.set("open-api.json", `${JSON.stringify(metadata.document, null, 2)}\n`);
  allFiles.set("open-api.yaml", stringifyYaml(metadata.document));
  allFiles.set(INTERMEDIATE_FORMAT_FILE, `${JSON.stringify(metadata.intermediateFormat, null, 2)}\n`);

  let removed = 0;
  for (const path of existing) {
    if (!allFiles.has(path) && isGenerated(directory, path, ownsSpecCopies)) {
      rmSync(join(directory, path));
      removeEmptyParents(directory, dirname(path));
      removed++;
    }
  }
  for (const [path, content] of allFiles) {
    const fullPath = join(directory, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return { written: allFiles.size, removed };
}

/** dist3's version.json fields (version, creation, path, config), plus the generator name to recognize our output. */
function versionFile(metadata: OutputMetadata) {
  return {
    generator: GENERATOR_NAME,
    version: metadata.generatorVersion,
    creation: new Date().toISOString(),
    path: metadata.config.input,
    config: metadata.config,
    warnings: metadata.warnings,
  };
}

function isOurVersionFile(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")).generator === GENERATOR_NAME;
  } catch {
    return false;
  }
}

/** Generated TypeScript starts with our header; version.json and the metadata files are ours when version.json says so. */
function isGenerated(directory: string, path: string, ownsSpecCopies: boolean): boolean {
  if (path === VERSION_FILE) {
    return ownsSpecCopies;
  }
  if (METADATA_FILES.includes(path)) {
    return ownsSpecCopies;
  }
  if (!path.endsWith(".ts") || !lstatSync(join(directory, path)).isFile()) {
    return false;
  }
  return readFileSync(join(directory, path), "utf8").startsWith(HEADER);
}

/** Every entry that is not a directory, so symbolic links and other special files count as foreign too. */
function listFiles(directory: string): string[] {
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => !entry.isDirectory()).map((entry) => relative(directory, join(entry.parentPath, entry.name)).split("\\").join("/"));
}

function isSymbolicLink(path: string): boolean {
  return lstatSync(path).isSymbolicLink();
}

/** Removes the folders above a deleted stale file while they are empty, never a folder the run did not empty. */
function removeEmptyParents(directory: string, folder: string): void {
  for (let current = folder; current !== "." && current !== ""; current = dirname(current)) {
    const fullPath = join(directory, current);
    if (readdirSync(fullPath).length > 0) {
      return;
    }
    rmdirSync(fullPath);
  }
}
