import type {
  AccountData,
  FakeYnabState,
  QueryParams,
  RouteParams,
  RouteResult,
} from "../state.js";

export function handleGetAccounts(
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

  const accountMap = state.accounts.get(planId);
  const allAccounts = accountMap ? Array.from(accountMap.values()) : [];

  let accounts: AccountData[];
  if (query.last_knowledge_of_server) {
    const sinceKnowledge = Number(query.last_knowledge_of_server);
    const changedIds = state.getChangedEntityIds(
      planId,
      "accounts",
      sinceKnowledge,
    );
    accounts = allAccounts.filter((a) => changedIds.has(a.id));
  } else {
    accounts = allAccounts.filter((a) => !a.deleted);
  }

  return {
    status: 200,
    body: {
      data: { accounts, server_knowledge: state.serverKnowledge },
    },
  };
}
