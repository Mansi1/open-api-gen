import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emit } from "../src/emit/index.ts";
import { buildIntermediateFormat } from "../src/intermediate-format/build.ts";
import { loadConfig, type ConfigInput } from "../src/intermediate-format/config.ts";
import { typeCheck } from "./support/type-check.ts";

const repositoryRoot = join(import.meta.dir, "..");

type RecordedRequest = { method: string; path: string; query: string; headers: Record<string, string>; body: string };
const recorded: RecordedRequest[] = [];
const lastRequest = () => recorded[recorded.length - 1]!;
const requestsTo = (path: string) => recorded.filter((request) => request.path === path);
const attemptsByPath = new Map<string, number>();

// A real HTTP server on a free port; each route answers like the fixture APIs would.
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

const wirePetText = '{"id":9007199254740993,"name":"Rex","created_at":"2026-01-02T03:04:05.000Z","status":"available","tag":null}';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      recorded.push({ method: request.method, path: url.pathname, query: url.search, headers: Object.fromEntries(request.headers), body: await request.text() });
      const json = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "application/json", "x-rate-limit-remaining": "41" } });
      if (request.headers.get("x-fail") === "503") {
        return new Response("busy", { status: 503 });
      }
      if (url.pathname.startsWith("/pets/flaky-")) {
        // Busy twice, then answers: the retry tests count the attempts.
        const attempts = (attemptsByPath.get(url.pathname) ?? 0) + 1;
        attemptsByPath.set(url.pathname, attempts);
        if (attempts <= 2) {
          return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
        }
        return json(wirePetText);
      }
      if (url.pathname === "/pets/slow") {
        await Bun.sleep(300);
        return json(wirePetText);
      }
      if (url.pathname === "/accounts" && request.method === "POST") {
        // Answers like a real server: the id is assigned, the password is never sent back.
        const sent = JSON.parse(recorded[recorded.length - 1]!.body) as { name: string };
        return json(JSON.stringify({ id: 1, name: sent.name, created_at: "2026-01-02T03:04:05.000Z" }), 201);
      }
      if (url.pathname === "/legacy/status") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith("/secure/")) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/things/missing") {
        return json('{"code":"missing"}', 404);
      }
      if (url.pathname === "/things/bad%20id") {
        return json('{"fields":["id"]}', 422);
      }
      if (url.pathname === "/pets/404") {
        return json('{"code":404,"message":"no such pet"}', 404);
      }
      if (url.pathname === "/pets/1" && request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/pets/broken") {
        return json('{"id":"not a number","name":"Rex","created_at":"2026-01-02T03:04:05.000Z"}');
      }
      if (url.pathname.startsWith("/pets/")) {
        return json(wirePetText);
      }
      if (url.pathname === "/pets" && request.method === "POST") {
        return json(wirePetText, 201);
      }
      if (url.pathname === "/pets") {
        return json(`[${wirePetText}]`);
      }
      if (url.pathname === "/items/stream") {
        const lines = '{"id":"a","updated_at":"2026-01-02T03:04:05.000Z"}\n{"id":"b"}\n';
        return new Response(lines, { headers: { "content-type": "application/jsonl" } });
      }
      if (url.pathname === "/search" || url.pathname === "/items") {
        return json('[{"id":"a"}]');
      }
      if (url.pathname.startsWith("/items/")) {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

/** Stage 1 + Stage 2, written to tmp/generated/<name>/, and the generated index module imported. */
async function generateClient(input: string, name: string, flags: ConfigInput = {}): Promise<{ client: any; directory: string; files: Map<string, string> }> {
  const intermediateFormat = await buildIntermediateFormat(await loadConfig(undefined, { input, output: "out", ...flags }));
  const files = emit(intermediateFormat);
  const directory = join(repositoryRoot, "tmp", "generated", name);
  rmSync(directory, { recursive: true, force: true });
  for (const [path, content] of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return { client: await import(join(directory, "index.ts")), directory, files };
}

describe("generated services against a live server", () => {
  test("wire shape: plain JSON values, path, query arrays and headers serialized", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "services-wire");
    const pets = new client.PetsService({ send: client.createFetchSend({ baseUrl }) });
    const list = await pets.listPets({ limit: 5, status: ["available", "sold"] }, { "X-Request-Id": "abc" });
    expect(lastRequest()).toMatchObject({ method: "GET", path: "/pets", query: "?limit=5&status=available&status=sold" });
    expect(lastRequest().headers["x-request-id"]).toBe("abc");
    expect(lastRequest().headers.accept).toBe("application/json");
    // Without transform, values stay as JSON gives them (the int64 is rounded by plain JSON.parse).
    expect(list[0].created_at).toBe("2026-01-02T03:04:05.000Z");
    expect(typeof list[0].id).toBe("number");
  });

  test("transform shape: Date, exact bigint, camelCase both ways", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "services-app", { naming: { properties: "camelCase" } });
    const pets = new client.PetsService({ send: client.createFetchSend({ baseUrl }), transform: true });
    const pet = await pets.getPet({ petId: 7 });
    expect(lastRequest().path).toBe("/pets/7");
    expect(pet.createdAt).toEqual(new Date("2026-01-02T03:04:05.000Z"));
    expect(pet.id).toBe(9007199254740993n);
    expect("created_at" in pet).toBe(false);

    await pets.createPet({ name: "Rex", status: "available" });
    expect(lastRequest()).toMatchObject({ method: "POST", path: "/pets", body: '{"name":"Rex","status":"available"}' });
    expect(lastRequest().headers["content-type"]).toBe("application/json");
  });

  // Regression: the lossless parse turned every integer beyond 2^53 into a bigint, also where the App type says number.
  test("transform with int64 as number: a large integer arrives as a number, as the App type says", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "services-int64-number", { formats: { int64: "number" } });
    const pets = new client.PetsService({ send: client.createFetchSend({ baseUrl }), validate: true, transform: true });
    const pet = await pets.getPet({ petId: 7 });
    expect(pet.id).toBe(9007199254740992);
    expect(pet.created_at).toEqual(new Date("2026-01-02T03:04:05.000Z"));
    const [listed] = await pets.listPets();
    expect(typeof listed.id).toBe("number");
  });

  test("validate × transform: invalid bodies throw only with validate, Date only with transform", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "services-matrix");
    const send = client.createFetchSend({ baseUrl });
    for (const validate of [false, true]) {
      for (const transform of [false, true]) {
        const pets = new client.PetsService({ send, validate, transform });
        const pet = await pets.getPet({ petId: 1 });
        expect({ validate, transform, isDate: pet.created_at instanceof Date }).toEqual({ validate, transform, isDate: transform });
        const broken = pets.getPet({ petId: "broken" });
        if (validate) {
          await expect(broken).rejects.toBeInstanceOf(client.ResponseValidationError);
          await expect(pets.getPet({ petId: "broken" })).rejects.toThrow("/id: must be a number, got string");
        } else {
          expect((await broken).id).toBe("not a number");
        }
      }
    }
  });

  test("non-2xx answers throw ApiError with the parsed body; 204 resolves to undefined", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "services-errors");
    const pets = new client.PetsService({ send: client.createFetchSend({ baseUrl }) });
    const error = await pets.getPet({ petId: 404 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(client.ApiError);
    expect(error).toMatchObject({ status: 404, body: { code: 404, message: "no such pet" } });
    expect(await pets.deletePet({ petId: 1 })).toBeUndefined();
    expect(lastRequest().method).toBe("DELETE");
  });

  test("a hand-written dist3-style send keeps working", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "services-dist3-send");
    const seen: unknown[] = [];
    // The dist3 contract: send({ method, url, urlParameter, queryParameter, headerParameter, body }) → parsed body.
    const send = async (request: { method: string; url: string; urlParameter: Record<string, unknown> }) => {
      seen.push({ method: request.method, url: request.url, urlParameter: request.urlParameter });
      return JSON.parse(wirePetText);
    };
    const pets = new client.PetsService({ send });
    expect((await pets.getPet({ petId: 3 })).name).toBe("Rex");
    expect(seen).toEqual([{ method: "GET", url: "/pets/{petId}", urlParameter: { petId: 3 } }]);
  });

  test("3.2: QUERY method, custom PURGE method, querystring, JSON Lines stream", async () => {
    const { client } = await generateClient("test/fixtures/features-3.2.yaml", "services-3-2");
    const search = new client.SearchService({ send: client.createFetchSend({ baseUrl }), transform: true, validate: true });
    await search.searchItems({ text: "lamp" });
    expect(lastRequest()).toMatchObject({ method: "QUERY", path: "/search", body: '{"text":"lamp"}' });
    await search.listItems({ owner: "ada", page: 2 });
    expect(lastRequest()).toMatchObject({ method: "GET", path: "/items", query: "?owner=ada&page=2" });
    await search.purgeItem({ id: "a/b" });
    expect(lastRequest()).toMatchObject({ method: "PURGE", path: "/items/a%2Fb" });
    const items: { id: string; updated_at?: Date }[] = [];
    for await (const item of await search.streamItems()) {
      items.push(item);
    }
    expect(items).toEqual([{ id: "a", updated_at: new Date("2026-01-02T03:04:05.000Z") }, { id: "b" }]);
  });

  test("cookies and urlencoded bodies", async () => {
    const { client } = await generateClient("test/fixtures/features-3.1.json", "services-cookie");
    const shapes = new client.ShapesService({ send: client.createFetchSend({ baseUrl }) });
    await shapes.getShape({ shape_id: "round-1" }, { session: "s1" }).catch(() => undefined);
    expect(lastRequest()).toMatchObject({ path: "/shapes/round-1" });
    expect(lastRequest().headers.cookie).toBe("session=s1");
    const fallback = new client.DefaultService({ send: client.createFetchSend({ baseUrl }) });
    await fallback.putUntagged({ q: "a b&c" }).catch(() => undefined);
    expect(lastRequest()).toMatchObject({ method: "PUT", path: "/untagged", body: "q=a+b%26c" });
    expect(lastRequest().headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });
});

