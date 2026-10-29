// The e2e consumer: a program a user would write against the generated petstore store client. It is compiled with
// TypeScript 7 and run with Node.js against a local mock server; it exits non-zero when any expectation fails.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Decimal } from "../../input/hooks/decimal.js";
import { ApiError, createFetchSend, ResponseValidationError, StoreService } from "../clients/petstore-app/index.js";

type Received = { method: string; url: string; body: string; contentType: string };
const received: Received[] = [];

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  received.push({ method: request.method ?? "", url: request.url ?? "", body, contentType: request.headers["content-type"] ?? "" });
  if (request.url === "/store/order/9007199254740993") {
    respond(response, 200, '{"id":9007199254740993,"petId":12,"quantity":2,"shipDate":"2026-03-04T05:06:07.000Z","status":"placed","complete":false}');
  } else if (request.url === "/store/order/1") {
    respond(response, 200, '{"id":"one","quantity":2}');
  } else if (request.url === "/store/order" && request.method === "POST") {
    respond(response, 200, body);
  } else if (request.url === "/store/inventory") {
    respond(response, 200, '{"available":3,"sold":1}');
  } else {
    respond(response, 404, '{"message":"unknown order"}');
  }
}

function check(condition: boolean, description: string): void {
  if (!condition) {
    throw new Error(`smoke check failed: ${description}`);
  }
  process.stdout.write(`ok - ${description}\n`);
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => respond(response, 500, JSON.stringify(String(error))));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

try {
  const store = new StoreService({ send: createFetchSend({ baseUrl: `http://127.0.0.1:${port}` }), validate: true, transform: true });

  const order = await store.getOrderById({ orderId: 9007199254740993n });
  check(order.id instanceof Decimal && order.id.toString() === "9007199254740993", "int64 id arrives exactly, through the Decimal hook");
  check(order.shipDate instanceof Date && order.shipDate.toISOString() === "2026-03-04T05:06:07.000Z", "date-time arrives as a Date");

  const placed = await store.placeOrder({ id: new Decimal("42"), quantity: 1, shipDate: new Date("2026-05-06T07:08:09.000Z"), status: "approved" });
  check(received[received.length - 1]!.body === '{"id":42,"quantity":1,"shipDate":"2026-05-06T07:08:09.000Z","status":"approved"}', "request body is encoded back to wire JSON");
  check(placed.status === "approved", "the echoed order decodes");

  const inventory = await store.getInventory();
  check(inventory.available === 3, "map responses keep their keys");

  let validationError: unknown;
  try {
    await store.getOrderById({ orderId: 1 });
  } catch (error) {
    validationError = error;
  }
  check(validationError instanceof ResponseValidationError && validationError.issues[0]?.path === "/id", "an invalid response body throws ResponseValidationError");

  let apiError: unknown;
  try {
    await store.getOrderById({ orderId: 404 });
  } catch (error) {
    apiError = error;
  }
  check(apiError instanceof ApiError && apiError.status === 404, "a 404 throws ApiError with its status");
} finally {
  server.close();
}
