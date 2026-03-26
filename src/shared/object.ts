export function matchesExpectedState(
  expected: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const currentValue = current[key];

    if (expectedValue !== null && typeof expectedValue === "object") {
      if (
        currentValue === null ||
        typeof currentValue !== "object" ||
        Array.isArray(currentValue)
      ) {
        return false;
      }

      if (
        !matchesExpectedState(
          expectedValue as Record<string, unknown>,
          currentValue as Record<string, unknown>,
        )
      ) {
        return false;
      }

      continue;
    }

    if (expectedValue !== currentValue) {
      return false;
    }
  }

  return true;
}