describe("createClient and servers", () => {
  test("baseUrl defaults to the first server with its variable defaults; serverUrl fills and checks variables", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "client-servers");
    expect(client.servers.map((server: { url: string }) => server.url)).toEqual(["http://{host}:{port}", "https://petstore.example.com"]);
    expect(client.serverUrl(client.servers[0])).toBe("http://localhost:8080");
    expect(client.serverUrl(client.servers[0], { host: "127.0.0.1", port: "3000" })).toBe("http://127.0.0.1:3000");
    expect(() => client.serverUrl(client.servers[0], { host: "example.org" })).toThrow('variable "host" must be one of localhost, 127.0.0.1');

    const fetchedUrls: string[] = [];
    const recordingFetch = async (request: Request) => {
      fetchedUrls.push(request.url);
      return new Response(wirePetText, { headers: { "content-type": "application/json" } });
    };
    const api = client.createClient({ fetch: recordingFetch });
    await api.pets.getPet({ petId: 7 });
    expect(fetchedUrls).toEqual(["http://localhost:8080/pets/7"]);
  });

  test("one configuration for every service: transport options, validate and transform", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "client-live");
    const api = client.createClient({ baseUrl: client.serverUrl(client.servers[0], { port: String(server.port) }), headers: { authorization: "Bearer t" }, transform: true, validate: true });
    const pet = await api.pets.getPet({ petId: 7 });
    expect(pet.created_at).toEqual(new Date("2026-01-02T03:04:05.000Z"));
    expect(lastRequest().headers.authorization).toBe("Bearer t");
    await expect(api.pets.getPet({ petId: "broken" })).rejects.toBeInstanceOf(client.ResponseValidationError);

    const seen: string[] = [];
    const custom = client.createClient({ send: async (request: { operationId: string }) => {
      seen.push(request.operationId);
      return JSON.parse(wirePetText);
    } });
    await custom.pets.getPet({ petId: 1 });
    expect(seen).toEqual(["getPet"]);
  });
});

