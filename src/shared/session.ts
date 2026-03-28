import { z } from "zod";

export const DEFAULT_SESSION_ID = "shared";

const SESSION_ID_DESCRIPTION =
  "Session identifier for grouping undo history. Use setup_session to generate one.";

export function sessionIdSchema(required: boolean) {
  const baseSchema = z.string().trim().min(1).describe(SESSION_ID_DESCRIPTION);
  if (required) {
    return baseSchema;
  }

  return baseSchema.optional().default(DEFAULT_SESSION_ID);
}
