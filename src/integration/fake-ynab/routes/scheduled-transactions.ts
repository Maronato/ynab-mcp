import type {
  FakeYnabState,
  QueryParams,
  RouteParams,
  RouteResult,
  ScheduledTransactionData,
} from "../state.js";

const VALID_FREQUENCIES = ["never", "daily", "weekly", "monthly", "yearly"];

function validateFrequency(frequency: string): RouteResult | null {
  if (!VALID_FREQUENCIES.includes(frequency)) {
    return {
      status: 400,
      body: {
        error: {
          id: "400",
          name: "bad_request",
          detail: "Invalid frequency value",
        },
      },
    };
  }
  return null;
}

export function handleGetScheduledTransactions(
  state: FakeYnabState,
  params: RouteParams,
  query: QueryParams,
): RouteResult {
  const { planId } = params;
  if (!state.plans.has(planId)) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Plan not found",
        },
      },
    };
  }

  const stxMap = state.scheduledTransactions.get(planId);
  let scheduled_transactions = stxMap ? Array.from(stxMap.values()) : [];

  const lastKnowledge = query.last_knowledge_of_server;
  if (lastKnowledge !== undefined) {
    const sinceKnowledge = Number(lastKnowledge);
    const changedIds = state.getChangedEntityIds(
      planId,
      "scheduled_transactions",
      sinceKnowledge,
    );
    scheduled_transactions = scheduled_transactions.filter((st) =>
      changedIds.has(st.id),
    );
  }

  return {
    status: 200,
    body: {
      data: {
        scheduled_transactions,
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}

export function handleGetScheduledTransactionById(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
): RouteResult {
  const { planId, stxId } = params;
  if (!state.plans.has(planId)) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Plan not found",
        },
      },
    };
  }

  const stx = state.scheduledTransactions.get(planId)?.get(stxId);
  if (!stx || stx.deleted) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Scheduled transaction not found",
        },
      },
    };
  }

  return { status: 200, body: { data: { scheduled_transaction: stx } } };
}

export function handlePostScheduledTransaction(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
  body?: unknown,
): RouteResult {
  const { planId } = params;
  if (!state.plans.has(planId)) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Plan not found",
        },
      },
    };
  }

  const payload = (
    body as { scheduled_transaction?: Record<string, unknown> } | undefined
  )?.scheduled_transaction;
  if (!payload) {
    return {
      status: 400,
      body: {
        error: {
          id: "400",
          name: "bad_request",
          detail: "Missing scheduled_transaction body",
        },
      },
    };
  }

  const frequency = payload.frequency as string;
  const freqError = validateFrequency(frequency);
  if (freqError) return freqError;

  const id = crypto.randomUUID();
  const accountId = payload.account_id as string;
  const categoryId = (payload.category_id as string | null) ?? null;
  const payeeId = (payload.payee_id as string | null) ?? null;
  const date = payload.date as string;

  const stx: ScheduledTransactionData = {
    id,
    date_first: date,
    date_next: date,
    frequency,
    amount: (payload.amount as number) ?? 0,
    memo: (payload.memo as string | null) ?? null,
    flag_color: (payload.flag_color as string | null) ?? null,
    flag_name: null,
    account_id: accountId,
    payee_id: payeeId,
    category_id: categoryId,
    transfer_account_id: null,
    deleted: false,
    account_name: state.resolveAccountName(planId, accountId),
    payee_name:
      (payload.payee_name as string | null) ??
      state.resolvePayeeName(planId, payeeId),
    category_name: state.resolveCategoryName(planId, categoryId),
    subtransactions: [],
  };

  state.ensurePlanMaps(planId);
  state.scheduledTransactions.get(planId)?.set(id, stx);
  state.recordChange(planId, "scheduled_transactions", id);

  return { status: 201, body: { data: { scheduled_transaction: stx } } };
}

export function handlePutScheduledTransaction(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
  body?: unknown,
): RouteResult {
  const { planId, stxId } = params;
  if (!state.plans.has(planId)) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Plan not found",
        },
      },
    };
  }

  const stx = state.scheduledTransactions.get(planId)?.get(stxId);
  if (!stx) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Scheduled transaction not found",
        },
      },
    };
  }

  const payload = (
    body as { scheduled_transaction?: Record<string, unknown> } | undefined
  )?.scheduled_transaction;
  if (!payload) {
    return {
      status: 400,
      body: {
        error: {
          id: "400",
          name: "bad_request",
          detail: "Missing scheduled_transaction body",
        },
      },
    };
  }

  if (payload.frequency !== undefined) {
    const freqError = validateFrequency(payload.frequency as string);
    if (freqError) return freqError;
  }

  const updatableFields = [
    "date_first",
    "date_next",
    "frequency",
    "amount",
    "memo",
    "flag_color",
    "account_id",
    "payee_id",
    "payee_name",
    "category_id",
    "date",
  ] as const;

  for (const field of updatableFields) {
    if (field in payload) {
      (stx as unknown as Record<string, unknown>)[field] = payload[field];
    }
  }

  // Re-resolve denormalized names
  stx.account_name = state.resolveAccountName(planId, stx.account_id);
  stx.payee_name =
    stx.payee_name ?? state.resolvePayeeName(planId, stx.payee_id);
  stx.category_name = state.resolveCategoryName(planId, stx.category_id);

  state.recordChange(planId, "scheduled_transactions", stxId);

  return {
    status: 200,
    body: { data: { scheduled_transaction: stx } },
  };
}

export function handleDeleteScheduledTransaction(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
): RouteResult {
  const { planId, stxId } = params;
  if (!state.plans.has(planId)) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Plan not found",
        },
      },
    };
  }

  const stx = state.scheduledTransactions.get(planId)?.get(stxId);
  if (!stx) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Scheduled transaction not found",
        },
      },
    };
  }

  stx.deleted = true;
  state.recordChange(planId, "scheduled_transactions", stxId);

  return {
    status: 200,
    body: { data: { scheduled_transaction: stx } },
  };
}