describe("transport options", () => {
  test("per-call options: headers win, onResponse reads response headers, a custom send receives them", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "options-call");
    const pets = new client.PetsService({ send: client.createFetchSend({ baseUrl, headers: { "x-client": "default", "x-trace": "client" } }) });
    const remainingSeen: (string | null)[] = [];
    await pets.listPets({ limit: 1 }, { "X-Request-Id": "from-parameter" }, {
      headers: { "x-trace": "call", "x-request-id": "from-options" },
      onResponse: (response: Response) => {
        remainingSeen.push(response.headers.get("x-rate-limit-remaining"));
      },
    });
    expect(lastRequest().headers).toMatchObject({ "x-client": "default", "x-trace": "call", "x-request-id": "from-options" });
    expect(remainingSeen).toEqual(["41"]);

    const optionsSeen: unknown[] = [];
    const custom = new client.PetsService({ send: async (request: { options?: unknown }) => {
      optionsSeen.push(request.options);
      return JSON.parse(wirePetText);
    } });
    await custom.getPet({ petId: 1 }, { timeout: 5 });
    await custom.getPet({ petId: 1 });
    expect(optionsSeen).toEqual([{ timeout: 5 }, undefined]);
  });

  test("timeout and signal: a slow answer fails with TimeoutError, an aborted call with the abort reason", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "options-abort");
    const pets = new client.PetsService({ send: client.createFetchSend({ baseUrl, timeout: 50 }) });
    const timedOut = await pets.getPet({ petId: "slow" }).catch((caught: unknown) => caught);
    expect((timedOut as Error).name).toBe("TimeoutError");
    // The call's own timeout overrides the client's.
    expect((await pets.getPet({ petId: "slow" }, { timeout: 2000 })).name).toBe("Rex");

    const controller = new AbortController();
    controller.abort(new Error("user left the page"));
    await expect(pets.getPet({ petId: 7 }, { signal: controller.signal })).rejects.toThrow("user left the page");
  });

  test("retry: idempotent requests repeat on 503 honoring Retry-After; POST and retry: false do not", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "options-retry");
    const pets = new client.PetsService({ send: client.createFetchSend({ baseUrl, retry: { retries: 2, delay: 1 } }) });
    expect((await pets.getPet({ petId: "flaky-get" })).name).toBe("Rex");
    expect(requestsTo("/pets/flaky-get")).toHaveLength(3);

    const noRetry = await pets.getPet({ petId: "flaky-off" }, { retry: false }).catch((caught: unknown) => caught);
    expect(noRetry).toMatchObject({ status: 503, operationId: "getPet" });
    expect(requestsTo("/pets/flaky-off")).toHaveLength(1);

    const before = requestsTo("/pets").length;
    const post = await pets.createPet({ name: "Rex", status: "available" }, { headers: { "x-fail": "503" } }).catch((caught: unknown) => caught);
    expect(post).toBeInstanceOf(client.ApiError);
    expect(requestsTo("/pets").length - before).toBe(1);
    expect((post as Error).message).toStartWith("createPet: ");
  });

  test("retry: network errors are retried with backoff, then thrown", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "options-retry-network");
    let attempts = 0;
    const failingFetch = async () => {
      attempts++;
      throw new TypeError("connection refused");
    };
    const pets = new client.PetsService({ send: client.createFetchSend({ baseUrl, fetch: failingFetch, retry: { retries: 3, delay: 1 } }) });
    await expect(pets.getPet({ petId: 7 })).rejects.toThrow("connection refused");
    expect(attempts).toBe(4);
  });

  // Regression: cancelling a body that middleware left locked rejected, so a retryable 503 was thrown instead of retried.
  test("retry: a busy answer whose body middleware keeps locked is still retried", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "options-retry-locked-body");
    const middleware = [
      {
        onResponse: (response: Response) => {
          if (response.status === 503) {
            response.body?.getReader();
          }
        },
      },
    ];
    const pets = new client.PetsService({ send: client.createFetchSend({ baseUrl, middleware, retry: { retries: 2, delay: 1 } }) });
    expect((await pets.getPet({ petId: "flaky-locked" })).name).toBe("Rex");
    expect(requestsTo("/pets/flaky-locked")).toHaveLength(3);
  });

  test("middleware: onRequest replaces the request per attempt, onResponse sees every answer in order", async () => {
    const { client } = await generateClient("test/fixtures/petstore-3.0.yaml", "options-middleware");
    const events: string[] = [];
    let token = 0;
    const middleware = [
      {
        onRequest: (request: Request, details: { operationId: string }) => {
          token++;
          events.push(`request ${details.operationId}`);
          const headers = new Headers(request.headers);
          headers.set("authorization", `Bearer ${token}`);
          return new Request(request, { headers });
        },
      },
      { onResponse: (response: Response) => void events.push(`response ${response.status}`) },
    ];
    const pets = new client.PetsService({ send: client.createFetchSend({ baseUrl, middleware, retry: { retries: 2, delay: 1 } }) });
    await pets.getPet({ petId: "flaky-middleware" });
    expect(events).toEqual(["request getPet", "response 503", "request getPet", "response 503", "request getPet", "response 200"]);
    expect(lastRequest().headers.authorization).toBe("Bearer 3");
  });
});

