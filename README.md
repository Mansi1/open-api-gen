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
import { createClient } from "./api/index.js";

// One call builds every service; baseUrl defaults to the document's first server.
const api = createClient({
  baseUrl: "https://api.example.com",
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
  timeout: 10_000,
  retry: 2,
});

// Wire values: exactly what the JSON contains.
const pet = await api.pets.getPet({ petId: 7 }); // pet.created_at: string

// App values: dates as Date, int64 as bigint, names in camelCase (with --naming camelCase), plus your hooks.
const appApi = createClient({ baseUrl: "https://api.example.com", transform: true, validate: true });
const appPet = await appApi.pets.getPet({ petId: 7 }); // appPet.createdAt: Date

// Per-call options always come last.
const controller = new AbortController();
await api.pets.listPets({ limit: 20 }, undefined, {
  signal: controller.signal,
  onResponse: (response) => console.log(response.headers.get("x-total-count")),
});
```

`createClient` returns one property per service, named after its tag (`PetsService` → `api.pets`, untagged operations → `api.default`). The service classes can also be created on their own: `new PetsService({ send: createFetchSend({ baseUrl }), transform: true })`.

Each operation is a method named after its `operationId`. Its arguments come in this order, each present only when the operation has it: `urlParameter`, `queryParameter`, `querystring` (OpenAPI 3.2), `headerParameter`, `cookieParameter`, `body`, and last the optional per-call `options`.

### Client options

`createClient` takes these options; `createFetchSend` takes the same options except `send`, `validate` and `transform`, and requires `baseUrl`.

| Option | Meaning |
|---|---|
| `baseUrl` | Prefix for every path. Defaults to the first entry of `servers`, with its variables at their defaults, or `/` when the document declares none |
| `auth` | Credentials by security scheme name (see [Auth](#auth)) |
| `headers` | Sent with every request; an object, or a function (may be async) called per attempt, e.g. for a token that expires |
| `timeout` | Milliseconds per attempt before it fails with a `TimeoutError` (default: no limit) |
| `retry` | A number of retries, or `{ retries, delay, maxDelay, statusCodes, methods }` (see below; default: no retries) |
| `middleware` | A list of `{ onRequest, onResponse }` hooks, run in order on every attempt (see below) |
| `init` | Further fetch settings for every request, e.g. `{ credentials: "include" }`, `{ cache: "no-store" }`, `{ keepalive: true }` |
| `fetch` | Your own fetch function (default: the global `fetch`); it receives a standard `Request` |
| `send` | Your own transport instead of `createFetchSend`; the transport options above then do nothing |
| `validate` | Check every response body against its schema and throw `ResponseValidationError` with a list of `{ path, message }` issues (JSON Pointer paths) |
| `transform` | Convert request bodies from App to wire form before sending, and response bodies from wire to App form after receiving. TypeScript infers `transform: true` from the call and switches every method to App types |

`servers` holds the document's servers, and `serverUrl(server, variables)` fills a server's `{variable}` templates, checking each value against the variable's `enum`:

```ts
import { createClient, serverUrl, servers } from "./api/index.js";

const api = createClient({ baseUrl: serverUrl(servers[1]!, { region: "eu" }) });
```

### Auth

`auth` takes one credential per security scheme of the document, keyed by the scheme's name in `components.securitySchemes`. The generated `ApiAuth` type lists the schemes:

```ts
const api = createClient({
  auth: {
    bearerAuth: async () => (await session()).accessToken, // http bearer, oauth2, openIdConnect
    basicAuth: { username: "ada", password: "secret" },    // http basic
    api_key: process.env.API_KEY,                          // apiKey in header, query or cookie
  },
});
```

A credential is a value or a function, which may be async and is called before each attempt; return `undefined` to send nothing. Each operation sends the credentials its `security` requirement names. That is the operation's own requirement, or the document's when the operation has none; `security: []` sends nothing. When a requirement lists alternatives, the first one with all of its credentials configured is used, and the schemes inside one alternative are all sent. Without a matching credential the request goes out without auth and the server answers. A per-call `authorization` header wins over `auth`.

| Scheme | Sent as |
|---|---|
| `apiKey` | the header, query parameter or cookie the scheme names |
| `http` with `bearer`, `oauth2`, `openIdConnect` | `Authorization: Bearer <token>` |
| `http` with `basic` | `Authorization: Basic <base64 of username:password>` (UTF-8) |
| `http` with any other scheme, e.g. `token` | `Authorization: Token <value>` |
| `mutualTLS` | nothing; client certificates belong to your fetch or runtime |

The client does not obtain tokens: running an OAuth flow and refreshing tokens is up to your credential function. A requirement naming a scheme the document does not define produces one warning and is ignored.

An operation or path item with its own `servers` uses the first of them instead of the client's `baseUrl`, as OpenAPI specifies. In the GitHub spec, release asset uploads go to `https://uploads.github.com`; in the Stripe spec, file uploads go to `https://files.stripe.com/`. A relative operation server such as `/legacy` is relative to where the document is served, which the client cannot know, so it resolves against the origin of the client's `baseUrl`. To send such an operation elsewhere, e.g. to a staging host, pass `baseUrl` per call.

