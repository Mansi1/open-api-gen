// Copied verbatim into every generated client as runtime/fetch-send.ts. It imports only its sibling runtime
// modules, and it must run unchanged in browsers, Node.js and Bun.
// VERIFIED: test/services.test.ts drives createFetchSend against a real Bun.serve server.
import { parseJson, stringifyJson } from "./json.js";
import type { ParameterLocation, ParameterStyle, RetryOptions, Send, SendRequest } from "./service.js";

/** Hooks around every attempt; they run in order and may return a replacement Request or Response. */
export type Middleware = {
  /** Called before each attempt, e.g. to sign the request or add a fresh token. */
  onRequest?: (request: Request, details: SendRequest) => Request | void | Promise<Request | void>;
  /** Called with each answer, also unsuccessful ones, before retry and error handling, e.g. to log or to refresh a token and repeat. */
  onResponse?: (response: Response, request: Request, details: SendRequest) => Response | void | Promise<Response | void>;
};

/** An OpenAPI security scheme as the generated `securitySchemes` lists it. */
export type SecurityScheme =
  | { type: "apiKey"; in: "header" | "query" | "cookie"; name: string; description?: string }
  | { type: "http"; scheme: string; description?: string }
  | { type: "oauth2" | "openIdConnect" | "mutualTLS"; description?: string };

export type BasicCredentials = { username: string; password: string };

/** A credential, or a function (may be async) called per attempt; undefined means "none right now", e.g. logged out. */
export type Credential<Value> = Value | (() => Value | undefined | Promise<Value | undefined>);

/** Credentials by security scheme name: a token or API key, or username and password for HTTP basic. */
export type AuthCredentials = Record<string, Credential<string> | Credential<BasicCredentials> | undefined>;

export type FetchSendOptions = {
  /** Prefix for every path, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Sent with every request, e.g. an Authorization header. A function is called per attempt. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Further fetch settings for every request, e.g. `{ credentials: "include" }` or `{ cache: "no-store" }`. */
  init?: Omit<RequestInit, "method" | "headers" | "body" | "signal">;
  /** Milliseconds per attempt before it fails with a TimeoutError (default: no limit). */
  timeout?: number;
  /** Retry failed idempotent requests: a number of retries or full settings (default: no retries). */
  retry?: number | RetryOptions;
  /** Request and response hooks, run in order. */
  middleware?: Middleware[];
  /** Credentials by security scheme name, applied as each operation's security requirements say. */
  auth?: AuthCredentials;
  /** The document's security schemes; createClient passes the generated `securitySchemes`. */
  securitySchemes?: Record<string, SecurityScheme>;
};

/**
 * A response with a status outside 2xx; `body` is the parsed error body when there is one.
 * The type parameters are what the API document declares for the status; the body itself is not checked.
 */
export class ApiError<Body = unknown, Status extends number = number> extends Error {
  constructor(
    readonly status: Status,
    readonly body: Body,
    readonly response: Response,
    readonly operationId?: string,
  ) {
    const prefix = operationId === undefined ? "" : `${operationId}: `;
    super(`${prefix}${response.url} answered ${status} ${response.statusText}`);
    this.name = "ApiError";
  }
}

/** True WHEN `error` is an ApiError, and, with `operationId`, one thrown by that operation. The generated client wraps it with typed narrowing. */
export function isApiErrorOf(error: unknown, operationId?: string): error is ApiError {
  if (!(error instanceof ApiError)) {
    return false;
  }
  return operationId === undefined || error.operationId === operationId;
}

type RequestBody = NonNullable<RequestInit["body"]>;

const DEFAULT_STYLES: Record<ParameterLocation, ParameterStyle> = {
  path: { style: "simple", explode: false },
  query: { style: "form", explode: true },
  header: { style: "simple", explode: false },
  cookie: { style: "form", explode: true },
};

const DEFAULT_RETRY: Required<RetryOptions> = {
  retries: 0,
  delay: 300,
  maxDelay: 10_000,
  statusCodes: [408, 429, 500, 502, 503, 504],
  methods: ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "QUERY"],
};