describe("typed errors", () => {
  test("isApiError checks the operation at runtime and exposes the declared status and body", async () => {
    const { client } = await generateClient("test/fixtures/errors-3.1.yaml", "errors-live");
    const api = client.createClient({ baseUrl });
    const missing = await api.things.getThing({ id: "missing" }).catch((caught: unknown) => caught);
    expect(client.isApiError(missing, "getThing")).toBe(true);
    expect(missing).toMatchObject({ status: 404, body: { code: "missing" }, operationId: "getThing" });
    expect(client.isApiError(missing, "putThing")).toBe(false);
    const invalid = await api.things.getThing({ id: "bad id" }).catch((caught: unknown) => caught);
    expect(invalid).toMatchObject({ status: 422, body: { fields: ["id"] } });
    expect(client.isApiError(new Error("network down"), "getThing")).toBe(false);
  });

  test("the status narrows the body type; undeclared statuses and operationIds do not compile; runtime names never clash with schemas", async () => {
    const { files } = await generateClient("test/fixtures/errors-3.1.yaml", "errors-types");
    const usage = `import { createClient, isApiError } from './index.js';
export async function use(): Promise<void> {
    const api = createClient({ baseUrl: 'http://localhost' });
    try {
        await api.things.getThing({ id: '1' });
    } catch (error) {
        if (isApiError(error, 'getThing')) {
            if (error.status === 404) {
                const code: string = error.body.code;
                void code;
            } else {
                const fields: string[] = error.body.fields;
                void fields;
            }
            // @ts-expect-error 418 is not a declared status of getThing
            void (error.status === 418);
        }
        if (isApiError(error, 'putThing')) {
            const message: string = error.body.message;
            const status: number = error.status;
            void [message, status];
        }
        // @ts-expect-error no such operationId
        void isApiError(error, 'getNothing');
    }
}
`;
    expect(typeCheck(files, "errors-types", { "usage.ts": usage })).toEqual([]);
  });
});

