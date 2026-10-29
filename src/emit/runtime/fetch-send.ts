// Copied verbatim into every generated client as runtime/fetch-send.ts. It imports only its sibling runtime
// modules, and it must run unchanged in browsers, Node.js and Bun.
// VERIFIED: test/services.test.ts drives createFetchSend against a real Bun.serve server.
import { parseJson, stringifyJson } from "./json.js";
import type { ParameterLocation, ParameterStyle, Send, SendRequest } from "./service.js";

export type FetchSendOptions = {
  /** Prefix for every path, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Sent with every request, e.g. an Authorization header. A function is called per request. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
};

/** A response with a status outside 2xx; `body` is the parsed error body when there is one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly response: Response,
  ) {
    super(`${response.url} answered ${status} ${response.statusText}`);
    this.name = "ApiError";
  }
}

type RequestBody = NonNullable<RequestInit["body"]>;

const DEFAULT_STYLES: Record<ParameterLocation, ParameterStyle> = {
  path: { style: "simple", explode: false },
  query: { style: "form", explode: true },
  header: { style: "simple", explode: false },
  cookie: { style: "form", explode: true },
};

/** The default `send`: builds the request with fetch, following the OpenAPI serialization rules. */
export function createFetchSend(options: FetchSendOptions): Send {
  const fetchFunction = options.fetch ?? globalThis.fetch;
  return async <Result>(request: SendRequest): Promise<Result> => {
    const url = buildUrl(options.baseUrl, request);
    const headers = new Headers(typeof options.headers === "function" ? await options.headers() : options.headers);
    for (const [name, value] of Object.entries(request.headerParameter ?? {})) {
      if (value !== undefined) {
        headers.set(name, serializeSimple(value, styleOf(request, "header", name).explode));
      }
    }
    const cookie = serializeCookies(request);
    if (cookie !== "") {
      headers.set("cookie", cookie);
    }
    if (request.responseContentTypes.length > 0 && !headers.has("accept")) {
      headers.set("accept", request.responseContentTypes.join(", "));
    }

    const init: RequestInit = { method: request.method, headers };
    if (request.body !== undefined) {
      init.body = encodeBody(request.body, request.requestContentType ?? "application/json", headers);
    }
    const response = await fetchFunction(url, init);
    if (!response.ok) {
      // Error bodies get no transformer, so they are parsed plainly.
      throw new ApiError(response.status, await readBody(response, false).catch(() => undefined), response);
    }
    if (request.stream) {
      return readStream(response, request.lossless) as Result;
    }
    return (await readBody(response, request.lossless)) as Result;
  };
}

function styleOf(request: SendRequest, location: ParameterLocation, name: string): ParameterStyle {
  return request.parameterStyles[location]?.[name] ?? DEFAULT_STYLES[location];
}

// ---------------------------------------------------------------- URL

function buildUrl(baseUrl: string, request: SendRequest): string {
  const path = request.url.replace(/\{([^}]+)\}/g, (_template, name: string) => {
    const value = request.urlParameter?.[name];
    if (value === undefined || value === null) {
      throw new TypeError(`${request.operationId}: path parameter "${name}" is required`);
    }
    return serializePath(name, value, styleOf(request, "path", name));
  });
  const query = request.querystring !== undefined ? serializeQuerystring(request.querystring, request.querystringContentType) : serializeQuery(request);
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return query === "" ? `${base}${path}` : `${base}${path}?${query}`;
}

function text(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object" && value !== null) {
    return stringifyJson(value);
  }
  return String(value);
}

function entriesOf(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value).filter(([, item]) => item !== undefined);
}

function serializePath(name: string, value: unknown, style: ParameterStyle): string {
  const encode = encodeURIComponent;
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
  if (style.style === "label") {
    if (Array.isArray(value)) {
      return `.${value.map((item) => encode(text(item))).join(style.explode ? "." : ",")}`;
    }
    if (isObject) {
      const pairs = entriesOf(value as Record<string, unknown>);
      if (style.explode) {
        return pairs.map(([key, item]) => `.${encode(key)}=${encode(text(item))}`).join("");
      }
      return `.${pairs.map(([key, item]) => `${encode(key)},${encode(text(item))}`).join(",")}`;
    }
    return `.${encode(text(value))}`;
  }
  if (style.style === "matrix") {
    if (Array.isArray(value)) {
      if (style.explode) {
        return value.map((item) => `;${name}=${encode(text(item))}`).join("");
      }
      return `;${name}=${value.map((item) => encode(text(item))).join(",")}`;
    }
    if (isObject) {
      const pairs = entriesOf(value as Record<string, unknown>);
      if (style.explode) {
        return pairs.map(([key, item]) => `;${encode(key)}=${encode(text(item))}`).join("");
      }
      return `;${name}=${pairs.map(([key, item]) => `${encode(key)},${encode(text(item))}`).join(",")}`;
    }
    return `;${name}=${encode(text(value))}`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => encode(text(item))).join(",");
  }
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    const pairs = entriesOf(value as Record<string, unknown>);
    if (style.explode) {
      return pairs.map(([key, item]) => `${encode(key)}=${encode(text(item))}`).join(",");
    }
    return pairs.map(([key, item]) => `${encode(key)},${encode(text(item))}`).join(",");
  }
  return encode(text(value));
}

/** `simple` style for headers: arrays and objects become comma-separated lists. */
function serializeSimple(value: unknown, explode: boolean): string {
  if (Array.isArray(value)) {
    return value.map(text).join(",");
  }
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    const pairs = entriesOf(value as Record<string, unknown>);
    return pairs.map(([key, item]) => (explode ? `${key}=${text(item)}` : `${key},${text(item)}`)).join(",");
  }
  return text(value);
}

