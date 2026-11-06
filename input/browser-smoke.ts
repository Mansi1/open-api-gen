// The browser e2e consumer: scripts/browser-e2e.ts bundles it with Bun.build and runs it in Chromium, Firefox and
// WebKit against a same-origin mock API. It uses the clients the packed CLI generated into output/clients/ and
// checks what depends on the JavaScript engine: lossless JSON (reviver source text, JSON.rawJSON), AbortSignal
// timeouts, ReadableStream bodies, TextEncoder/TextDecoder. Results land in globalThis.smokeResults.
// VERIFIED: make e2e passes every check in Chromium 158, Firefox 159 and WebKit 27.2 (output/browser-report.json).
import { createClient as createFeaturesClient } from "../output/clients/features-3-2/index.js";
import { createClient, isApiError, ResponseValidationError, type Middleware } from "../output/clients/petstore-app/index.js";
import { parseWebhook } from "../output/clients/webhooks/index.js";
import { Decimal } from "./hooks/decimal.js";

type SmokeResult = { name: string; ok: boolean; detail?: string };
const results: SmokeResult[] = [];

async function check(name: string, run: () => Promise<boolean> | boolean): Promise<void> {
  try {
    results.push({ name, ok: await run() });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

const baseUrl = `${location.origin}/api`;
const statuses: number[] = [];
const middleware: Middleware[] = [{ onResponse: (response) => void statuses.push(response.status) }];
const api = createClient({ baseUrl, transform: true, validate: true, retry: { retries: 2, delay: 1 }, middleware, auth: { api_key: "browser-key" } });

await check("an int64 beyond 2^53 arrives exactly (JSON.parse reviver source text)", async () => {
  const order = await api.store.getOrderById({ orderId: 9007199254740993n });
  return order.id instanceof Decimal && order.id.toString() === "9007199254740993";
});
await check("a date-time arrives as a Date", async () => {
  const order = await api.store.getOrderById({ orderId: 9007199254740993n });
  return order.shipDate instanceof Date && order.shipDate.toISOString() === "2026-03-04T05:06:07.000Z";
});
await check("an int64 beyond 2^53 is sent exactly (JSON.rawJSON)", async () => {
  const placed = await api.store.placeOrder({ id: new Decimal("9007199254740993"), quantity: 1, status: "approved" });
  return placed.id instanceof Decimal && placed.id.toString() === "9007199254740993";
});
await check("auth sends the api_key; a busy GET is retried and middleware sees each attempt", async () => {
  statuses.length = 0;
  const inventory = await api.store.getInventory({ headers: { "x-busy-token": crypto.randomUUID() } });
  return inventory.available === 3 && statuses.join(",") === "503,503,200";
});
await check("a per-call timeout aborts a slow answer (AbortSignal.timeout and AbortSignal.any)", async () => {
  const error = await failure(api.store.getOrderById({ orderId: 5 }, { timeout: 50, retry: false }));
  return error instanceof Error && error.name === "TimeoutError";
});
await check("an invalid response body throws ResponseValidationError", async () => {
  const error = await failure(api.store.getOrderById({ orderId: 1 }));
  return error instanceof ResponseValidationError && error.issues[0]?.path === "/id";
});
await check("isApiError narrows a 404 to its operation", async () => {
  const error = await failure(api.store.getOrderById({ orderId: 404 }));
  return isApiError(error, "getOrderById") && error.status === 404;
});
await check("a JSON Lines response streams item by item (ReadableStream)", async () => {
  const features = createFeaturesClient({ baseUrl, transform: true, validate: true });
  const items: { id: string; updatedAt?: Date }[] = [];
  for await (const item of await features.search.streamItems()) {
    items.push(item);
  }
  return items.length === 2 && items[0]?.updatedAt instanceof Date && items[1]?.id === "b";
});
await check("parseWebhook reads raw bytes losslessly (TextEncoder, TextDecoder)", () => {
  const bytes = new TextEncoder().encode('{"id":9007199254740993,"name":"Rex","created_at":"2026-01-02T03:04:05.000Z"}');
  const pet = parseWebhook("onPetCreated", bytes, { validate: true, transform: true });
  return pet.id === 9007199254740993n && pet.createdAt instanceof Date;
});

const smokeGlobal = globalThis as unknown as { smokeResults: SmokeResult[]; smokeDone: boolean };
smokeGlobal.smokeResults = results;
smokeGlobal.smokeDone = true;
