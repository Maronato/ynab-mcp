import { beforeEach, describe, expect, it } from "vitest";

import type { MockAppContext } from "../test-utils.js";
import { captureToolHandlers, createMockContext } from "../test-utils.js";
import { registerSessionTools } from "./sessions.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let tools: Record<string, ToolHandler>;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  ctx = createMockContext();
  tools = captureToolHandlers(registerSessionTools, ctx) as Record<
    string,
    ToolHandler
  >;
});

describe("setup_session", () => {
  it("returns a UUID session id", async () => {
    const result = parseResult(await tools.setup_session({}));
    expect(result.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("returns a different UUID each call", async () => {
    const first = parseResult(await tools.setup_session({}));
    const second = parseResult(await tools.setup_session({}));
    expect(first.session_id).not.toBe(second.session_id);
  });
});