/** The default `send`: builds the request with fetch, following the OpenAPI serialization rules. */
export function createFetchSend(options: FetchSendOptions): Send {
  const fetchFunction = options.fetch ?? globalThis.fetch;
  const middleware = options.middleware ?? [];
  return async <Result>(request: SendRequest): Promise<Result> => {
    const url = buildUrl(options.baseUrl, request);
    const callOptions = request.options ?? {};
    const retry = resolveRetry(callOptions.retry ?? options.retry);
    const retriesAllowed = retry.methods.includes(request.method.toUpperCase()) ? retry.retries : 0;
    const timeout = callOptions.timeout ?? options.timeout;
    let body: RequestBody | undefined;
    let bodyContentType: string | undefined;
    if (request.body !== undefined) {
      const encoded = encodeBody(request.body, request.requestContentType ?? "application/json");
      body = encoded.body;
      bodyContentType = encoded.contentType;
    }

    // A fresh Request per attempt: headers() may hand out a refreshed token, the timeout restarts, and middleware
    // sees a standard Request it can replace. The encoded body (string, FormData, Blob, bytes) is reusable across attempts.
    let response: Response | undefined;
    for (let attempt = 0; response === undefined; attempt++) {
      const headers = await buildHeaders(options, request, bodyContentType);
      const authQuery = await applyAuth(options, request, headers);
      finishHeaders(request, headers);
      let attemptUrl = url;
      if (authQuery !== "") {
        attemptUrl = url.includes("?") ? `${url}&${authQuery}` : `${url}?${authQuery}`;
      }
      const signals: AbortSignal[] = [];
      if (callOptions.signal !== undefined) {
        signals.push(callOptions.signal);
      }
      if (timeout !== undefined) {
        signals.push(AbortSignal.timeout(timeout));
      }
      const init: RequestInit = { ...options.init, method: request.method, headers };
      if (body !== undefined) {
        init.body = body;
      }
      if (signals.length > 0) {
        init.signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
      }
      let fetchRequest = new Request(attemptUrl, init);
      for (const hooks of middleware) {
        fetchRequest = (await hooks.onRequest?.(fetchRequest, request)) ?? fetchRequest;
      }

      let answer: Response;
      try {
        answer = await fetchFunction(fetchRequest);
      } catch (error) {
        // The caller's own abort ends everything; a network error or timeout may be retried.
        if (callOptions.signal?.aborted === true || attempt >= retriesAllowed) {
          throw error;
        }
        await wait(backoff(retry, attempt), callOptions.signal);
        continue;
      }
      for (const hooks of middleware) {
        answer = (await hooks.onResponse?.(answer, fetchRequest, request)) ?? answer;
      }
      if (attempt < retriesAllowed && retry.statusCodes.includes(answer.status)) {
        const delay = retryAfter(answer, retry) ?? backoff(retry, attempt);
        // Frees the connection; a body that middleware left locked cannot be cancelled and is left to the garbage collector.
        await answer.body?.cancel().catch(() => undefined);
        await wait(delay, callOptions.signal);
        continue;
      }
      response = answer;
    }

    await callOptions.onResponse?.(response);
    if (!response.ok) {
      // Error bodies get no transformer, so they are parsed plainly.
      throw new ApiError(response.status, await readBody(response, false).catch(() => undefined), response, request.operationId);
    }
    if (request.stream) {
      return readStream(response, request.lossless) as Result;
    }
    return (await readBody(response, request.lossless)) as Result;
  };
}

/** Client headers, then header parameters, cookies and content type; auth and finishHeaders follow. */
async function buildHeaders(options: FetchSendOptions, request: SendRequest, bodyContentType: string | undefined): Promise<Headers> {
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
  if (bodyContentType !== undefined) {
    headers.set("content-type", bodyContentType);
  }
  return headers;
}

/** The call's own headers last, so they win over client headers, header parameters and auth; then the default Accept. */
function finishHeaders(request: SendRequest, headers: Headers): void {
  for (const [name, value] of Object.entries(request.options?.headers ?? {})) {
    headers.set(name, value);
  }
  if (request.responseContentTypes.length > 0 && !headers.has("accept")) {
    headers.set("accept", request.responseContentTypes.join(", "));
  }
}

// ---------------------------------------------------------------- auth

