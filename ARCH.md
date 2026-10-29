# Architecture

open-api-gen turns an OpenAPI document into a TypeScript client in two stages joined by one data format.

```mermaid
flowchart LR
  spec[OpenAPI document<br/>JSON or YAML] --> prepare
  config[config file<br/>and flags] --> prepare
  subgraph stage1 [Stage 1: src/intermediate-format]
    prepare[load → overlays → strip 3.0 $ref siblings → validate → filter] --> normalize[normalize<br/>3.0 / 3.1 / 3.2 → one model]
    normalize --> plan[plan transforms<br/>codecs, renames, flags]
  end
  plan --> format[(intermediate format<br/>plain JSON)]
  subgraph stage2 [Stage 2: src/emit]
    format --> emit[interfaces, validators,<br/>codecs, services, runtime]
  end
  emit --> write[src/write.ts<br/>safe write + version.json]
```

## Why two stages

Stage 1 makes every decision: which declaration a schema becomes, its final TypeScript name, which service an operation belongs to, which values a transform changes, and which declarations need validators. Stage 2 only formats those decisions as source text and never sees the OpenAPI document, its version, `$ref`s or the config.

The alternative, emitting code while walking the document, mixes the 3.0/3.1/3.2 differences, naming, transform rules and code formatting in one place, so a change to any of them can break the others.

- **Separate tests.** Stage 2 tests start from golden intermediate-format files (`test/golden/intermediate-format/`), so they keep passing while Stage 1 changes, and a Stage 1 change shows up as a reviewable diff of those files.
- **Inspectable.** The intermediate format is plain JSON (`--emit-intermediate-format`), and library users can change it between `buildIntermediateFormat` and `emit`.
- **Checked boundaries:**
  - `test/boundaries.test.ts` fails when a file under `src/emit/` imports anything from `src/intermediate-format/` other than its types.
  - `src/intermediate-format/intermediate-format.schema.json` is generated from `src/intermediate-format/types.ts`, every Stage 1 output in the tests validates against it, and `make lint` fails while the schema is stale.

## Stage 1 modules

| Module | Owns |
|---|---|
| `config.ts` | the config file, flags, defaults and their validation |
| `load.ts` | reading JSON/YAML and detecting the 3.x version |
| `overlay.ts` | OpenAPI Overlay 1.0 to 1.2 (RFC 9535 JSONPath via `jsonpath-rfc9535`) |
| `validate-spec.ts` | validation against the official schemas, and stripping 3.0 `$ref` siblings |
| `filter.ts` | operation filters and pruning of unused components |
| `refs.ts` | local `$ref` resolution |
| `normalize.ts` | every difference between 3.0, 3.1 and 3.2; declarations, names, services, operations |
| `naming.ts` | PascalCase, camelCase and kebab-case rules |
| `transform-plan.ts` | codecs, property renames, and the `transformed` and `runtime` flags |
| `build.ts` | the Stage 1 pipeline |

VERIFIED: spec validation uses `@hyperjump/json-schema`, because ajv 8.20 rejected valid 3.1 and 3.2 documents. The OpenAPI `schema-base` schemas rely on `$dynamicRef`, and in a probe ajv reported `unevaluatedProperties` failures for a minimal valid document, which hyperjump accepted.

## Stage 2 and the generated runtime

The generated validators and codecs are small expressions, for example `object({ id: { required: true, validator: number(true, {}) } })`, built from runtime modules that the generator copies into every client (`src/emit/runtime/`). Those modules are ordinary TypeScript in this repository, type-checked and tested directly, and `scripts/embed-runtime.ts` embeds their text into `src/emit/runtime-sources.ts` so the published package can copy them without reading its own source tree; `make lint` fails while that file is stale. Keeping the JSON Schema semantics in one hand-written runtime avoids generating and testing a separate checking routine for every schema; `test/validators.test.ts` compares the generated validators with `@hyperjump/json-schema` on sample values.

- **References are lazy** (`lazy(() => validatePet)`), so recursive schemas and import cycles between generated modules evaluate safely.
- **Namespaced runtimes:** `runtime/validation.ts` and `runtime/transform.ts` both export `array` and `lazy`, so files that use both import them as namespaces (`validation.array`, `transform.array`).
- **Types follow `transform`:** each service class is generic over a boolean type parameter that TypeScript infers from `transform: true`, and its methods return `Transform extends true ? AppType : WireType`.

VERIFIED: lossless int64 parsing relies on the JSON.parse reviver's source text, and writing a bigint relies on `JSON.rawJSON`. Probes on Node.js 24.20 and Bun 1.3.9 confirmed both. Without them, `bigint` refuses rounded values instead of passing them on, and sending a value beyond 2^53 throws. The test suite runs on Node.js and Bun only; no browser has been tested.

## Operations

- `make test` runs the unit and integration tests against real subsystems: generated code written to `tmp/` and imported, a live `Bun.serve` server, and the TypeScript compiler.
- `make e2e` packs the package, installs the tarball into a clean project with TypeScript 7.0.2, generates every spec in `examples/` with Node.js, type-checks each client with `strict` and `nodenext`, and compiles and runs `input/smoke.ts` against a Node.js mock server; results land in `output/`.
- `make bench` prints the stage timings on the Jira spec.
- `make intermediate-format-schema` and `make runtime-sources` regenerate the two checked-in generated files.

## Security and privacy

- **Untrusted input:** the OpenAPI document, overlays and config are untrusted input. Every identifier, string literal, comment and import path from them reaches generated code through `src/emit/names.ts` (`quote`, `propertyKey`, `docComment`, `identifier`); `test/names.test.ts` parses the output of hostile names and descriptions and checks that each stays one literal, member or comment. Spec values that are not numbers, booleans or strings are dropped from validator constraints instead of being pasted into code.
- **No data loss:** `src/write.ts` writes only into an empty directory or one holding earlier open-api-gen output. It recognizes that output by the generated-file header and by `version.json`, deletes only stale files it created itself, and stops at any other file unless `--force` is given; with `--force` a hand-written file at a generated path is overwritten, never one elsewhere. A symbolic link inside the directory always stops the run, so nothing outside it is written.
- **No network or secrets:** the generator makes no network requests and reads no environment variables; the generated `createFetchSend` sends only the headers the caller configures.
