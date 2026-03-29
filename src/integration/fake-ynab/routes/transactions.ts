import { randomUUID } from "node:crypto";
import type {
  FakeYnabState,
  QueryParams,
  RouteParams,
  RouteResult,
  SubTransactionData,
  TransactionData,
} from "../state.js";

// ── Helpers ──

function notFound(detail: string): RouteResult {
  return {
    status: 404,
    body: { error: { id: "404.2", name: "resource_not_found", detail } },
  };
}

function getPlanTxMap(
  state: FakeYnabState,
  planId: string,
): Map<string, TransactionData> | null {
  if (!state.plans.has(planId)) return null;
  return state.transactions.get(planId) ?? new Map();
}

interface SaveSubTx {
  amount: number;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  memo?: string | null;
}

interface SaveTx {
  account_id: string;
  date: string;
  amount: number;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  memo?: string | null;
  cleared?: "cleared" | "uncleared" | "reconciled";
  approved?: boolean;
  flag_color?: string | null;
  flag_name?: string | null;
  subtransactions?: SaveSubTx[];
}

interface SaveTxWithId extends SaveTx {
  id: string;
}

function buildSubTransactions(
  state: FakeYnabState,
  planId: string,
  transactionId: string,
  subs: SaveSubTx[] | undefined,
): SubTransactionData[] {
  if (!subs || subs.length === 0) return [];
  return subs.map((sub) => ({
    id: randomUUID(),
    transaction_id: transactionId,
    amount: sub.amount,
    memo: sub.memo ?? null,
    payee_id: sub.payee_id ?? null,
    payee_name:
      sub.payee_name ?? state.resolvePayeeName(planId, sub.payee_id ?? null),
    category_id: sub.category_id ?? null,
    category_name: state.resolveCategoryName(planId, sub.category_id ?? null),
    transfer_account_id: null,
    transfer_transaction_id: null,
    deleted: false,
  }));
}

function buildTransaction(
  state: FakeYnabState,
  planId: string,
  save: SaveTx,
): TransactionData {
  const id = randomUUID();
  const subtransactions = buildSubTransactions(
    state,
    planId,
    id,
    save.subtransactions,
  );
  return {
    id,
    date: save.date,
    amount: save.amount,
    memo: save.memo ?? null,
    cleared: save.cleared ?? "uncleared",
    approved: save.approved ?? true,
    flag_color: save.flag_color ?? null,
    flag_name: save.flag_name ?? null,
    account_id: save.account_id,
    payee_id: save.payee_id ?? null,
    category_id: save.category_id ?? null,
    transfer_account_id: null,
    transfer_transaction_id: null,
    matched_transaction_id: null,
    import_id: null,
    import_payee_name: null,
    import_payee_name_original: null,
    debt_transaction_type: null,
    deleted: false,
    account_name: state.resolveAccountName(planId, save.account_id),
    payee_name:
      save.payee_name ?? state.resolvePayeeName(planId, save.payee_id ?? null),
    category_name: state.resolveCategoryName(planId, save.category_id ?? null),
    subtransactions,
  };
}

function adjustAccountBalance(
  state: FakeYnabState,
  planId: string,
  accountId: string,
  delta: number,
): void {
  const account = state.accounts.get(planId)?.get(accountId);
  if (account) {
    account.balance += delta;
    state.recordChange(planId, "accounts", accountId);
  }
}

// ── Route handlers ──

