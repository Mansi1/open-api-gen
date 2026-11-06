// Copied verbatim into every generated client with webhooks or callbacks as runtime/webhooks.ts. It imports only its
// sibling runtime modules, and it must run unchanged in browsers, Node.js and Bun.
// VERIFIED: test/services.test.ts parses webhook and callback payloads through the generated parseWebhook.
import { parseJson, settleUnsafeIntegers } from "./json.js";
import { listIssues } from "./service.js";
import type { Transformer } from "./transform.js";
import { validate, type Issue, type Validator } from "./validation.js";

/** What the generated webhooks.ts knows about one incoming operation. */
export type IncomingDescriptor = {
  operationId: string;
  /** The request body's media type; JSON text is parsed, anything else is passed on as given. */
  contentType?: string;
  validator?: Validator;
  transformer?: Transformer;
};

export type ParseWebhookOptions<Transform extends boolean> = {
  /** Check the payload against its schema and throw WebhookValidationError on a mismatch. */
  validate?: boolean;
  /** Convert the payload to App values: dates, int64, renamed properties, user hooks. */
  transform?: Transform;
};

/** A webhook or callback payload that does not match its schema; thrown only with `validate: true`. */
export class WebhookValidationError extends Error {
  constructor(
    readonly operationId: string,
    readonly issues: Issue[],
    readonly body: unknown,
  ) {
    super(`payload of ${operationId} does not match its schema:\n${listIssues(issues)}`);
    this.name = "WebhookValidationError";
  }
}

function isJson(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

/**
 * Reads an incoming payload: JSON text (a string or bytes, as a server framework hands over the raw body) is parsed,
 * losslessly with `transform` so int64 values stay exact; an already parsed value is used as it is. Then validate,
 * then decode. The API sends the payload, so validation treats it like a response: writeOnly properties may be absent.
 */
export function parseIncoming(descriptor: IncomingDescriptor, body: unknown, options: ParseWebhookOptions<boolean>): unknown {
  const transform = options.transform === true;
  let value = body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    value = new TextDecoder().decode(body);
  }
  if (typeof value === "string" && isJson(descriptor.contentType)) {
    value = value === "" ? undefined : transform ? parseJson(value) : JSON.parse(value);
  }
  if (options.validate === true && descriptor.validator !== undefined) {
    const issues = validate(descriptor.validator, value, "response");
    if (issues.length > 0) {
      throw new WebhookValidationError(descriptor.operationId, issues, settleUnsafeIntegers(value));
    }
  }
  const decoded = transform && descriptor.transformer !== undefined ? descriptor.transformer.decode(value, "") : value;
  return settleUnsafeIntegers(decoded);
}