### Per-call options

| Option | Meaning |
|---|---|
| `baseUrl` | Prefix for this call instead of the client's `baseUrl` and the operation's own server |
| `signal` | An `AbortSignal` that cancels the call, including retries and their waits |
| `timeout` | Overrides the client's timeout for this call |
| `headers` | Extra headers; they win over the client's headers and the operation's header parameters |
| `retry` | Overrides the client's retry settings; `false` turns retrying off for this call |
| `onResponse` | Called with the final `Response`, also an unsuccessful one, e.g. to read pagination or rate-limit headers. Clone it before reading the body |

### Retries

With `retry` set, a failed request is repeated when it ends in a network error, a timeout, or one of the `statusCodes` (default 408, 429, 500, 502, 503, 504). Only the idempotent `methods` are repeated by default: `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`, `QUERY`. A repeated `POST` could create a record twice; list it in `methods` only when the API makes it safe, for example with an idempotency key. The wait starts at `delay` (default 300 ms), doubles with each attempt and varies randomly between half and full length, up to `maxDelay` (default 10 s). A `Retry-After` header replaces the computed wait, still capped by `maxDelay`. Aborting through your own `signal` stops at once.

### Middleware

```ts
const api = createClient({
  middleware: [
    {
      onRequest: (request, details) => {
        console.log(`${details.operationId} → ${request.method} ${request.url}`);
        const headers = new Headers(request.headers);
        headers.set("x-request-id", crypto.randomUUID());
        return new Request(request, { headers });
      },
      onResponse: (response, request) => {
        console.log(`${request.url} ← ${response.status}`);
      },
    },
  ],
});
```

`onRequest` runs before each attempt and may return a replacement `Request`. `onResponse` runs on each answer, including unsuccessful ones, before retries and errors are handled, and may return a replacement `Response`, for example the result of repeating the request after refreshing a token. `details` is the `SendRequest` described below.

### Errors

- `ApiError`: the answer's status is outside 2xx. It carries `status`, the parsed `body`, the `Response` and the `operationId`.
- `ResponseValidationError`: only with `validate: true`. It carries `operationId`, `issues` and `body`.
- `TimeoutError` (a `DOMException`): an attempt ran longer than `timeout`. Your own abort rejects with the signal's reason.
- `TypeError`: a network failure, or a missing required path parameter.

`isApiError(error, operationId)` checks that `error` is an `ApiError` thrown by that operation. It then narrows `status` and `body` to the error responses the document declares for the operation:

```ts
import { isApiError } from "./api/index.js";

try {
  await api.things.getThing({ id });
} catch (error) {
  if (isApiError(error, "getThing")) {
    if (error.status === 404) {
      console.log(error.body.code); // body: the 404 response schema
    } else {
      console.log(error.body.fields); // body: the 422 response schema
    }
  }
}
```

`ApiErrors` maps every operationId to its error types, and each service file exports the same map for its own operations (`ThingsServiceErrors`). A `4XX`-style range or a `default` response has the status type `number`. An operation without declared error responses gets `ApiError<unknown, number>`. These types describe the document, not the server: error bodies are neither validated nor transformed, and a status the document does not declare still arrives at runtime with the declared types.

### The transport

`createFetchSend` serializes parameters by their OpenAPI `style` and `explode` settings. It encodes JSON, form-urlencoded, multipart and binary bodies, and reads JSON without losing int64 digits when `transform` is on. Streamed responses (OpenAPI 3.2 `itemSchema`: JSON Lines, NDJSON, JSON text sequences, Server-Sent Events) come back as an `AsyncIterable`, validated and converted item by item.

You can pass your own `send` instead. It receives a `SendRequest` with the dist3 fields `method`, `url` (the templated path, e.g. `/pets/{petId}`), `urlParameter`, `queryParameter`, `headerParameter`, `cookieParameter` and `body`. It also gets details such as `operationId`, `parameterStyles`, `responseContentTypes` and the per-call `options`, and resolves with the parsed response body.

## Generated files

```
api/
  index.ts                               services, wire types and the runtime API
  client.ts                              servers and createClient
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
