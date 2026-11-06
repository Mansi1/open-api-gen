# open-api-gen

A command-line tool and library that generates a typed TypeScript API client from an OpenAPI 3.0, 3.1 or 3.2 document (JSON or YAML), for projects that call or receive calls from an HTTP API.

## TL;DR

Hand-written API clients drift from the API they call. open-api-gen generates both the types and a client that runs: it sends requests the way the document describes them, can check every body against its schema, and converts values such as dates and 64-bit integers into JavaScript types. The client has no dependencies and runs in Node.js, Bun, Chromium, Firefox and WebKit.

- One file per schema and one service class per tag, in the layout of st-open-api's generated clients (dist3), plus `createClient` for all services at once.
- Wire types (exactly the JSON) or App types (`Date`, exact `bigint` for int64, camelCase names, your own converters), switched by one option.
- Response and request validation against the document's schemas.
- Timeouts, retries with backoff, middleware, per-call `AbortSignal`, and credentials from the document's security schemes.
- Typed error bodies per operation, webhook and callback payload parsing, multi-file documents with external `$ref`s.

## Quick start

Requirements: Node.js 22 or later (the `engines` field of `package.json`), or Bun. The tests run on Node.js 24.20 and Bun 1.3.9.

The package is not on npm yet. Build it from this repository and install the tarball:

```bash
bun install && bun run build && bun pm pack     # writes open-api-gen-0.1.0.tgz
bun add -d ./open-api-gen-0.1.0.tgz             # or: npm install --save-dev ./open-api-gen-0.1.0.tgz
open-api-gen openapi.yaml -o src/api
```

The command validates `openapi.yaml` against the official OpenAPI schema for its version and writes the client into `src/api/`. On success it prints one line, such as `2026-11-06T01:31:03.633Z INFO generated 28 files into src/api`. Warnings and errors go to stderr in the same format; the exit code is 1 when the document is invalid or generation fails.

## Usage

The examples use `test/fixtures/petstore-3.0.yaml`: a `pets` tag with `listPets`, `getPet`, `createPet` and `deletePet`, and a `Pet` schema with an int64 `id` and a date-time `created_at`.

### Calling the API

```ts
import { createClient } from "./api/index.js";

const api = createClient({ baseUrl: "https://petstore.example.com" });
const pet = await api.pets.getPet({ petId: 7 });
pet.created_at; // string: wire values, exactly what the JSON contains

const appApi = createClient({ baseUrl: "https://petstore.example.com", transform: true, validate: true });
const appPet = await appApi.pets.getPet({ petId: 7 });
appPet.created_at; // Date
appPet.id;         // bigint, exact beyond 2^53
```

`createClient` returns one property per service, named after its tag: `PetsService` becomes `api.pets`, untagged operations go to `api.default`. Each operation is a method named after its `operationId`. Its arguments come in this order, each present only when the operation has it: `urlParameter`, `queryParameter`, `querystring` (OpenAPI 3.2), `headerParameter`, `cookieParameter`, `body`, and last the optional per-call `options`:

```ts
const controller = new AbortController();
const pets = await api.pets.listPets({ limit: 20, status: ["available"] }, undefined, {
  signal: controller.signal,
  onResponse: (response) => console.log(response.headers.get("x-total-count")),
});
```

TypeScript infers `transform: true` from the `createClient` call and switches every method to App types. The service classes also work on their own: `new PetsService({ send: createFetchSend({ baseUrl }), transform: true })`.

### Client options

`createClient` takes these options. `createFetchSend` takes the same ones except `send`, `validate`, `validateRequest` and `transform`, requires `baseUrl`, and applies `auth` only together with `securitySchemes`, which the client exports and `createClient` passes on by itself.

