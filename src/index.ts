#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createYnabMcpServer } from "./server.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

function parseBooleanEnv(
  name: string,
  value: string | undefined,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  throw new Error(
    `Invalid ${name} value "${value}". Use "true", "false", "1", or "0".`,
  );
}

async function main(): Promise<void> {
  const accessToken = process.env.YNAB_API_TOKEN;
  if (!accessToken) {
    throw new Error("YNAB_API_TOKEN is required.");
  }

  const endpointUrl = process.env.YNAB_API_URL;
  const dataDirectory =
    process.env.YNAB_MCP_DATA_DIR ?? join(homedir(), ".ynab-mcp");
  await mkdir(dataDirectory, { recursive: true });

  const readOnly =
    parseBooleanEnv("YNAB_READ_ONLY", process.env.YNAB_READ_ONLY) ?? false;
  const requireSession =
    parseBooleanEnv("YNAB_REQUIRE_SESSION", process.env.YNAB_REQUIRE_SESSION) ??
    false;

  const { server } = createYnabMcpServer({
    accessToken,
    endpointUrl,
    dataDirectory,
    version,
    readOnly,
    requireSession,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
