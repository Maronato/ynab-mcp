import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContext } from "../context.js";
import { registerCategorizationTools } from "./smart-categorize.js";
import { registerRebalanceTools } from "./smart-rebalance.js";

export function registerSmartTools(
  server: McpServer,
  context: AppContext,
): void {
  registerCategorizationTools(server, context);
  registerRebalanceTools(server, context);
}
