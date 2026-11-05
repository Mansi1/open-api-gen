# open-api-gen

Generates a TypeScript API client from an OpenAPI 3.0, 3.1 or 3.2 document (JSON or YAML). The output follows the layout of st-open-api's generated clients: one file per type, one service class per tag, and a `send` function you control. On top of that, a client can validate responses against their schemas and convert values between their JSON form and JavaScript types such as `Date` and `bigint`.

## Install and run

```bash
bun add -d open-api-gen          # or: npm install --save-dev open-api-gen
open-api-gen openapi.yaml -o src/api
```

The command reads `openapi.yaml`, validates it against the official OpenAPI schema for its version, and writes the client into `src/api/`. It needs Node.js 22 or later, or Bun.

The package is not on npm yet. Until it is, build a tarball with `bun run build && bun pm pack` and install that file instead.

| Option | Meaning |
|---|---|
| `-o, --output <dir>` | Output directory |
| `-c, --config <file>` | Read settings from a config file (see below); flags override it |
| `--overlay <file>` | Apply an [OpenAPI Overlay](https://spec.openapis.org/overlay/v1.2.0.html) before generating; repeatable |
| `--tag <tag>`, `--exclude-tag <tag>`, `--operation-id <id>` | Generate only part of the API; repeatable |
| `--naming <preserve\|camelCase>` | Property names in App types (default `preserve`) |
| `--transformer <key>=<type>,<import>,<decode>,<encode>` | Add a [transformer](#config-file), e.g. `schema:Filter=Filter,../hooks/filter.ts,decodeFilter,encodeFilter`; repeatable, replaces a config file transformer with the same key |
| `--no-validate-spec` | Skip validating the input document |
| `--force` | Write into a directory that holds files open-api-gen did not create |
| `--emit-intermediate-format <file>` | Also write the intermediate format as JSON (see [ARCH.md](ARCH.md)) |

Warnings and errors go to stderr, each line starting with an ISO 8601 timestamp and a level. The exit code is 1 when the document is invalid or generation fails.

## Using the client

```ts
import { PetsService, createFetchSend } from "./api/index.js";

const send = createFetchSend({ baseUrl: "https://api.example.com", headers: { authorization: `Bearer ${token}` } });

// Wire values: exactly what the JSON contains.
const pets = new PetsService({ send });
const pet = await pets.getPet({ petId: 7 }); // pet.created_at: string

// App values: dates as Date, int64 as bigint, names in camelCase (with --naming camelCase), plus your hooks.
const appPets = new PetsService({ send, transform: true, validate: true });
const appPet = await appPets.getPet({ petId: 7 }); // appPet.createdAt: Date
```

Each operation is a method named after its `operationId`. Its arguments come in this order, each present only when the operation has it: `urlParameter`, `queryParameter`, `querystring` (OpenAPI 3.2), `headerParameter`, `cookieParameter`, `body`.

The two client options are independent:

- **`validate: true`** checks every response body against its schema and throws `ResponseValidationError` with a list of `{ path, message }` issues (JSON Pointer paths).
- **`transform: true`** converts request bodies from App to wire form before sending, and response bodies from wire to App form after receiving. The method types switch with it: TypeScript infers `transform: true` from the constructor call and returns App types.

`createFetchSend` serializes parameters by their OpenAPI `style` and `explode` settings, encodes JSON, form-urlencoded, multipart and binary bodies, reads JSON without losing int64 digits when `transform` is on, and throws `ApiError` (with `status` and the parsed `body`) for responses outside 2xx. Streamed responses (OpenAPI 3.2 `itemSchema`: JSON Lines, NDJSON, JSON text sequences, Server-Sent Events) come back as an `AsyncIterable`, validated and converted item by item.

You can pass your own `send` instead. It receives the dist3 fields `method`, `url` (the templated path, e.g. `/pets/{petId}`), `urlParameter`, `queryParameter`, `headerParameter`, `cookieParameter` and `body`, plus details such as `operationId`, `parameterStyles` and `responseContentTypes`, and resolves with the parsed response body.

## Generated files

```
api/
  index.ts                               services, wire types and the runtime API
  interface/components/<Schema>.ts       one per schema, plus extracted inline enums and objects
  interface/request/<Operation>Request.ts
  interface/response/<Operation>Response.ts
  interface/parameter/<Operation>{Path,Query,Header,Cookie}Parameter.ts
  interface/app/<Schema>.ts              App types, only for schemas a transform changes
  interface/**/<Schema>.validate.ts      response validators, for schemas a request or response uses
  interface/**/<Schema>.codec.ts         wire ↔ App converters, for schemas a transform changes
  service/<tag>/<Tag>Service.ts          one class per tag; untagged operations go to DefaultService
  runtime/                               validation, conversion, JSON and fetch helpers (no dependencies)
  version.json, open-api.json, open-api.yaml, intermediate-format.json
```

Operations are grouped by their first tag. A tag becomes a PascalCase class name (`Issue custom field values (apps)` → `IssueCustomFieldValuesAppsService`, in the folder `issue-custom-field-values-apps`). Enums become a `<Name>Values` array declared `as const`, and the type is derived from it: `type Name = typeof NameValues[number]`. `open-api.json` and `open-api.yaml` hold the input document after overlays and filters. `version.json` records the generator version, the time, the effective config and every warning of the run as `{ pointer, message }` entries, where `pointer` is a JSON Pointer into the input document. `intermediate-format.json` is the intermediate format the client was generated from (see [ARCH.md](ARCH.md)); for large specs it is large too (40 MB for the GitHub REST spec).

The generator writes only into a directory that is empty or holds its own earlier output. Files it created earlier and no longer produces are deleted; any other file stops the run unless you pass `--force`. Even with `--force` such a file is never deleted, but one at a path the generator produces (for example `index.ts` or `version.json`) is overwritten. Folders are removed only when deleting a stale file empties them, and a symbolic link anywhere in the directory always stops the run.

## Config file

```json
{
  "input": "openapi.yaml",
  "output": "src/api",
  "validateSpec": true,
  "force": false,
  "overlay": ["overlays/rename.yaml"],
  "filter": { "tags": ["store"], "excludeTags": ["internal"], "operationIds": ["getOrderById"] },
  "naming": { "properties": "camelCase" },
  "formats": { "date-time": "Date", "date": "Date", "int64": "bigint" },
  "transformers": {
    "format:decimal": { "type": "Decimal", "import": "../decimal.ts", "decode": "toDecimal", "encode": "fromDecimal" },
    "schema:Money": { "type": "Money", "import": "my-money-package", "decode": "parseMoney", "encode": "formatMoney" }
  }
}
```

Paths in the file are relative to the file. Every key is optional except `input` and `output`; unknown keys are errors. The values shown for `validateSpec`, `force`, `naming` (`preserve` when absent) and `formats` are the defaults.

**Transforms** apply to request and response bodies, never to parameters, and only when a client is created with `transform: true`:

- `formats`: `date-time` and `date` become `Date` (a `date` is midnight UTC). `int64` becomes `bigint`; set it to `"number"` to keep numbers. Without `transform`, large int64 values lose precision in plain `JSON.parse`. With `transform`, an `int64` field beyond 2^53 arrives exact as a `bigint`; every other number field stays a `number`, as its App type says. Parameters accept `number | bigint` for int64 values.
- `naming.properties: "camelCase"` renames declared object properties (`first_name` → `firstName`) in both directions. Keys of maps (`additionalProperties`), enum values and discriminator values keep their wire spelling. Two properties of one object that map to the same name stop the run with an error.
- `transformers`: your own conversions. `format:<name>` applies to every value with that format, `schema:<Name>` to one component. A schema transformer wins over a format transformer, which wins over the built-in `formats`. `import` is a package name or a path relative to the output directory; keep hook modules outside the output directory, because files there that open-api-gen did not create stop the run.

**Filters** keep operations that have one of `tags`, that are listed in `operationIds` (when given), and that have none of `excludeTags`. Components that no kept operation reaches are removed.

## Supported OpenAPI features

| Version | Handled |
|---|---|
| 3.0 | `nullable`, boolean `exclusiveMinimum`/`exclusiveMaximum`; keys next to a `$ref` produce a warning and are ignored, as the specification requires |
| 3.1 | `type` arrays, `const`, `prefixItems` tuples, `$defs` references, keywords next to `$ref` (intersected with the target) |
| 3.2 | the `query` method, `additionalOperations` (custom methods such as `PURGE`), `in: querystring`, streamed responses with `itemSchema` |
| all | `allOf`, `oneOf` and `anyOf` with discriminators (explicit and implicit mapping), recursive schemas, maps, path-level parameters, every parameter style |

Response validators check `type`, `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`, `prefixItems`, the numeric, string and array bounds, `pattern`, `uniqueItems`, `allOf`, `anyOf` and `oneOf`. Formats are annotations, as in JSON Schema, except `date-time` and `date`, which are checked because the client converts them.

**Not supported:**

- Swagger 2.0 (convert it to 3.x first).
- `$ref` to other files or URLs.
- Request validation.
- Webhooks and callbacks.
- JavaScript output.

The keywords `if`/`then`/`else`, `not`, `patternProperties`, `dependentSchemas`, `dependentRequired`, `propertyNames`, `contains` and `unevaluated*` produce a warning and are ignored, so types and validation accept more than the schema does.


## Development

```bash
make setup     # install the pinned tools and dependencies
make test      # unit and integration tests (bun test)
make lint      # oxlint, tsc, and the generated-file staleness checks
make e2e       # pack, install into a clean project, generate every example, tsc --strict, run input/smoke.ts
make bench     # stage timings on the largest example
```

`examples/` holds real-world specs; `examples/well-known/` holds the official specs of GitHub (3.1), OpenAI (3.1), Stripe (3.0) and Twilio (3.0), downloaded on 2026-10-29. `make e2e` generates and type-checks a client for every one of them, twice into the same directory. `spec/` holds the OpenAPI and Overlay specifications and JSON Schemas used as references.
