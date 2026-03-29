import type {
  FakeYnabState,
  PayeeData,
  QueryParams,
  RouteParams,
  RouteResult,
} from "../state.js";

export function handleGetPayees(
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

  const payeeMap = state.payees.get(planId);
  const allPayees = payeeMap ? Array.from(payeeMap.values()) : [];

  let payees: PayeeData[];
  if (query.last_knowledge_of_server) {
    const sinceKnowledge = Number(query.last_knowledge_of_server);
    const changedIds = state.getChangedEntityIds(
      planId,
      "payees",
      sinceKnowledge,
    );
    payees = allPayees.filter((p) => changedIds.has(p.id));
  } else {
    payees = allPayees.filter((p) => !p.deleted);
  }

  return {
    status: 200,
    body: {
      data: { payees, server_knowledge: state.serverKnowledge },
    },
  };
}
