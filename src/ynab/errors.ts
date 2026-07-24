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

/**
 * True when a failed operation's server-side outcome is unknown: the request
 * may have reached the server and been applied even though the client saw an
 * error. Definitive API rejections (the server responded with an error body)
 * are not ambiguous.
 */
export function isAmbiguousWriteOutcome(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof YnabApiTimeoutError) return true;
    seen.add(current);
    current = current.cause;
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
