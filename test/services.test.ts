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
      const json = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "application/json" } });
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
    const usage = `import { PetsService, createFetchSend } from './index.js';

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
`;
    expect(typeCheck(files, "services-types", { "usage.ts": usage })).toEqual([]);
  });
});
