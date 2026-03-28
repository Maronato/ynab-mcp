import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getKnowledgeTopics } from "../methodology/index.js";

export function registerResources(server: McpServer): void {
  registerKnowledgeResources(server);
}

function registerKnowledgeResources(server: McpServer): void {
  for (const topic of getKnowledgeTopics()) {
    server.registerResource(
      `knowledge-${topic.name}`,
      `ynab://knowledge/${topic.name}`,
      {
        title: topic.title,
        description: topic.description,
        mimeType: "text/markdown",
      },
      (uri) => ({
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: topic.content,
          },
        ],
      }),
    );
  }
}
