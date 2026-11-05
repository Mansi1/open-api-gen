// Copied verbatim into every generated client as runtime/client.ts. It imports only its sibling runtime
// modules, and it must run unchanged in browsers, Node.js and Bun.
// VERIFIED: test/services.test.ts builds generated clients with createClient against a real Bun.serve server.
import { createFetchSend, serverUrl, type AuthCredentials, type FetchSendOptions, type SecurityScheme, type Server } from "./fetch-send.js";
import type { Send, ServiceConfig } from "./service.js";

export { serverUrl, type Server, type ServerVariable } from "./fetch-send.js";

/** Settings for the generated `createClient`: createFetchSend's options plus the service options; `Auth` is the generated ApiAuth. */
export type ClientOptions<Transform extends boolean = false, Auth extends AuthCredentials = AuthCredentials> = Omit<FetchSendOptions, "baseUrl" | "auth" | "securitySchemes"> & {
  /** Credentials by security scheme name; each operation sends the ones its security requirements name. */
  auth?: Auth;
  /** Prefix for every path; defaults to the first server of the API document, or `/` when it declares none. */
  baseUrl?: string;
  /** Your own transport instead of createFetchSend; baseUrl, fetch, headers, init, timeout, retry and middleware then do nothing. */
  send?: Send;
  /** Check every response body against its schema and throw ResponseValidationError on a mismatch. */
  validate?: boolean;
  /** Check every request body against its schema before sending and throw RequestValidationError on a mismatch. */
  validateRequest?: boolean;
  /** Convert between wire values and App values: dates, int64, renamed properties, user hooks. */
  transform?: Transform;
};

/** The service configuration createClient shares between all services of one client. */
export function createServiceConfig<Transform extends boolean>(
  options: ClientOptions<Transform>,
  servers: Server[],
  securitySchemes: Record<string, SecurityScheme> = {},
): ServiceConfig<Transform> {
  const { send, validate, validateRequest, transform, baseUrl, ...fetchOptions } = options;
  // OpenAPI: without servers, the default server URL is `/`.
  const defaultServer: Server = servers[0] ?? { url: "/" };
  const config: ServiceConfig<Transform> = { send: send ?? createFetchSend({ ...fetchOptions, securitySchemes, baseUrl: baseUrl ?? serverUrl(defaultServer) }) };
  if (validate !== undefined) {
    config.validate = validate;
  }
  if (validateRequest !== undefined) {
    config.validateRequest = validateRequest;
  }
  if (transform !== undefined) {
    config.transform = transform;
  }
  return config;
}