| Option | Meaning |
|---|---|
| `baseUrl` | Prefix for every path. Default: the document's first server, with its variables at their defaults, or `/` when it declares none |
| `auth` | Credentials by security scheme name, see [Auth](#auth) |
| `headers` | Sent with every request: an object, or a function (may be async) called before each attempt |
| `timeout` | Milliseconds per attempt before it fails with a `TimeoutError`. Default: no limit |
| `retry` | A number of retries, or `{ retries, delay, maxDelay, statusCodes, methods }`, see [Retries](#retries). Default: no retries |
| `middleware` | A list of `{ onRequest, onResponse }` hooks, see [Middleware](#middleware) |
| `init` | Further fetch settings for every request, such as `{ credentials: "include" }`, `{ cache: "no-store" }` or `{ keepalive: true }` |
| `fetch` | Your own fetch function, called with a standard `Request`. Default: the global `fetch` |
| `send` | Your own transport instead of `createFetchSend`; `baseUrl`, `auth`, `headers`, `timeout`, `retry`, `middleware`, `init` and `fetch` then have no effect, see [The transport and your own `send`](#the-transport-and-your-own-send) |
| `validate` | Check every response body against its schema; a mismatch throws `ResponseValidationError` |
| `validateRequest` | Check every request body against its schema before sending; a mismatch throws `RequestValidationError` and nothing is sent |
| `transform` | Convert request bodies from App to wire form and response bodies from wire to App form, see [Transforms](#transforms) |

### Per-call options

| Option | Meaning |
|---|---|
| `signal` | An `AbortSignal` that cancels the call, including retries and the waits between them |
| `timeout` | Replaces the client's `timeout` for this call |
| `headers` | Extra headers; they win over client headers, header parameters and `auth` |
| `retry` | Replaces the client's `retry` for this call; `false` turns retrying off |
| `baseUrl` | Prefix for this call instead of the client's `baseUrl` and the operation's own server |
| `onResponse` | Called with the final `Response`, successful or not, for example to read pagination or rate-limit headers. Clone it before reading the body |

### Servers

`servers` lists the document's servers, and `serverUrl(server, variables)` fills a server's `{variable}` templates, each value checked against the variable's `enum`:

```ts
import { createClient, serverUrl, servers } from "./api/index.js";

const api = createClient({ baseUrl: serverUrl(servers[0]!, { host: "127.0.0.1", port: "3000" }) });
```

An operation or path item with its own `servers` uses the first of them instead of the client's `baseUrl`, as OpenAPI specifies. In the GitHub spec, release asset uploads go to `https://uploads.github.com`; in the Stripe spec, file uploads go to `https://files.stripe.com/`. A relative operation server such as `/legacy` is relative to where the document is served, which a client cannot know, so it resolves against the origin of the client's `baseUrl`. The per-call `baseUrl` sends such an operation elsewhere, for example to a staging host.

### Auth

`auth` takes one credential per security scheme, keyed by the scheme's name in `components.securitySchemes`. The generated `ApiAuth` type lists the schemes of the document; for one with the schemes `bearerAuth`, `basicAuth` and `api_key`:

```ts
const api = createClient({
  auth: {
    bearerAuth: async () => (await session()).accessToken,
    basicAuth: { username: "ada", password: "secret" },
    api_key: process.env.API_KEY,
  },
});
```

A credential is a value or a function, which may be async and runs before each attempt; returning `undefined` sends nothing. Each operation sends the credentials its `security` requirement names: the operation's own, or the document's when the operation has none, and nothing for `security: []`. Of several alternatives, the first one whose credentials are all configured is used, with every scheme it lists; an empty alternative (`{}`, auth optional) does not stop a later configured one. Without a matching credential the request goes out without auth, and the server decides.

| Scheme | Sent as |
|---|---|
| `apiKey` | the header, query parameter or cookie the scheme names |
| `http` with `bearer`; `oauth2`; `openIdConnect` | `Authorization: Bearer <token>` |
| `http` with `basic` | `Authorization: Basic <base64 of username:password>`, UTF-8 encoded |
| `http` with another scheme, such as `token` | `Authorization: Token <value>` |
| `mutualTLS` | nothing; client certificates belong to your fetch or runtime |

The client does not obtain tokens: an OAuth flow and token refresh belong in your credential function. A requirement naming a scheme the document does not define produces one warning and is ignored.

### Retries

With `retry` set, a request is repeated when it ends in a network error, a timeout, or one of the `statusCodes` (default 408, 429, 500, 502, 503, 504). By default only the idempotent methods are repeated: `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE` and `QUERY`. A repeated `POST` could create a record twice, so list it in `methods` only when the API makes that safe, for example with an idempotency key. The wait starts at `delay` (default 300 ms), doubles with each attempt, varies randomly between half and full length, and stops growing at `maxDelay` (default 10 s). A `Retry-After` header replaces the computed wait, still capped by `maxDelay`. Aborting through your own `signal` stops at once.

### Middleware

```ts
const api = createClient({
  middleware: [
    {
      onRequest: (request, details) => {
        const headers = new Headers(request.headers);
        headers.set("x-request-id", crypto.randomUUID());
        console.log(`${details.operationId} → ${request.method} ${request.url}`);
        return new Request(request, { headers });
      },
      onResponse: (response, request) => {
        console.log(`${request.url} ← ${response.status}`);
      },
    },
  ],
});
```

`onRequest` runs before each attempt and may return a replacement `Request`. `onResponse` runs on each answer, successful or not, before retries and errors are handled, and may return a replacement `Response`, for example the result of repeating the request after refreshing a token. `details` is the `SendRequest` the operation produced.

### Errors

| Error | Thrown when | Carries |
|---|---|---|
| `ApiError` | the status is outside 2xx | `status`, parsed `body`, `response`, `operationId` |
| `ResponseValidationError` | `validate: true` and the response body does not match its schema | `operationId`, `issues`, `body` |
| `RequestValidationError` | `validateRequest: true` and the request body does not match; nothing was sent | `operationId`, `issues`, wire `body` |
| `TransformError` | `transform: true` and a value cannot be converted, such as an impossible date or an int64 the engine rounded | `path` |
| `TimeoutError` (`DOMException`) | an attempt ran longer than `timeout` | |
| your signal's reason | you aborted through `signal` | |
| `TypeError` | a network failure, or a required path parameter is missing | |

`issues` is a list of `{ path, message }` with JSON Pointer paths, such as `{ path: "/id", message: "must be a number, got string" }`.

`isApiError(error, operationId)` checks that `error` is an `ApiError` from that operation, then narrows `status` and `body` to the error responses the document declares for it. For an operation `getThing` with a 404 and a 422 response:

```ts
import { isApiError } from "./api/index.js";

try {
  await api.things.getThing({ id });
} catch (error) {
  if (isApiError(error, "getThing")) {
    if (error.status === 404) {
      console.log(error.body.code);   // the 404 response schema
    } else {
      console.log(error.body.fields); // the 422 response schema
    }
  }
}
```

`ApiErrors` maps every operationId to its error types, and each service file exports the same map for its operations (`ThingsServiceErrors`). A range such as `4XX` and a `default` response have the status type `number`; an operation without declared error responses gets `ApiError<unknown, number>`. These types describe the document, not the server: error bodies are neither validated nor transformed, and an undeclared status still arrives typed as a declared one.

### Validation

Validators check `type`, `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`, `prefixItems`, the numeric, string and array bounds, `pattern`, `uniqueItems`, `allOf`, `anyOf` and `oneOf`. Formats are annotations, as in JSON Schema, except `date-time` and `date`, which are checked because the client converts them. Request validation checks the body in wire form, after the conversion `transform` applies; parameters are checked by their TypeScript types only.

A required `readOnly` property is not required in a request body, because a client should not send it, and a required `writeOnly` property is not required in a response body, because a server should not return it. OpenAPI 3.0 specifies this; 3.1 and 3.2 leave it to the API, and the client applies the same rule to all three. The method types follow it: for an `Account` schema with a required `readOnly` `id` and a required `writeOnly` `password`, `createAccount` takes `Account$Request`, in which `id` is optional, and returns `Account$Response`, in which `password` is optional. Both are defined in `interface/read-write.ts` on top of `Account`, also through arrays, unions and `allOf`.

### Webhooks and callbacks

Webhooks (OpenAPI 3.1+) and operation callbacks are requests the API sends to your server. For documents that have them, the client contains `WebhookPayloads`, the payload type of each one keyed by operationId, and `parseWebhook` to read a payload in a request handler:

```ts
import { parseWebhook } from "./api/index.js";

// `app` stands for any server framework that hands over the request.
app.post("/hooks/pet-created", async (request) => {
  const pet = parseWebhook("onPetCreated", await request.text(), { validate: true, transform: true });
  pet.createdAt; // Date (generated with --naming camelCase)
});
```

`parseWebhook` takes the raw body as text or bytes, or an already parsed value. With `transform`, JSON is parsed losslessly and converted to App values. `validate: true` throws `WebhookValidationError` (`operationId`, `issues`, `body`) on a mismatch; a required `writeOnly` property may be absent, as in responses. Signatures are not checked: verify the request with the API's signing scheme before parsing.

A webhook or callback without an operationId gets one: `<method><WebhookName>` (`postHeartbeat`) or `<parentOperationId><CallbackName>` (`subscribeOnEvent`). operationIds are unique across operations, webhooks and callbacks; a duplicate gets a number and a warning.

### The transport and your own `send`

`createFetchSend` serializes parameters by their OpenAPI `style` and `explode` settings, encodes JSON, form-urlencoded, multipart and binary bodies, and reads JSON without losing int64 digits when `transform` is on. Streamed responses (OpenAPI 3.2 `itemSchema`: JSON Lines, NDJSON, JSON text sequences, Server-Sent Events) come back as an `AsyncIterable`, validated and converted item by item.

A `send` of your own replaces it. It receives a `SendRequest` with the dist3 fields `method`, `url` (the templated path, such as `/pets/{petId}`), `urlParameter`, `queryParameter`, `headerParameter`, `cookieParameter` and `body`, plus details such as `operationId`, `parameterStyles`, `responseContentTypes`, `security`, the operation's `server` and the per-call `options`. It resolves with the parsed response body.

### Use as a library

```ts
import { generate, loadConfig } from "open-api-gen";

const config = await loadConfig(undefined, { input: "openapi.yaml", output: "src/api", naming: { properties: "camelCase" } });
const { files, removed, warnings } = await generate(config); // writes into config.output, like the CLI
```

`loadConfig(configPath, flags)` reads an optional config file and applies `flags` over it, with the keys of the [config file](#config-file). `buildIntermediateFormat` and `emit` expose the two stages separately, so a program can change the intermediate format before code is written (see [ARCH.md](ARCH.md)).

## Configuration

### Command-line options

```
open-api-gen <input> -o <output-directory> [options]
```

`<input>` is the OpenAPI document. `-h` prints the help and `-v` the version.

| Option | Meaning |
|---|---|
| `-o, --output <dir>` | Output directory |
| `-c, --config <file>` | Read settings from a config file; flags override it |
| `--overlay <file>` | Apply an [OpenAPI Overlay](https://spec.openapis.org/overlay/v1.2.0.html) before generating; repeatable |
| `--tag <tag>`, `--exclude-tag <tag>`, `--operation-id <id>` | Generate only part of the API, see [Filters](#filters); repeatable |
| `--naming <preserve\|camelCase>` | Property names in App types. Default: `preserve` |
| `--transformer <key>=<type>,<import>,<decode>,<encode>` | Add a [transformer](#transforms), such as `schema:Filter=Filter,../hooks/filter.ts,decodeFilter,encodeFilter`; repeatable, and it replaces a config file transformer with the same key |
| `--ref-root <dir>` | Directory that external `$ref` files may come from. Default: the input document's directory |
| `--no-validate-spec` | Skip validating the input document |
| `--force` | Write into a directory that holds files open-api-gen did not create |
| `--emit-intermediate-format <file>` | Also write the intermediate format as JSON |

### Config file

```json
{
  "input": "openapi.yaml",
  "output": "src/api",
  "validateSpec": true,
  "force": false,
  "refRoot": ".",
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

Paths in the file are relative to the file. Every key is optional except `input` and `output`, and unknown keys are errors. The values shown for `validateSpec`, `force` and `formats` are the defaults; `naming.properties` defaults to `preserve`, and `refRoot` to the input document's directory (the `.` above widens it to the config file's directory).

### Transforms

Transforms apply to request and response bodies and to webhook payloads, never to parameters, and only with `transform: true`.

- **`formats`:** `date-time` and `date` become `Date` (a `date` is midnight UTC), and `int64` becomes `bigint`; `"string"` or `"number"` keeps the JSON type. Without `transform`, an int64 beyond 2^53 loses precision in plain `JSON.parse`. With it, such a value arrives exact as a `bigint`, and every other number stays a `number`, as its App type says. Parameters accept `number | bigint` for int64 values.
- **`naming.properties: "camelCase"`:** renames declared object properties (`first_name` → `firstName`) in both directions. Map keys (`additionalProperties`), enum values and discriminator values keep their wire spelling. Two properties of one object that map to the same name stop the run with an error.
- **`transformers`:** your own conversions. `format:<name>` applies to every value with that format, `schema:<Name>` to one component; a schema transformer wins over a format transformer, which wins over `formats`. `import` is a package name or a path relative to the output directory. Keep hook modules outside the output directory, because files there that open-api-gen did not create stop the run.

### Filters

Filters keep the operations that have one of `tags`, that `operationIds` lists (when given), and that have none of `excludeTags`. Components no kept operation reaches are removed. Webhooks are always kept; callbacks follow their operation.

### Multi-file documents

A document may reference other JSON or YAML files, such as `$ref: ./schemas/pet.yaml` or `$ref: ./common.yaml#/Error`. They are bundled into one document right after loading, so overlays, validation and filters see the bundled document, and the written `open-api.json` is self-contained.

- A referenced schema, parameter, response, request body, header, example, link or callback becomes a component, named after the pointer's last segment or the file name: `./schemas/pet.yaml` becomes the schema `pet` and the type `Pet`. Colliding names get a number (`pet2`), and a file referenced many times becomes one component.
- A reference that is the definition itself, such as `components/schemas/Pet: { $ref: ./pet.yaml }` or a path item `/pets: { $ref: ./paths/pets.yaml }`, is replaced by the file's content.
- Inside a referenced file, `#/…` points into that file. A reference back into the root document (`../openapi.yaml#/components/schemas/Error`) becomes a local one.
- Referenced files must lie in the input document's directory or below it, checked on real paths so a symbolic link cannot lead outside. `--ref-root` (config `refRoot`) allows a wider directory, such as `../shared` in a monorepo. URLs are not fetched.

## Generated files

```
api/
  index.ts                               services, wire types, createClient and the runtime API
  client.ts                              servers, securitySchemes, createClient, ApiErrors, isApiError
  webhooks.ts                            payload types and parseWebhook, when the document has webhooks or callbacks
  interface/components/<Schema>.ts       one per schema, plus extracted inline enums and objects
  interface/request/<Operation>Request.ts
  interface/response/<Operation>Response.ts
  interface/parameter/<Operation>{Path,Query,Header,Cookie}Parameter.ts
  interface/app/<Schema>.ts              App types, for schemas a transform changes
  interface/read-write.ts                request and response variants of schemas with required readOnly or writeOnly properties
  interface/**/<Schema>.validate.ts      validators, for schemas a body uses
  interface/**/<Schema>.codec.ts         wire ↔ App converters, for schemas a transform changes
  service/<tag>/<Tag>Service.ts          one class per tag; untagged operations go to DefaultService
  runtime/                               client, fetch, validation, conversion, JSON and webhook helpers, no dependencies
  version.json, open-api.json, open-api.yaml, intermediate-format.json
```

Operations are grouped by their first tag, and a tag becomes a PascalCase class name: `Issue custom field values (apps)` becomes `IssueCustomFieldValuesAppsService` in the folder `issue-custom-field-values-apps`. An enum becomes a `<Name>Values` array declared `as const`, with the type derived from it: `type Name = typeof NameValues[number]`.

- `open-api.json` and `open-api.yaml` hold the input document after bundling, overlays and filters.
- `version.json` records the generator version, the time, the effective config and every warning of the run as `{ pointer, message }`, where `pointer` is a JSON Pointer into the bundled input document.
- `intermediate-format.json` is the intermediate format the client was generated from; for the GitHub REST spec, as `make e2e` generates it, it is 40 MB.

The generator writes only into a directory that is empty or holds its own earlier output. Files it created before and no longer produces are deleted; any other file stops the run unless `--force` is given. Even with `--force` such a file is never deleted, but one at a path the generator produces, such as `index.ts`, is overwritten. A folder is removed only when deleting a stale file empties it, and a symbolic link anywhere in the directory stops the run.

## Supported OpenAPI features

| Version | Handled |
|---|---|
| 3.0 | `nullable`, boolean `exclusiveMinimum`/`exclusiveMaximum`; keys next to a `$ref` produce a warning and are ignored, as the specification requires |
| 3.1 | `type` arrays, `const`, `prefixItems` tuples, `$defs` references, keywords next to `$ref` (intersected with the target), webhooks |
| 3.2 | the `query` method, `additionalOperations` (custom methods such as `PURGE`), `in: querystring`, streamed responses with `itemSchema` |
| all | `allOf`, `oneOf` and `anyOf` with discriminators (explicit and implicit mapping), recursive schemas, maps, path-level parameters, every parameter style, security schemes, operation and path servers, callbacks, external `$ref` files |

The generated client is tested on Node.js 24.20 and Bun 1.3.9, and in Chromium 158, Firefox 159 and WebKit 27.2. Exact int64 values need the `JSON.parse` reviver's source text and `JSON.rawJSON`; in an engine without them, receiving such a value in `transform` mode yields an error instead of a rounded number, and sending one throws.

**Not supported:**

- Swagger 2.0: convert the document to 3.x first.
- `$ref` to URLs: download the file and reference it by path.
- JavaScript output.
- The keywords `if`/`then`/`else`, `not`, `patternProperties`, `dependentSchemas`, `dependentRequired`, `propertyNames`, `contains` and `unevaluated*`: ignored with a warning, so types and validation accept more than the schema does.

## How it works

Stage 1 loads the document, bundles external references, applies overlays, validates and filters it, and reduces it to a plain-JSON intermediate format in which every naming and typing decision is made. Stage 2 turns that format into source files and copies the hand-written runtime next to them. [ARCH.md](ARCH.md) explains the design.

## Development

```bash
make setup && make verify
```

| Verb | What it does |
|---|---|
| `make setup` | installs the pinned tools (`mise.toml`), the locked dependencies and the Playwright browsers |
| `make test` | runs the unit and integration tests (`bun test`) against generated code, a live `Bun.serve` server and the TypeScript compiler |
| `make lint` | runs oxlint and `tsc`, and checks that the generated schema and runtime sources are current |
| `make e2e` | packs the package, installs it into a clean project, generates and type-checks a client for every example, runs `input/smoke.ts` on Node.js, then `input/browser-smoke.ts` in Chromium, Firefox and WebKit |
| `make bench` | prints the stage timings on the Jira spec |
| `make verify` | runs lint, test, coverage and e2e |

`examples/` holds real-world specs, and `examples/well-known/` the official specs of GitHub (3.1), OpenAI (3.1), Stripe (3.0) and Twilio (3.0), downloaded on 2026-10-29. `make e2e` generates each of them twice into the same directory. `spec/` holds the OpenAPI and Overlay specifications and JSON Schemas used as references. [ARCH.md](ARCH.md) is the place to start reading the code.

## License

MIT, as declared in `package.json`.