function serializeQuery(request: SendRequest): string {
  const parts: string[] = [];
  const encode = encodeURIComponent;
  for (const [name, value] of entriesOf(request.queryParameter ?? {})) {
    if (value === null) {
      continue;
    }
    const style = styleOf(request, "query", name);
    if (style.style === "deepObject" && typeof value === "object" && !(value instanceof Date)) {
      for (const [key, item] of entriesOf(value as Record<string, unknown>)) {
        parts.push(`${encode(name)}[${encode(key)}]=${encode(text(item))}`);
      }
    } else if (Array.isArray(value)) {
      if (style.style === "spaceDelimited" || style.style === "pipeDelimited") {
        const separator = style.style === "spaceDelimited" ? "%20" : "%7C";
        parts.push(`${encode(name)}=${value.map((item) => encode(text(item))).join(separator)}`);
      } else if (style.explode) {
        for (const item of value) {
          parts.push(`${encode(name)}=${encode(text(item))}`);
        }
      } else {
        parts.push(`${encode(name)}=${value.map((item) => encode(text(item))).join(",")}`);
      }
    } else if (typeof value === "object" && !(value instanceof Date)) {
      const pairs = entriesOf(value as Record<string, unknown>);
      if (style.explode) {
        for (const [key, item] of pairs) {
          parts.push(`${encode(key)}=${encode(text(item))}`);
        }
      } else {
        parts.push(`${encode(name)}=${pairs.map(([key, item]) => `${encode(key)},${encode(text(item))}`).join(",")}`);
      }
    } else {
      parts.push(`${encode(name)}=${encode(text(value))}`);
    }
  }
  return parts.join("&");
}

function serializeQuerystring(value: unknown, contentType: string | undefined): string {
  if (typeof value === "string") {
    return value.startsWith("?") ? value.slice(1) : value;
  }
  if (contentType === undefined || contentType.startsWith("application/x-www-form-urlencoded")) {
    const parameters = new URLSearchParams();
    for (const [key, item] of entriesOf((value ?? {}) as Record<string, unknown>)) {
      if (Array.isArray(item)) {
        item.forEach((element) => parameters.append(key, text(element)));
      } else {
        parameters.append(key, text(item));
      }
    }
    return parameters.toString();
  }
  return encodeURIComponent(text(value));
}

function serializeCookies(request: SendRequest): string {
  const pairs: string[] = [];
  for (const [name, value] of entriesOf(request.cookieParameter ?? {})) {
    if (value === null) {
      continue;
    }
    const style = styleOf(request, "cookie", name);
    if (Array.isArray(value)) {
      if (style.explode) {
        value.forEach((item) => pairs.push(`${name}=${encodeURIComponent(text(item))}`));
      } else {
        pairs.push(`${name}=${value.map((item) => encodeURIComponent(text(item))).join(",")}`);
      }
    } else {
      pairs.push(`${name}=${encodeURIComponent(text(value))}`);
    }
  }
  return pairs.join("; ");
}

// ---------------------------------------------------------------- bodies

function encodeBody(body: unknown, contentType: string, headers: Headers): RequestBody {
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  if (mediaType === "multipart/form-data") {
    // fetch sets the multipart boundary itself, so no content-type header here.
    const form = new FormData();
    for (const [key, value] of entriesOf((body ?? {}) as Record<string, unknown>)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        form.append(key, item instanceof Blob ? item : text(item));
      }
    }
    return form;
  }
  headers.set("content-type", contentType);
  if (mediaType === "application/x-www-form-urlencoded") {
    return serializeQuerystring(body, mediaType);
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return stringifyJson(body);
  }
  if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || typeof body === "string") {
    return body as RequestBody;
  }
  return text(body);
}

function isJson(contentType: string): boolean {
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

async function readBody(response: Response, lossless: boolean): Promise<unknown> {
  if (response.status === 204 || response.status === 205) {
    return undefined;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (isJson(contentType)) {
    const bodyText = await response.text();
    if (bodyText === "") {
      return undefined;
    }
    return lossless ? parseJson(bodyText) : JSON.parse(bodyText);
  }
  if (contentType.startsWith("text/") || contentType === "") {
    const bodyText = await response.text();
    return bodyText === "" ? undefined : bodyText;
  }
  return response.blob();
}

/** JSON Lines / NDJSON / JSON text sequences one item per line; Server-Sent Events one item per `data` event. */
async function* readStream(response: Response, lossless: boolean): AsyncIterable<unknown> {
  if (response.body === null) {
    return;
  }
  const isEventStream = (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
  const parse = (itemText: string): unknown => {
    try {
      return lossless ? parseJson(itemText) : JSON.parse(itemText);
    } catch {
      // SSE data does not have to be JSON.
      if (isEventStream) {
        return itemText;
      }
      throw new SyntaxError(`stream item is not JSON: ${itemText.slice(0, 80)}`);
    }
  };
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffered = "";
  let eventData: string[] = [];
  const takeLine = function* (line: string): Generator<unknown> {
    if (isEventStream) {
      if (line === "") {
        if (eventData.length > 0) {
          yield parse(eventData.join("\n"));
        }
        eventData = [];
      } else if (line.startsWith("data:")) {
        eventData.push(line.slice(5).replace(/^ /, ""));
      }
      return;
    }
    // JSON text sequences prefix each record with the record separator U+001E.
    const record = (line.startsWith("\u001e") ? line.slice(1) : line).trim();
    if (record !== "") {
      yield parse(record);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split(/\r?\n/);
    buffered = done ? "" : lines.pop()!;
    for (const line of lines) {
      yield* takeLine(line);
    }
    if (done) {
      yield* takeLine("");
      return;
    }
  }
}