describe("auth from security schemes", () => {
  test("each operation sends the credentials its requirements name: inherited, none, AND, OR, optional, custom scheme", async () => {
    const { client } = await generateClient("test/fixtures/security-3.1.yaml", "auth-live");
    let token: string | undefined = "t1";
    const api = client.createClient({
      baseUrl,
      auth: {
        bearerAuth: async () => token,
        apiKeyHeader: "header-key",
        apiKeyQuery: "query key",
        apiKeyCookie: "s1",
        oauth: "oauth-token",
        tokenAuth: "abc",
      },
    });

    await api.secure.whoAmI();
    expect(lastRequest().headers.authorization).toBe("Bearer t1");
    token = undefined;
    await api.secure.whoAmI();
    expect(lastRequest().headers.authorization).toBeUndefined();

    await api.secure.getPublic();
    expect(lastRequest().headers.authorization).toBeUndefined();

    await api.secure.getWithBothKeys();
    expect(lastRequest()).toMatchObject({ path: "/secure/keys", query: "?api_key=query%20key" });
    expect(lastRequest().headers["x-api-key"]).toBe("header-key");

    // OR: basic is first but has no credential, so the session cookie is sent.
    await api.secure.getWithEither();
    expect(lastRequest().headers.cookie).toBe("session=s1");
    expect(lastRequest().headers.authorization).toBeUndefined();

    // Optional ({} first): a configured OAuth token is still sent.
    await api.secure.getOptional();
    expect(lastRequest().headers.authorization).toBe("Bearer oauth-token");

    await api.secure.getWithCustomScheme();
    expect(lastRequest().headers.authorization).toBe("Token abc");

    // A per-call header wins over auth.
    token = "t2";
    await api.secure.whoAmI({ headers: { authorization: "Bearer override" } });
    expect(lastRequest().headers.authorization).toBe("Bearer override");
  });

  test("basic credentials are UTF-8 base64; mutual TLS needs no credential; an undefined scheme warns and sends nothing", async () => {
    const { client } = await generateClient("test/fixtures/security-3.1.yaml", "auth-basic");
    const api = client.createClient({ baseUrl, auth: { basicAuth: { username: "ada", password: "pä" }, apiKeyCookie: "s1" } });
    await api.secure.getWithEither();
    expect(lastRequest().headers.authorization).toBe(`Basic ${Buffer.from("ada:pä", "utf8").toString("base64")}`);
    expect(lastRequest().headers.cookie).toBeUndefined();

    // tokenAuth has no credential; the mutual TLS alternative is satisfied without one and adds no header.
    await api.secure.getWithCustomScheme();
    expect(lastRequest().headers.authorization).toBeUndefined();

    await api.secure.getWithUndefinedScheme();
    expect(lastRequest().headers.authorization).toBeUndefined();
    const intermediateFormat = await buildIntermediateFormat(await loadConfig(undefined, { input: "test/fixtures/security-3.1.yaml", output: "out" }));
    expect(intermediateFormat.warnings).toContainEqual({ pointer: "/paths/~1secure~1undefined/get", message: 'security requirement names undefined scheme "nope"; alternatives naming it are ignored here and everywhere else' });
    const operations = intermediateFormat.services[0]!.operations;
    expect(Object.fromEntries(operations.map((operation) => [operation.operationId, operation.security]))).toEqual({
      whoAmI: [["bearerAuth"]],
      getPublic: [],
      getWithBothKeys: [["apiKeyHeader", "apiKeyQuery"]],
      getWithEither: [["basicAuth"], ["apiKeyCookie"]],
      getOptional: [[], ["oauth"]],
      getWithCustomScheme: [["tokenAuth"], ["mtls"]],
      getWithUndefinedScheme: [],
    });
  });

  test("ApiAuth is typed per scheme: basic takes username and password, unknown scheme names do not compile", async () => {
    const { files } = await generateClient("test/fixtures/security-3.1.yaml", "auth-types");
    const usage = `import { createClient, type ApiAuth } from './index.js';
const auth: ApiAuth = { bearerAuth: async () => 'token', basicAuth: { username: 'ada', password: 'secret' }, apiKeyQuery: () => undefined };
export const api = createClient({ baseUrl: 'http://localhost', auth });
// @ts-expect-error basic needs username and password
export const wrongBasic = createClient({ auth: { basicAuth: 'secret' } });
// @ts-expect-error no such security scheme
export const unknownScheme = createClient({ auth: { nope: 'x' } });
// @ts-expect-error mutual TLS takes no credential
export const mutualTls = createClient({ auth: { mtls: 'x' } });
`;
    expect(typeCheck(files, "auth-types", { "usage.ts": usage })).toEqual([]);
  });
});

