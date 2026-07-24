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
import {
  handleGetMoneyMovementGroups,
  handleGetMoneyMovementGroupsByMonth,
  handleGetMoneyMovements,
  handleGetMoneyMovementsByMonth,
} from "./routes/money-movements.js";
import { handleGetMonth, handleGetMonths } from "./routes/months.js";
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
    segments: ["plans", ":planId", "months"],
    handler: handleGetMonths,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "months", ":month"],
    handler: handleGetMonth,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "money_movements"],
    handler: handleGetMoneyMovements,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "months", ":month", "money_movements"],
    handler: handleGetMoneyMovementsByMonth,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "money_movement_groups"],
    handler: handleGetMoneyMovementGroups,
  },
  {
    method: "GET",
    segments: ["plans", ":planId", "months", ":month", "money_movement_groups"],
    handler: handleGetMoneyMovementGroupsByMonth,
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

// ── Fault injection ──

/**
 * A fault to inject into matching requests, for exercising the client's
 * failure paths (timeouts, retries, rate limiting) end-to-end.
 */
export interface FaultRule {
  /** Only match this HTTP method (e.g. "POST"). Matches all when omitted. */
  method?: string;
  /** Only match paths containing this substring. Matches all when omitted. */
  pathIncludes?: string;
  /** Delay before responding (or before applying `status`), in ms. */
  delayMs?: number;
  /** Respond with this status instead of routing to a handler. */
  status?: number;
  /** Response body for `status`; a YNAB-style error body by default. */
  body?: unknown;
  /** Apply to at most this many matching requests. Unlimited when omitted. */
  times?: number;
  /** Let this many matching requests through unharmed before applying. */
  skip?: number;
}

export interface FakeYnabServer {
  server: ReturnType<typeof createServer>;
  url: string;
  close: () => Promise<void>;
  /** Inject a fault for subsequent matching requests. */
  injectFault: (rule: FaultRule) => void;
  /** Remove all injected faults. */
  clearFaults: () => void;
  stats: {
    /** Requests whose client went away before a response was written. */
    abortedRequests: number;
    /** Total requests received, including faulted and aborted ones. */
    totalRequests: number;
  };
}

// ── Public API ──

export interface FakeYnabServerOptions {
  /**
   * Emit an X-Rate-Limit "used/limit" header on responses. The live API
   * stopped sending this header (verified 2026-07); the default mirrors
   * that. Enable to exercise the client's header-reconciliation path,
   * which is kept in case the header returns.
   */
  sendRateLimitHeader?: boolean;
}

export async function createFakeYnabServer(
  state: FakeYnabState,
  options?: FakeYnabServerOptions,
): Promise<FakeYnabServer> {
  let requestCount = 0;
  const faults: Array<{
    rule: FaultRule;
    remaining: number;
    skipRemaining: number;
  }> = [];
  const stats = { abortedRequests: 0, totalRequests: 0 };

  const takeMatchingFault = (
    method: string,
    pathname: string,
  ): FaultRule | undefined => {
    const entry = faults.find(
      ({ rule, remaining }) =>
        remaining > 0 &&
        (!rule.method || rule.method === method) &&
        (!rule.pathIncludes || pathname.includes(rule.pathIncludes)),
    );
    if (!entry) return undefined;
    if (entry.skipRemaining > 0) {
      entry.skipRemaining -= 1;
      return undefined;
    }
    entry.remaining -= 1;
    return entry.rule;
  };

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      stats.totalRequests += 1;
      res.once("close", () => {
        if (!res.writableEnded) stats.abortedRequests += 1;
      });
      try {
        const parsedUrl = new URL(req.url ?? "/", "http://localhost");
        const method = req.method ?? "GET";

        const fault = takeMatchingFault(method, parsedUrl.pathname);
        if (fault?.delayMs) {
          // Sleep, but wake early if the client aborts so the test's
          // event loop isn't held open by orphaned timers.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, fault.delayMs);
            res.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          if (res.destroyed || req.destroyed) return;
        }
        if (fault?.status) {
          res.writeHead(fault.status, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              fault.body ?? {
                error: {
                  id: String(fault.status),
                  name: "injected_error",
                  detail: "Injected fault",
                },
              },
            ),
          );
          return;
        }

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

        // The live API no longer sends X-Rate-Limit (and never sent it on
        // 429s); emit it only when explicitly enabled for header tests.
        requestCount += 1;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (options?.sendRateLimitHeader && result.status !== 429) {
          headers["X-Rate-Limit"] = `${Math.min(requestCount, 200)}/200`;
        }
        res.writeHead(result.status, headers);
        res.end(JSON.stringify(result.body));
      } catch (err) {
        if (res.destroyed || res.headersSent) return;
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

  return {
    server: httpServer,
    url,
    close,
    injectFault: (rule: FaultRule) => {
      faults.push({
        rule,
        remaining: rule.times ?? Number.POSITIVE_INFINITY,
        skipRemaining: rule.skip ?? 0,
      });
    },
    clearFaults: () => {
      faults.length = 0;
    },
    stats,
  };
}
