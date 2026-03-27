interface YnabErrorShape {
  error?: {
    id?: string;
    detail?: string;
  };
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
