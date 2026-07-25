import type {
  CategoryData,
  FakeYnabState,
  QueryParams,
  RouteParams,
  RouteResult,
} from "../state.js";

/** GET /plans/:planId/months — month summaries (no categories), delta-capable. */
export function handleGetMonths(
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

  const stored = state.monthDetails.get(planId);
  const allMonths = stored ? Array.from(stored.values()) : [];

  let months = allMonths;
  if (query.last_knowledge_of_server) {
    const sinceKnowledge = Number(query.last_knowledge_of_server);
    const changedIds = state.getChangedEntityIds(
      planId,
      "months",
      sinceKnowledge,
    );
    months = allMonths.filter((m) => changedIds.has(m.month));
  } else {
    months = allMonths.filter((m) => !m.deleted);
  }

  return {
    status: 200,
    body: {
      data: {
        // MonthSummary shape: month detail minus the categories array.
        months: months.map(
          ({ categories: _categories, ...summary }) => summary,
        ),
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}

export function handleGetMonth(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
): RouteResult {
  const { planId, month } = params;

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

  const stored = state.monthDetails.get(planId)?.get(month);

  // Always rebuild the categories array from category groups + month overrides
  // so that PATCH updates to month categories are reflected in GET responses.
  const groups = state.categoryGroups.get(planId) ?? [];
  const monthCats = state.monthCategories.get(planId);

  const categories: CategoryData[] = [];
  for (const group of groups) {
    for (const cat of group.categories) {
      const key = `${month}::${cat.id}`;
      const override = monthCats?.get(key);
      categories.push(override ?? cat);
    }
  }

  if (stored) {
    return {
      status: 200,
      body: { data: { month: { ...stored, categories } } },
    };
  }

  return {
    status: 200,
    body: {
      data: {
        month: {
          month,
          note: null,
          income: 0,
          budgeted: 0,
          activity: 0,
          to_be_budgeted: 0,
          age_of_money: null,
          deleted: false,
          categories,
        },
      },
    },
  };
}
