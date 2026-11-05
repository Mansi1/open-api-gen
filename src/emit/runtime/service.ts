// Copied verbatim into every generated client as runtime/service.ts. It imports only its sibling runtime
// modules, and it must run unchanged in browsers, Node.js and Bun.
// VERIFIED: test/services.test.ts covers all four validate × transform combinations.
import { settleUnsafeIntegers } from "./json.js";
import type { Transformer } from "./transform.js";
import { validate, type Issue, type Validator } from "./validation.js";

export type ParameterStyle = { style: "form" | "simple" | "deepObject" | "spaceDelimited" | "pipeDelimited" | "label" | "matrix"; explode: boolean };
export type ParameterLocation = "path" | "query" | "header" | "cookie";

/** When and how often createFetchSend repeats a failed request. */
export type RetryOptions = {
  /** Repeats after the first attempt; 0 turns retrying off. */
  retries: number;
  /** Wait before the first repeat in milliseconds, doubled for each further one (default 300). */
  delay?: number;
  /** Upper bound for one wait, also for a server's Retry-After (default 10000). */
  maxDelay?: number;
  /** Statuses that are retried (default 408, 429, 500, 502, 503, 504). Network errors and timeouts always are. */
  statusCodes?: number[];
  /** Methods that are retried (default the idempotent ones: GET, HEAD, OPTIONS, PUT, DELETE, QUERY). */
  methods?: string[];
};

/** Options for one call, passed as the last argument of every generated method. */
export type RequestOptions = {
  /** Cancels the request, including retries and their waits. */
  signal?: AbortSignal;
  /** Milliseconds per attempt before it fails with a TimeoutError; overrides the client's timeout. */
  timeout?: number;
  /** Extra headers for this call; they win over the client's headers and the operation's header parameters. */
  headers?: Record<string, string>;
  /** Retry settings for this call: a number of retries, full settings, or false for none. */
  retry?: number | RetryOptions | false;
  /** Sees the final response, also an unsuccessful one, e.g. to read pagination or rate-limit headers. Clone it before reading the body. */
  onResponse?: (response: Response) => void | Promise<void>;
};

/**
 * What a service hands to `send`. The first seven fields are the dist3 contract, so an existing `send`
 * keeps working; the rest describe the operation for transports that want more detail (like createFetchSend).
 */
export type SendRequest = {
  method: string;
  /** The templated path, e.g. `/pets/{petId}`; `send` fills in `urlParameter`. */
  url: string;
  urlParameter?: Record<string, unknown>;
  queryParameter?: Record<string, unknown>;
  headerParameter?: Record<string, unknown>;
  cookieParameter?: Record<string, unknown>;
  body?: unknown;
  operationId: string;
  /** OpenAPI 3.2 `in: querystring`: the whole query string as one value. */
  querystring?: unknown;
  querystringContentType?: string;
  requestContentType?: string;
  /** Media types the operation answers with, best first; also sent as the Accept header. */
  responseContentTypes: string[];
  parameterStyles: Partial<Record<ParameterLocation, Record<string, ParameterStyle>>>;
  /** The response is a sequence of items (OpenAPI 3.2 `itemSchema`); `send` returns an AsyncIterable. */
  stream: boolean;
  /** Parse JSON losslessly (int64 beyond 2^53 as bigint); set when the client transforms values. */
  lossless: boolean;
  /** The caller's per-call options; a custom `send` may honor or ignore them. */
  options?: RequestOptions;
  /** Security requirement alternatives, each a list of scheme names that apply together; absent WHEN none apply. */
  security?: string[][];
};

/** Sends one request and resolves with the parsed response body; throws for unsuccessful responses. */
export type Send = <Result = unknown>(request: SendRequest) => Promise<Result>;

export type ServiceConfig<Transform extends boolean> = {
  send: Send;
  /** Check every response body against its schema and throw ResponseValidationError on a mismatch. */
  validate?: boolean;
  /** Convert between wire values and App values: dates, int64, renamed properties, user hooks. */
  transform?: Transform;
};

