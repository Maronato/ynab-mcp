export function matchesExpectedState(
  expected: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const currentValue = current[key];

    if (expectedValue !== null && typeof expectedValue === "object") {
      if (currentValue === null || typeof currentValue !== "object") {
        return false;
      }

      if (Array.isArray(expectedValue)) {
        if (!Array.isArray(currentValue)) return false;
        if (!arraysMatchExpected(expectedValue, currentValue)) return false;
        continue;
      }

      if (Array.isArray(currentValue)) return false;

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

function arraysMatchExpected(expected: unknown[], current: unknown[]): boolean {
  if (expected.length !== current.length) return false;

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const cur = current[i];

    if (exp !== null && typeof exp === "object" && !Array.isArray(exp)) {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
        return false;
      }
      if (
        !matchesExpectedState(
          exp as Record<string, unknown>,
          cur as Record<string, unknown>,
        )
      ) {
        return false;
      }
    } else if (exp !== cur) {
      return false;
    }
  }

  return true;
}
