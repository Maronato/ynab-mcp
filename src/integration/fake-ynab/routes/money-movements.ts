import type {
  FakeYnabState,
  QueryParams,
  RouteParams,
  RouteResult,
} from "../state.js";

export function handleGetMoneyMovements(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
): RouteResult {
  const movements = state.moneyMovements.get(params.planId) ?? [];
  return {
    status: 200,
    body: {
      data: {
        money_movements: movements,
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}

export function handleGetMoneyMovementsByMonth(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
): RouteResult {
  const movements = (state.moneyMovements.get(params.planId) ?? []).filter(
    (movement) => movement.month === params.month,
  );
  return {
    status: 200,
    body: {
      data: {
        money_movements: movements,
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}

export function handleGetMoneyMovementGroups(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
): RouteResult {
  const groups = state.moneyMovementGroups.get(params.planId) ?? [];
  return {
    status: 200,
    body: {
      data: {
        money_movement_groups: groups,
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}

export function handleGetMoneyMovementGroupsByMonth(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
): RouteResult {
  const groups = (state.moneyMovementGroups.get(params.planId) ?? []).filter(
    (group) => group.month === params.month,
  );
  return {
    status: 200,
    body: {
      data: {
        money_movement_groups: groups,
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}