/** Everything a generated method knows about its operation; generated once per operation. */
export type OperationDescriptor = {
  operationId: string;
  method: string;
  url: string;
  requestContentType?: string;
  querystringContentType?: string;
  responseContentTypes: string[];
  parameterStyles: SendRequest["parameterStyles"];
  stream: boolean;
  /** Some success response has no body (e.g. 204 next to a 200 with one); a missing body is then not validated. */
  emptyBodyAllowed?: boolean;
  requestTransformer?: Transformer;
  responseValidator?: Validator;
  responseTransformer?: Transformer;
  security?: string[][];
};

/** Generated parameter interfaces have no index signature, so the arguments are typed as plain objects. */
export type OperationArguments = {
  urlParameter?: object;
  queryParameter?: object;
  querystring?: unknown;
  headerParameter?: object;
  cookieParameter?: object;
  body?: unknown;
};

function asRecord(value: object | undefined): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

/** A response body that does not match its schema; thrown only by clients created with `validate: true`. */
export class ResponseValidationError extends Error {
  constructor(
    readonly operationId: string,
    readonly issues: Issue[],
    readonly body: unknown,
  ) {
    const listed = issues.slice(0, 5).map((issue) => `  ${issue.path === "" ? "(body)" : issue.path}: ${issue.message}`);
    const more = issues.length > 5 ? `\n  ... and ${issues.length - 5} more` : "";
    super(`response of ${operationId} does not match its schema:\n${listed.join("\n")}${more}`);
    this.name = "ResponseValidationError";
  }
}

/** The body of a generated service method: encode, send, validate, decode. */
export async function callOperation(
  config: ServiceConfig<boolean>,
  operation: OperationDescriptor,
  operationArguments: OperationArguments,
  options?: RequestOptions,
): Promise<unknown> {
  const transform = config.transform === true;
  let body = operationArguments.body;
  if (transform && operation.requestTransformer !== undefined && body !== undefined) {
    body = operation.requestTransformer.encode(body, "");
  }
  const request: SendRequest = {
    method: operation.method,
    url: operation.url,
    urlParameter: asRecord(operationArguments.urlParameter),
    queryParameter: asRecord(operationArguments.queryParameter),
    headerParameter: asRecord(operationArguments.headerParameter),
    cookieParameter: asRecord(operationArguments.cookieParameter),
    operationId: operation.operationId,
    responseContentTypes: operation.responseContentTypes,
    parameterStyles: operation.parameterStyles,
    stream: operation.stream,
    lossless: transform,
  };
  if (body !== undefined) {
    request.body = body;
  }
  if (options !== undefined) {
    request.options = options;
  }
  if (operation.security !== undefined) {
    request.security = operation.security;
  }
  if (operation.requestContentType !== undefined) {
    request.requestContentType = operation.requestContentType;
  }
  if (operationArguments.querystring !== undefined) {
    request.querystring = operationArguments.querystring;
    if (operation.querystringContentType !== undefined) {
      request.querystringContentType = operation.querystringContentType;
    }
  }

  const finish = (value: unknown): unknown => {
    if (value === undefined && operation.emptyBodyAllowed === true) {
      return undefined;
    }
    if (config.validate === true && operation.responseValidator !== undefined) {
      const issues = validate(operation.responseValidator, value);
      if (issues.length > 0) {
        throw new ResponseValidationError(operation.operationId, issues, settleUnsafeIntegers(value));
      }
    }
    const decoded = transform && operation.responseTransformer !== undefined ? operation.responseTransformer.decode(value, "") : value;
    // int64 fields are bigint by now; an integer beyond 2^53 anywhere else becomes the number its type says.
    return settleUnsafeIntegers(decoded);
  };

  const result = await config.send<unknown>(request);
  if (operation.stream) {
    return mapStream(result as AsyncIterable<unknown>, finish);
  }
  return finish(result);
}

async function* mapStream(items: AsyncIterable<unknown>, finish: (value: unknown) => unknown): AsyncIterable<unknown> {
  for await (const item of items) {
    yield finish(item);
  }
}
