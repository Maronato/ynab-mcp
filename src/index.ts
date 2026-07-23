#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createYnabMcpServer } from "./server.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

function parseTtlSecondsEnv(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `Invalid ${name} value "${value}". Use a positive number of seconds.`,
    );
  }

  return seconds * 1000;
}

function parsePositiveIntEnv(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${name} value "${value}". Use a positive whole number.`,
    );
  }

  return parsed;
}

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

  const cacheTtlMs = parseTtlSecondsEnv(
    "YNAB_CACHE_TTL",
    process.env.YNAB_CACHE_TTL,
  );
  const pastMonthCacheTtlMs = parseTtlSecondsEnv(
    "YNAB_PAST_MONTH_CACHE_TTL",
    process.env.YNAB_PAST_MONTH_CACHE_TTL,
  );
  const undoHistoryLimit = parsePositiveIntEnv(
    "YNAB_UNDO_HISTORY_LIMIT",
    process.env.YNAB_UNDO_HISTORY_LIMIT,
  );

  const { server } = createYnabMcpServer({
    accessToken,
    endpointUrl,
    dataDirectory,
    version,
    readOnly,
    cacheTtlMs,
    pastMonthCacheTtlMs,
    undoHistoryLimit,
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