describe("operation and path servers", () => {
  test("an operation's own server, else its path's, replaces the client baseUrl; a per-call baseUrl wins over both", async () => {
    const { client } = await generateClient("test/fixtures/servers-3.1.yaml", "servers-operation");
    const fetchedUrls: string[] = [];
    const recordingFetch = async (request: Request) => {
      fetchedUrls.push(request.url);
      return new Response(null, { status: 204 });
    };
    const api = client.createClient({ fetch: recordingFetch });
    await api.files.listFiles();
    await api.files.uploadFile();
    await api.files.ping();
    await api.files.listFiles({ baseUrl: "https://staging.example.com" });
    expect(fetchedUrls).toEqual([
      "https://uploads.example.com/v2/files",
      "https://bulk.example.com/files",
      "https://api.example.com/ping",
      "https://staging.example.com/files",
    ]);
  });

  test("a relative operation server resolves against the origin of the client baseUrl", async () => {
    const { client } = await generateClient("test/fixtures/servers-3.1.yaml", "servers-relative");
    const api = client.createClient({ baseUrl: `${baseUrl}/api/v1` });
    await api.files.getStatus();
    expect(lastRequest().path).toBe("/legacy/status");
  });
});

describe("request validation", () => {
  test("an invalid body throws RequestValidationError before anything is sent; without validateRequest it is sent", async () => {
    const { client } = await generateClient("test/fixtures/read-write-only-3.0.yaml", "request-validation");
    const api = client.createClient({ baseUrl, validateRequest: true });
    const before = requestsTo("/accounts").length;
    const error = await api.accounts.createAccount({ name: "", password: 42 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(client.RequestValidationError);
    expect((error as { issues: unknown[] }).issues).toEqual([
      { path: "/name", message: "must have at least 1 characters" },
      { path: "/password", message: "must be a string, got number" },
    ]);
    expect((error as Error).message).toStartWith("request of createAccount does not match its schema:");
    expect(requestsTo("/accounts").length).toBe(before);

    const unchecked = client.createClient({ baseUrl });
    await unchecked.accounts.createAccount({ name: "x", password: 42 });
    expect(requestsTo("/accounts").length).toBe(before + 1);
  });

  test("required readOnly properties are not required in requests, required writeOnly properties not in responses", async () => {
    const { client } = await generateClient("test/fixtures/read-write-only-3.0.yaml", "request-validation-read-write");
    const api = client.createClient({ baseUrl, validateRequest: true, validate: true, transform: true });
    const account = await api.accounts.createAccount({ name: "ada", password: "secret" });
    expect(lastRequest().body).toBe('{"name":"ada","password":"secret"}');
    expect(account).toEqual({ id: 1n, name: "ada", created_at: new Date("2026-01-02T03:04:05.000Z") });

    // Checked in wire form after encoding: a Date and a bigint become a date-time string and an integer.
    const missingName = await api.accounts.createAccount({ password: "secret", id: 5n, created_at: new Date("2026-01-02T03:04:05.000Z") }).catch((caught: unknown) => caught);
    expect((missingName as { issues: unknown[] }).issues).toEqual([{ path: "/name", message: "is required" }]);
  });
});

describe("generated service files", () => {
  // Regression: a union response with a transformed member made the service import its validators twice
  // (once for the response validator, once for union routing), found by make e2e on the Jira spec.
  test("a union response with a transformed member compiles and decodes", async () => {
    const { client, files } = await generateClient("test/fixtures/union-response-3.1.yaml", "services-union");
    expect(typeCheck(files, "services-union")).toEqual([]);
    const send = async () => ({ at: "2026-01-02T03:04:05.000Z" });
    const events = new client.EventsService({ send, transform: true, validate: true });
    expect((await events.getLatestEvent()).at).toEqual(new Date("2026-01-02T03:04:05.000Z"));
    const empty = new client.EventsService({ send: async () => null, transform: true, validate: true });
    expect(await empty.getLatestEvent()).toBeNull();
  });
});

describe("bodiless success responses", () => {
  // Regression: an operation answering 200 with a body or 204 without one rejected every valid 204 under
  // validate: true (found in review on SpaceTraders get-ship-cooldown).
  test("a 204 next to a 200 body resolves to undefined, validated or not, and the type says so", async () => {
    const { client, files } = await generateClient("test/fixtures/optional-body-3.1.yaml", "services-optional-body");
    for (const validate of [false, true]) {
      const jobs = new client.JobsService({ send: async () => undefined, validate, transform: true });
      expect(await jobs.getJob({ id: "1" })).toBeUndefined();
    }
    const finished = new client.JobsService({ send: async () => ({ finished_at: "2026-01-02T03:04:05.000Z" }), validate: true, transform: true });
    expect((await finished.getJob({ id: "1" })).finished_at).toBeInstanceOf(Date);
    const usage = `import { JobsService, createFetchSend } from './index.js';
export async function use(): Promise<void> {
    const job = await new JobsService({ send: createFetchSend({ baseUrl: 'http://localhost' }) }).getJob({ id: '1' });
    // @ts-expect-error the 204 answer has no body, so the result may be undefined
    const finishedAt: string = job.finished_at;
    void finishedAt;
}
`;
    expect(typeCheck(files, "services-optional-body", { "usage.ts": usage })).toEqual([]);
  });
});

describe("generated service types", () => {
  test("transform: true switches the result types; mixing them up does not compile", async () => {
    const { files } = await generateClient("test/fixtures/petstore-3.0.yaml", "services-types", { naming: { properties: "camelCase" } });
    const usage = `import { PetsService, createClient, createFetchSend, type RequestOptions } from './index.js';

const send = createFetchSend({ baseUrl: 'http://localhost' });
export async function wire(): Promise<void> {
    const pets = new PetsService({ send });
    const pet = await pets.getPet({ petId: 1 });
    const text: string = pet.created_at;
    const id: number = pet.id;
    // @ts-expect-error wire values are strings, not Dates
    const wrong: Date = pet.created_at;
    void [text, id, wrong];
}
export async function app(): Promise<void> {
    const pets = new PetsService({ send, transform: true, validate: true });
    const pet = await pets.getPet({ petId: 1 });
    const when: Date = pet.createdAt;
    const id: bigint = pet.id;
    // @ts-expect-error App values use camelCase names
    void pet.created_at;
    // @ts-expect-error a path parameter is required
    await pets.getPet();
    void [when, id];
}
export async function client(): Promise<void> {
    const api = createClient({ transform: true, timeout: 1000, retry: 2, init: { credentials: 'include' } });
    const pet = await api.pets.getPet({ petId: 1 }, { signal: AbortSignal.timeout(100), headers: { 'x-a': 'b' }, retry: false });
    const when: Date = pet.createdAt;
    const wirePet = await createClient().pets.getPet({ petId: 1 });
    const text: string = wirePet.created_at;
    const options: RequestOptions = { timeout: 5 };
    await api.pets.listPets(undefined, undefined, options);
    // @ts-expect-error unknown per-call option
    await api.pets.getPet({ petId: 1 }, { unknownOption: true });
    void [when, text];
}
`;
    expect(typeCheck(files, "services-types", { "usage.ts": usage })).toEqual([]);
  });
});
