// The Stage 1 pipeline in one place, so its order (overlays before validation, filtering last) is explicit.
// VERIFIED: test/spec-transforms.test.ts covers the overlay → validate → filter order.
import type { Config } from "./config.ts";
import { filterSpec } from "./filter.ts";
import { load, readStructuredFile, type OpenApiVersion } from "./load.ts";
import { normalize } from "./normalize.ts";
import { applyOverlay } from "./overlay.ts";
import { planTransforms } from "./transform-plan.ts";
import type { Diagnostic, IntermediateFormat } from "./types.ts";
import { stripRefSiblings, validateSpec } from "./validate-spec.ts";

export type PreparedDocument = { document: Record<string, unknown>; version: OpenApiVersion; warnings: Diagnostic[] };

/**
 * The OpenAPI document the client is generated from: overlays applied, 3.0 `$ref` siblings dropped, validated
 * (overlays first, because the result is what must be valid), then filtered (filtering only removes).
 */
export async function prepareDocument(config: Config): Promise<PreparedDocument> {
  const loaded = await load(config.input);
  const warnings: Diagnostic[] = [];
  let document = loaded.document;
  for (const overlayPath of config.overlay) {
    const overlaid = applyOverlay(document, await readStructuredFile(overlayPath), overlayPath);
    document = overlaid.document;
    warnings.push(...overlaid.warnings);
  }
  const stripped = stripRefSiblings(document, loaded.version);
  warnings.push(...stripped.warnings);
  if (config.validateSpec) {
    await validateSpec(stripped.document, loaded.version);
  }
  const filtered = filterSpec(stripped.document, loaded.version, config.filter);
  warnings.push(...filtered.warnings);
  return { document: filtered.document, version: loaded.version, warnings };
}

/** Stage 1: OpenAPI document + config → intermediate format. Everything Stage 2 needs is decided here. */
export async function buildIntermediateFormat(config: Config, prepared?: PreparedDocument): Promise<IntermediateFormat> {
  const { document, version, warnings } = prepared ?? (await prepareDocument(config));
  const normalized = normalize(document, version, config.input);
  const intermediateFormat = planTransforms(normalized, config);
  intermediateFormat.warnings.unshift(...warnings);
  return intermediateFormat;
}
