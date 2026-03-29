import type {
  FakeYnabState,
  QueryParams,
  RouteParams,
  RouteResult,
} from "../state.js";

export function handleGetPlans(
  state: FakeYnabState,
  _params: RouteParams,
  _query: QueryParams,
): RouteResult {
  const plans = Array.from(state.plans.values()).map((p) => ({
    id: p.id,
    name: p.name,
    last_modified_on: p.last_modified_on,
    first_month: p.first_month,
    last_month: p.last_month,
    date_format: p.date_format,
    currency_format: p.currency_format,
  }));

  return { status: 200, body: { data: { plans } } };
}

export function handleGetPlanSettings(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
): RouteResult {
  const plan = state.plans.get(params.planId);
  if (!plan) {
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

  return {
    status: 200,
    body: {
      data: {
        settings: {
          date_format: plan.settings.date_format,
          currency_format: plan.settings.currency_format,
        },
      },
    },
  };
}
