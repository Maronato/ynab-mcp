interface YnabErrorShape {
  error?: {
    id?: string;
    detail?: string;
  };
}

/**
 * A YNAB API request exceeded its time budget and was aborted client-side.
 * For writes this outcome is ambiguous: the server may have applied the
 * change before the abort landed, so callers must not assume the write
 * failed.
 */
export class YnabApiTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`YNAB API request timed out after ${timeoutMs / 1000} seconds.`);
    this.name = "YnabApiTimeoutError";
  }
}

/**
 * The generated SDK runtime wraps anything thrown by the configured fetchApi
 * in a FetchError whose message is a generic "The request failed and the
 * interceptors did not return an alternative response", burying our timeout
 * and rate-limit errors. Unwrap to the deepest meaningful cause.
 */
export function unwrapSdkError(error: unknown): unknown {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (
    current instanceof Error &&
    current.name === "FetchError" &&
    current.cause instanceof Error &&
    !seen.has(current)
  ) {
    seen.add(current);
    current = current.cause;
  }
  return current;
}

/** Socket-level error codes where the request may already have been sent. */
const AMBIGUOUS_SOCKET_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
]);

/**
 * True when a failed operation's server-side outcome is unknown: the request
 * may have reached the server and been applied even though the client saw an
 * error. That covers our own timeouts (the request was aborted mid-flight)
 * and socket-level failures (undici's "fetch failed" TypeError, connection
 * resets) — a connection refused outright never reached the server, but it
 * is not reliably distinguishable from a mid-request drop, and for writes a
 * false "maybe applied" warning is far cheaper than a silent maybe-applied
 * write. Definitive API rejections (the server responded with an error
 * body) are not ambiguous.
 */
export function isAmbiguousWriteOutcome(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (current instanceof YnabApiTimeoutError) return true;
    if (current instanceof TypeError && current.message.includes("fetch")) {
      return true;
    }
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && AMBIGUOUS_SOCKET_CODES.has(code)) {
        return true;
      }
    }
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isNotFoundError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "error" in error) {
    const shaped = error as YnabErrorShape;
    const id = shaped.error?.id;
    return (
      id === "not_found" || (typeof id === "string" && id.startsWith("404"))
    );
  }
  return false;
}

/**
 * Extract a human-readable message from any thrown value.
 * The YNAB SDK throws plain objects (not Error instances) for API errors.
 */
export function extractErrorMessage(
  error: unknown,
  fallback = "Unknown error",
): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const shaped = error as YnabErrorShape;
    if (shaped.error?.detail) return shaped.error.detail;
    if ("message" in error)
      return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return fallback;
}
