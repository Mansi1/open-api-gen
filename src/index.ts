// The library entry: `generate` runs both stages and writes the result; Stage 1 and Stage 2 are also exported
// so callers can change the intermediate format between `buildIntermediateFormat` and `emit` (see ARCH.md).
// VERIFIED: test/write.test.ts generates twice into one directory through `generate`.
import packageJson from "../package.json" with { type: "json" };
import { emit } from "./emit/index.ts";
import { buildIntermediateFormat, prepareDocument } from "./intermediate-format/build.ts";
import type { Config } from "./intermediate-format/config.ts";
import type { Diagnostic } from "./intermediate-format/types.ts";
import { writeOutput } from "./write.ts";

export { emit, type Files } from "./emit/index.ts";
export { buildIntermediateFormat, prepareDocument } from "./intermediate-format/build.ts";
export { loadConfig, type Config, type ConfigInput } from "./intermediate-format/config.ts";
export type * from "./intermediate-format/types.ts";
export { SpecValidationError } from "./intermediate-format/validate-spec.ts";

export const VERSION: string = packageJson.version;

/** The whole pipeline: OpenAPI document → intermediate format → files written into `config.output`. */
export async function generate(config: Config): Promise<{ files: number; removed: number; warnings: Diagnostic[] }> {
  const prepared = await prepareDocument(config);
  const intermediateFormat = await buildIntermediateFormat(config, prepared);
  const files = emit(intermediateFormat);
  const { written, removed } = writeOutput(config.output, files, { generatorVersion: VERSION, config, document: prepared.document, warnings: intermediateFormat.warnings, intermediateFormat });
  return { files: written, removed, warnings: intermediateFormat.warnings };
}
