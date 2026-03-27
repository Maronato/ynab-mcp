import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

import { PayeeProfileAnalyzer } from "./analysis/payee-profiles.js";
import type { AppContext } from "./context.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { SamplingClient } from "./sampling/client.js";
import { registerTools } from "./tools/index.js";
import { UndoEngine } from "./undo/engine.js";
import { UndoStore } from "./undo/store.js";
import { YnabClient } from "./ynab/client.js";

export interface CreateServerOptions {
  accessToken: string;
  dataDirectory: string;
  endpointUrl?: string;
  version?: string;
  readOnly?: boolean;
}

export function createYnabMcpServer(options: CreateServerOptions): {
  server: McpServer;
  context: AppContext;
} {
  const ynabClient = new YnabClient(options.accessToken, options.endpointUrl, {
    readOnly: options.readOnly,
  });
  const undoStore = new UndoStore(options.dataDirectory);
  const undoEngine = new UndoEngine(ynabClient, undoStore);

  const server = new McpServer({
    name: "ynab-mcp-server",
    version: options.version ?? "0.0.0",
  });

  server.server.registerCapabilities({
    sampling: {},
  } as ServerCapabilities);

  const samplingClient = new SamplingClient(server.server);
  const payeeProfileAnalyzer = new PayeeProfileAnalyzer(ynabClient);

  const context: AppContext = {
    ynabClient,
    undoEngine,
    samplingClient,
    payeeProfileAnalyzer,
  };

  registerTools(server, context);
  registerResources(server, context);
  registerPrompts(server);

  return {
    server,
    context,
  };
}
