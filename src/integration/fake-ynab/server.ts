import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type {
  FakeYnabState,
  QueryParams,
  RouteParams,
  RouteResult,
} from "./state.js";

// ── Route handler imports ──

import { handleGetAccounts } from "./routes/accounts.js";
import {
  handleGetCategories,
  handleGetCategoryById,
  handleGetMonthCategory,
  handlePatchCategory,
  handlePatchMonthCategory,
} from "./routes/categories.js";
import { handleGetMonth } from "./routes/months.js";
import { handleGetPayees } from "./routes/payees.js";
import { handleGetPlanSettings, handleGetPlans } from "./routes/plans.js";
import {
  handleDeleteScheduledTransaction,
  handleGetScheduledTransactionById,
  handleGetScheduledTransactions,
  handlePostScheduledTransaction,
  handlePutScheduledTransaction,
} from "./routes/scheduled-transactions.js";
import {
  createTransactions,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransactions,
} from "./routes/transactions.js";

// ── Types ──

type RouteHandler = (
  state: FakeYnabState,
  params: RouteParams,
  query: QueryParams,
  body?: unknown,
) => RouteResult;

interface RouteDefinition {
  method: string;
  /** Segment patterns, e.g. ["plans", ":planId", "transactions"] */
  segments: string[];
  handler: RouteHandler;
}

// ── Route table ──

const routes: RouteDefinition[] = [
  { method: "GET", segments: ["plans"], handler: handleGetPlans },
  {
    method: "GET",
    segments: ["plans", ":planId", "settings"],
    handler: handleGetPlanSettings,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "accounts"],
    handler: handleGetAccounts,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "categories"],
    handler: handleGetCategories,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "categories", ":catId"],
    handler: handleGetCategoryById,
  },
  {
    method: "PATCH",
    segments: ["plans", ":planId", "categories", ":catId"],
    handler: handlePatchCategory,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "months", ":month", "categories", ":catId"],
    handler: handleGetMonthCategory,
  },
  {
    method: "PATCH",
    segments: ["plans", ":planId", "months", ":month", "categories", ":catId"],
    handler: handlePatchMonthCategory,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "transactions"],
    handler: listTransactions,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "transactions", ":txId"],
    handler: getTransaction,
  },
  {
    method: "POST",
    segments: ["plans", ":planId", "transactions"],
    handler: createTransactions,
  },
  {
    method: "PATCH",
    segments: ["plans", ":planId", "transactions"],
    handler: updateTransactions,
  },
  {
    method: "DELETE",
    segments: ["plans", ":planId", "transactions", ":txId"],
    handler: deleteTransaction,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "scheduled_transactions"],
    handler: handleGetScheduledTransactions,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "scheduled_transactions", ":stxId"],
    handler: handleGetScheduledTransactionById,
  },
  {
    method: "POST",
    segments: ["plans", ":planId", "scheduled_transactions"],
    handler: handlePostScheduledTransaction,
  },
  {
    method: "PUT",
    segments: ["plans", ":planId", "scheduled_transactions", ":stxId"],
    handler: handlePutScheduledTransaction,
  },
  {
    method: "DELETE",
    segments: ["plans", ":planId", "scheduled_transactions", ":stxId"],
    handler: handleDeleteScheduledTransaction,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "payees"],
    handler: handleGetPayees,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "months", ":month"],
    handler: handleGetMonth,
  },
];

// ── Router ──

function matchRoute(
  method: string,
  pathSegments: string[],
): { handler: RouteHandler; params: RouteParams } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== pathSegments.length) continue;

    const params: RouteParams = {};
    let matched = true;

    for (let i = 0; i < route.segments.length; i++) {
      const pattern = route.segments[i];
      const actual = pathSegments[i];
      if (pattern.startsWith(":")) {
        params[pattern.slice(1)] = actual;
      } else if (pattern !== actual) {
        matched = false;
        break;
      }
    }

    if (matched) return { handler: route.handler, params };
  }
  return null;
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// ── Public API ──

export async function createFakeYnabServer(state: FakeYnabState): Promise<{
  server: ReturnType<typeof createServer>;
  url: string;
  close: () => Promise<void>;
}> {
  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const parsedUrl = new URL(req.url ?? "/", "http://localhost");
        const method = req.method ?? "GET";
        const pathSegments = parsedUrl.pathname
          .split("/")
          .filter((s) => s.length > 0);

        // Strip leading "v1" prefix if present (YNAB API uses /v1/...)
        if (pathSegments[0] === "v1") {
          pathSegments.shift();
        }

        // Convert search params to query object
        const query: QueryParams = {};
        for (const [key, value] of parsedUrl.searchParams) {
          query[key] = value;
        }

        const match = matchRoute(method, pathSegments);
        if (!match) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                id: "404.2",
                name: "resource_not_found",
                detail: "Route not found",
              },
            }),
          );
          return;
        }

        // Parse body for methods that have one
        let body: unknown;
        if (method === "POST" || method === "PATCH" || method === "PUT") {
          body = await parseBody(req);
        }

        const result: RouteResult = match.handler(
          state,
          match.params,
          query,
          body,
        );

        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              id: "500",
              name: "internal_error",
              detail: err instanceof Error ? err.message : "Unknown error",
            },
          }),
        );
      }
    },
  );

  // Listen on ephemeral port — await the callback so address() is available
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  const address = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });

  return { server: httpServer, url, close };
}