async function resolveCredential(credential: AuthCredentials[string]): Promise<string | BasicCredentials | undefined> {
  if (typeof credential === "function") {
    return credential();
  }
  return credential;
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Applies the first security alternative whose schemes all have credentials (alternatives are OR, the schemes
 * inside one are AND): headers and cookies directly, API keys for the query as the returned query text.
 * Each credential function runs at most once per attempt. When no alternative is satisfied the request goes
 * out without credentials and the server decides, rather than failing here on a requirement the server may not enforce.
 */
async function applyAuth(options: FetchSendOptions, request: SendRequest, headers: Headers): Promise<string> {
  if (request.security === undefined || options.auth === undefined) {
    return "";
  }
  const resolved = new Map<string, string | BasicCredentials | undefined>();
  const credentialOf = async (schemeName: string) => {
    if (!resolved.has(schemeName)) {
      resolved.set(schemeName, await resolveCredential(options.auth?.[schemeName]));
    }
    return resolved.get(schemeName);
  };
  for (const alternative of request.security) {
    const values: [SecurityScheme, string | BasicCredentials][] = [];
    for (const schemeName of alternative) {
      const scheme = options.securitySchemes?.[schemeName];
      // Mutual TLS is the transport's business (client certificates); it needs no value here.
      const value = scheme?.type === "mutualTLS" ? "" : await credentialOf(schemeName);
      if (scheme === undefined || value === undefined) {
        break;
      }
      values.push([scheme, value]);
    }
    // An empty alternative ({}) means "no credentials needed"; skip it so a later one can still send what is configured.
    if (alternative.length === 0 || values.length !== alternative.length) {
      continue;
    }
    const queryParts: string[] = [];
    for (const [scheme, value] of values) {
      const text = typeof value === "string" ? value : `${value.username}:${value.password}`;
      if (scheme.type === "apiKey" && scheme.in === "header") {
        headers.set(scheme.name, text);
      } else if (scheme.type === "apiKey" && scheme.in === "query") {
        queryParts.push(`${encodeURIComponent(scheme.name)}=${encodeURIComponent(text)}`);
      } else if (scheme.type === "apiKey") {
        const existing = headers.get("cookie");
        const cookie = `${scheme.name}=${encodeURIComponent(text)}`;
        headers.set("cookie", existing === null ? cookie : `${existing}; ${cookie}`);
      } else if (scheme.type === "http" && scheme.scheme === "basic") {
        headers.set("authorization", `Basic ${base64(text)}`);
      } else if (scheme.type === "http" && scheme.scheme !== "bearer") {
        // Other HTTP schemes (e.g. a custom token scheme): the scheme name, then the value as given.
        headers.set("authorization", `${scheme.scheme.charAt(0).toUpperCase()}${scheme.scheme.slice(1)} ${text}`);
      } else if (scheme.type !== "mutualTLS") {
        headers.set("authorization", `Bearer ${text}`);
      }
    }
    return queryParts.join("&");
  }
  return "";
}

// ---------------------------------------------------------------- retry

function resolveRetry(retry: number | RetryOptions | false | undefined): Required<RetryOptions> {
  if (retry === undefined || retry === false) {
    return DEFAULT_RETRY;
  }
  if (typeof retry === "number") {
    return { ...DEFAULT_RETRY, retries: retry };
  }
  const resolved = { ...DEFAULT_RETRY, ...retry };
  resolved.methods = resolved.methods.map((method) => method.toUpperCase());
  return resolved;
}

/** Exponential backoff with jitter: delay · 2^attempt, capped, then scaled by a random factor in [0.5, 1]. */
function backoff(retry: Required<RetryOptions>, attempt: number): number {
  const exponential = Math.min(retry.maxDelay, retry.delay * 2 ** attempt);
  return exponential * (0.5 + Math.random() / 2);
}

/** The server's Retry-After in milliseconds (seconds or an HTTP date), capped by maxDelay; undefined when absent or unreadable. */
function retryAfter(response: Response, retry: Required<RetryOptions>): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return undefined;
  }
  let milliseconds = Number(header) * 1000;
  if (Number.isNaN(milliseconds)) {
    milliseconds = Date.parse(header) - Date.now();
  }
  if (Number.isNaN(milliseconds)) {
    return undefined;
  }
  return Math.min(retry.maxDelay, Math.max(0, milliseconds));
}

function wait(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

/** The fetch body and the content-type header to send with it (none for multipart: fetch adds the boundary itself). */
function encodeBody(body: unknown, contentType: string): { body: RequestBody; contentType?: string } {
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  if (mediaType === "multipart/form-data") {
    const form = new FormData();
    for (const [key, value] of entriesOf((body ?? {}) as Record<string, unknown>)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        form.append(key, item instanceof Blob ? item : text(item));
      }
    }
    return { body: form };
  }
  if (mediaType === "application/x-www-form-urlencoded") {
    return { body: serializeQuerystring(body, mediaType), contentType };
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return { body: stringifyJson(body), contentType };
  }
  if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || typeof body === "string") {
    return { body: body as RequestBody, contentType };
  }
  return { body: text(body), contentType };
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
