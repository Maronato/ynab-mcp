import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContext } from "./context.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { registerTools } from "./tools/index.js";
import { UndoEngine } from "./undo/engine.js";
import { UndoStore } from "./undo/store.js";
import { YnabClient } from "./ynab/client.js";

export interface CreateServerOptions {
  accessToken: string;
  dataDirectory: string;
  endpointUrl?: string;
}

export function createYnabMcpServer(options: CreateServerOptions): {
  server: McpServer;
  context: AppContext;
} {
  const ynabClient = new YnabClient(options.accessToken, options.endpointUrl);
  const undoStore = new UndoStore(options.dataDirectory);
  const undoEngine = new UndoEngine(ynabClient, undoStore);

  const context: AppContext = {
    ynabClient,
    undoEngine,
  };

  const server = new McpServer({
    name: "ynab-mcp-server",
    version: "0.1.0",
  });

  registerTools(server, context);
  registerResources(server, context);
  registerPrompts(server);

  return {
    server,
    context,
  };
}
