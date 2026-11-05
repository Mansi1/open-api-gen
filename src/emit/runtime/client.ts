// Copied verbatim into every generated client as runtime/client.ts. It imports only its sibling runtime
// modules, and it must run unchanged in browsers, Node.js and Bun.
// VERIFIED: test/services.test.ts builds generated clients with createClient against a real Bun.serve server.
import { createFetchSend, type AuthCredentials, type FetchSendOptions, type SecurityScheme } from "./fetch-send.js";
import type { Send, ServiceConfig } from "./service.js";

/** An OpenAPI Server Object; `url` may hold `{variable}` templates that `variables` defines. */
export type Server = { url: string; description?: string; variables?: Record<string, ServerVariable> };

export type ServerVariable = { default: string; enum?: string[]; description?: string };

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
  /** Convert between wire values and App values: dates, int64, renamed properties, user hooks. */
  transform?: Transform;
};

/**
 * A server's URL with its `{variable}` templates filled from `variables`, each falling back to its default.
 * Throws a TypeError for a value outside the variable's `enum` or a template without value or default.
 */
export function serverUrl(server: Server, variables: Record<string, string> = {}): string {
  return server.url.replace(/\{([^}]+)\}/g, (_template, name: string) => {
    const definition = server.variables?.[name];
    const value = variables[name] ?? definition?.default;
    if (value === undefined) {
      throw new TypeError(`server ${server.url}: no value for variable "${name}"`);
    }
    if (definition?.enum !== undefined && !definition.enum.includes(value)) {
      throw new TypeError(`server ${server.url}: variable "${name}" must be one of ${definition.enum.join(", ")}, got "${value}"`);
    }
    return value;
  });
}

/** The service configuration createClient shares between all services of one client. */
export function createServiceConfig<Transform extends boolean>(
  options: ClientOptions<Transform>,
  servers: Server[],
  securitySchemes: Record<string, SecurityScheme> = {},
): ServiceConfig<Transform> {
  const { send, validate, transform, baseUrl, ...fetchOptions } = options;
  // OpenAPI: without servers, the default server URL is `/`.
  const defaultServer: Server = servers[0] ?? { url: "/" };
  const config: ServiceConfig<Transform> = { send: send ?? createFetchSend({ ...fetchOptions, securitySchemes, baseUrl: baseUrl ?? serverUrl(defaultServer) }) };
  if (validate !== undefined) {
    config.validate = validate;
  }
  if (transform !== undefined) {
    config.transform = transform;
  }
  return config;
}
