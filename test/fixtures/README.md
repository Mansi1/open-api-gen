# Test fixtures

Small hand-written OpenAPI documents. Each one exists to exercise a specific set of features; the real-world specs live in `examples/`.

| Fixture | Valid | Covers |
|---|---|---|
| `petstore-3.0.yaml` | yes | 3.0 baseline: `nullable`, boolean `exclusiveMinimum`, `allOf` composition, enum component, path-level params, query/header params, int64, date-time, `default` response, 204 without body, servers with variables |
| `petstore-3.1.yaml` | yes | Same API in 3.1 form: `type: [string, 'null']`, numeric `exclusiveMinimum` |
| `features-3.1.json` | yes | `oneOf` + discriminator with `const`, recursive schema, `anyOf` with null, map via `additionalProperties`, `prefixItems` tuple, nullable int64, `$defs` ref, `$ref` with sibling, unsupported keywords (`if`/`then`/`not`), snake_case props with date, date-time, int64, multi-tag op, untagged op without `operationId`, tag name needing PascalCase, cookie param, urlencoded body, inline nested response object |
| `features-3.2.yaml` | yes | `query` method, `in: querystring`, `itemSchema` streaming (`application/jsonl`), `additionalOperations` (`PURGE`) |
| `errors-3.1.yaml` | yes | typed error responses (404 and 422 with distinct bodies, `default`), schemas named like runtime exports (`ApiError`, `RequestOptions`, `ServiceConfig`) |
| `security-3.1.yaml` | yes | every security scheme kind (http bearer, basic and custom, apiKey in header, query and cookie, oauth2, mutualTLS), document-level requirement, `security: []`, AND and OR requirements, optional `{}`, an undefined scheme name |
| `servers-3.1.yaml` | yes | path-level `servers` with a variable, operation-level `servers` overriding them, a relative operation server, an operation without its own servers |
| `read-write-only-3.0.yaml` | yes | required `readOnly` and `writeOnly` properties in schemas used as request and response bodies, also nested in an array and under a renamed (`created_at`) key |
| `webhooks-3.1.yaml` | yes | a webhook with int64, date-time, snake_case and a required `writeOnly` property; a webhook without `operationId` or body; an operation callback with a runtime expression |
| `optional-body-3.1.yaml` | yes | a 200 response with a body next to a 204 without one |
| `union-response-3.1.yaml` | yes | a `oneOf` response with a transformed member (`Event` with a date-time) and `null` |
| `multi-file/openapi.yaml` | yes | external `$ref` files: a path item, a parameter, a response and schemas in other files, a reference cycle across files, a file-local `#/$defs` reference, a reference back into the root document, example data with a `$ref` key |
| `collision-3.1.yaml` | yes | `user_id` and `userId` collide under camelCase |
| `invalid-3.1.yaml` | no | Schema Object with `type: 42` |
| `swagger-2.0.json` | no (unsupported) | Swagger 2.0 rejection |

Next to the documents:

- `overlays/petstore-rename.yaml` retitles `petstore-3.0.yaml` and removes its delete operation; `overlays/break-schema.yaml` makes `petstore-3.0.yaml` invalid, to prove that validation runs after overlays.
- `hooks/decimal.ts` is a user-defined transformer (int64 as a `Decimal` value object) for the transformer tests.
