import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createYnabMcpServer } from "../server.js";
import { FakeBudgetBuilder } from "./fake-ynab/builder.js";
import {
  createFakeYnabServer,
  type FakeYnabServer,
  type FakeYnabServerOptions,
} from "./fake-ynab/server.js";
import { FakeYnabState } from "./fake-ynab/state.js";

export { FakeBudgetBuilder, FakeYnabState };

export interface IntegrationHarness {
  state: FakeYnabState;
  client: Client;
  /** The fake YNAB HTTP server, for fault injection and abort stats. */
  fake: FakeYnabServer;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export async function createIntegrationHarness(options?: {
  readOnly?: boolean;
  seed?: (builder: FakeBudgetBuilder) => void;
  timeoutMs?: number;
  maxRetries?: number;
  fakeServerOptions?: FakeYnabServerOptions;
}): Promise<IntegrationHarness> {
  // 1. Create state
  const state = new FakeYnabState();

  // 2. Seed if requested
  if (options?.seed) {
    const builder = new FakeBudgetBuilder(state, "budget-1");
    options.seed(builder);
  }

  // 3. Start fake YNAB HTTP server
  const fakeServer = await createFakeYnabServer(
    state,
    options?.fakeServerOptions,
  );

  // 4. Create temp directory for undo store persistence
  const tempDir = await mkdtemp(join(tmpdir(), "ynab-integration-"));

  // 5. Create MCP server
  const { server } = createYnabMcpServer({
    accessToken: "fake-token",
    endpointUrl: fakeServer.url,
    dataDirectory: tempDir,
    readOnly: options?.readOnly,
    timeoutMs: options?.timeoutMs,
    maxRetries: options?.maxRetries,
  });

  // 6. Create linked transports
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  // 7. Create client
  const client = new Client({ name: "test-client", version: "1.0" });

  // 8. Connect both sides
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  // 9. Build harness
  const callTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as
      | Array<{ type: string; text?: string }>
      | undefined;
    const first = content?.[0];

    let parsed: unknown;
    if (first?.type === "text" && first.text !== undefined) {
      try {
        parsed = JSON.parse(first.text);
      } catch {
        parsed = first.text;
      }
    } else {
      parsed = result.content;
    }

    if (result.isError) {
      throw new Error(
        typeof parsed === "string" ? parsed : JSON.stringify(parsed),
      );
    }

    return parsed;
  };

  const close = async (): Promise<void> => {
    await client.close();
    await fakeServer.close();
    await rm(tempDir, { recursive: true, force: true });
  };

  return { state, client, fake: fakeServer, callTool, close };
}
