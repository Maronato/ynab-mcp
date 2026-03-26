interface YnabErrorShape {
  error?: {
    id?: string;
  };
}

export function isNotFoundError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "error" in error) {
    const shaped = error as YnabErrorShape;
    return shaped.error?.id === "404" || shaped.error?.id === "not_found";
  }
  return false;
}