/** GET /plans/:planId/transactions */
export function listTransactions(
  state: FakeYnabState,
  params: RouteParams,
  query: QueryParams,
): RouteResult {
  const planId = params.planId;
  const txMap = getPlanTxMap(state, planId);
  if (!txMap) return notFound(`Plan ${planId} not found`);

  let transactions: TransactionData[];

  const lastKnowledge = query.last_knowledge_of_server;
  if (lastKnowledge !== undefined) {
    // Delta sync: return only changed transactions (including deleted)
    const changedIds = state.getChangedEntityIds(
      planId,
      "transactions",
      Number(lastKnowledge),
    );
    transactions = [];
    for (const id of changedIds) {
      const tx = txMap.get(id);
      if (tx) transactions.push(tx);
    }
  } else {
    // Full sync: exclude deleted
    transactions = [...txMap.values()].filter((tx) => !tx.deleted);
  }

  // Filter by type
  const type = query.type;
  if (type === "uncategorized") {
    transactions = transactions.filter((tx) => tx.category_id === null);
  } else if (type === "unapproved") {
    transactions = transactions.filter((tx) => !tx.approved);
  }

  // Filter by since_date
  const sinceDate = query.since_date;
  if (sinceDate) {
    transactions = transactions.filter((tx) => tx.date >= sinceDate);
  }

  return {
    status: 200,
    body: {
      data: {
        transactions,
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}

/** GET /plans/:planId/transactions/:txId */
export function getTransaction(
  state: FakeYnabState,
  params: RouteParams,
): RouteResult {
  const planId = params.planId;
  const txId = params.txId;
  const txMap = getPlanTxMap(state, planId);
  if (!txMap) return notFound(`Plan ${planId} not found`);

  const tx = txMap.get(txId);
  if (!tx || tx.deleted) return notFound(`Transaction ${txId} not found`);

  return {
    status: 200,
    body: { data: { transaction: tx } },
  };
}

/** POST /plans/:planId/transactions */
export function createTransactions(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
  body?: unknown,
): RouteResult {
  const planId = params.planId;
  const txMap = getPlanTxMap(state, planId);
  if (!txMap) return notFound(`Plan ${planId} not found`);

  const payload = body as {
    transaction?: SaveTx;
    transactions?: SaveTx[];
  };

  const saves: SaveTx[] = [];
  if (payload?.transactions) {
    saves.push(...payload.transactions);
  } else if (payload?.transaction) {
    saves.push(payload.transaction);
  }

  const created: TransactionData[] = [];
  const transactionIds: string[] = [];

  for (const save of saves) {
    // Validate subtransaction amounts sum to parent amount
    if (save.subtransactions && save.subtransactions.length > 0) {
      const subSum = save.subtransactions.reduce((s, sub) => s + sub.amount, 0);
      if (subSum !== save.amount) {
        return {
          status: 400,
          body: {
            error: {
              id: "400",
              name: "bad_request",
              detail: "Subtransaction amounts must sum to parent amount",
            },
          },
        };
      }
    }

    const tx = buildTransaction(state, planId, save);
    txMap.set(tx.id, tx);
    adjustAccountBalance(state, planId, tx.account_id, tx.amount);
    state.recordChange(planId, "transactions", tx.id);
    created.push(tx);
    transactionIds.push(tx.id);
  }

  return {
    status: 201,
    body: {
      data: {
        transaction_ids: transactionIds,
        transactions: created,
        duplicate_import_ids: [],
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}

/** PATCH /plans/:planId/transactions */
export function updateTransactions(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
  body?: unknown,
): RouteResult {
  const planId = params.planId;
  const txMap = getPlanTxMap(state, planId);
  if (!txMap) return notFound(`Plan ${planId} not found`);

  const payload = body as { transactions: SaveTxWithId[] };
  const saves = payload?.transactions ?? [];

  const updated: TransactionData[] = [];
  const transactionIds: string[] = [];

  for (const save of saves) {
    const existing = txMap.get(save.id);
    if (!existing || existing.deleted) {
      // Per spec: 404 per-transaction but continue processing others
      continue;
    }

    const isSplit = existing.subtransactions.length > 0;

    // Adjust account balance for amount changes
    if (save.amount !== undefined) {
      const delta = save.amount - existing.amount;
      adjustAccountBalance(state, planId, existing.account_id, delta);
      existing.amount = save.amount;
    }

    // Update fields that are always allowed
    if (save.memo !== undefined) existing.memo = save.memo ?? null;
    if (save.flag_color !== undefined)
      existing.flag_color = save.flag_color ?? null;
    if (save.flag_name !== undefined)
      existing.flag_name = save.flag_name ?? null;
    if (save.date !== undefined) existing.date = save.date;
    if (save.payee_id !== undefined) {
      existing.payee_id = save.payee_id ?? null;
      existing.payee_name =
        save.payee_name ??
        state.resolvePayeeName(planId, save.payee_id ?? null);
    } else if (save.payee_name !== undefined) {
      existing.payee_name = save.payee_name ?? null;
    }
    if (save.cleared !== undefined) existing.cleared = save.cleared;
    if (save.approved !== undefined) existing.approved = save.approved;

    // QUIRK: Split frozen fields — ignore category_id and subtransactions changes on splits
    if (!isSplit) {
      if (save.category_id !== undefined) {
        existing.category_id = save.category_id ?? null;
        existing.category_name = state.resolveCategoryName(
          planId,
          save.category_id ?? null,
        );
      }
      if (save.subtransactions !== undefined) {
        // Validate subtransaction amounts sum to parent amount
        if (save.subtransactions.length > 0) {
          const subSum = save.subtransactions.reduce(
            (s, sub) => s + sub.amount,
            0,
          );
          const parentAmount =
            save.amount !== undefined ? save.amount : existing.amount;
          if (subSum !== parentAmount) {
            return {
              status: 400,
              body: {
                error: {
                  id: "400",
                  name: "bad_request",
                  detail: "Subtransaction amounts must sum to parent amount",
                },
              },
            };
          }
        }
        existing.subtransactions = buildSubTransactions(
          state,
          planId,
          existing.id,
          save.subtransactions,
        );
      }
    }

    state.recordChange(planId, "transactions", existing.id);
    updated.push(existing);
    transactionIds.push(existing.id);
  }

  return {
    status: 200,
    body: {
      data: {
        transaction_ids: transactionIds,
        transactions: updated,
        duplicate_import_ids: [],
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}

/** DELETE /plans/:planId/transactions/:txId */
export function deleteTransaction(
  state: FakeYnabState,
  params: RouteParams,
): RouteResult {
  const planId = params.planId;
  const txId = params.txId;
  const txMap = getPlanTxMap(state, planId);
  if (!txMap) return notFound(`Plan ${planId} not found`);

  const tx = txMap.get(txId);
  if (!tx || tx.deleted) return notFound(`Transaction ${txId} not found`);

  tx.deleted = true;

  // Reverse the amount on the account balance
  adjustAccountBalance(state, planId, tx.account_id, -tx.amount);

  // QUIRK: Phantom budget activity — do NOT adjust category activity.
  // The phantom activity stays for splits (and we skip for non-splits too
  // since the MCP server handles it via cache invalidation).

  state.recordChange(planId, "transactions", tx.id);

  return {
    status: 200,
    body: {
      data: {
        transaction: tx,
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}
