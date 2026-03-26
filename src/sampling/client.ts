import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  CreateMessageRequestParamsBase,
  CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

export class SamplingNotAvailableError extends Error {
  constructor() {
    super("Sampling is not supported by the connected client.");
    this.name = "SamplingNotAvailableError";
  }
}

export class SamplingClient {
  constructor(private readonly server: Server) {}

  isAvailable(): boolean {
    return this.server.getClientCapabilities()?.sampling !== undefined;
  }

  async createMessage(
    params: CreateMessageRequestParamsBase,
  ): Promise<CreateMessageResult> {
    if (!this.isAvailable()) {
      throw new SamplingNotAvailableError();
    }

    return this.server.createMessage(params);
  }

  async createJsonMessage<T>(
    params: CreateMessageRequestParamsBase,
  ): Promise<T> {
    const result = await this.createMessage(params);

    if (result.content.type !== "text") {
      throw new Error("Sampling response did not contain text content.");
    }

    return parseJsonResponse<T>(result.content.text);
  }
}

function parseJsonResponse<T>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");
  return JSON.parse(cleaned) as T;
}
