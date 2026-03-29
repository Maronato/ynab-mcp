import type {
  CategoryData,
  FakeYnabState,
  QueryParams,
  RouteParams,
  RouteResult,
} from "../state.js";

export function handleGetCategories(
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

  const groups = state.categoryGroups.get(planId) ?? [];
  const lastKnowledge = query.last_knowledge_of_server;

  if (lastKnowledge !== undefined) {
    const sinceKnowledge = Number(lastKnowledge);
    const changedIds = state.getChangedEntityIds(
      planId,
      "categories",
      sinceKnowledge,
    );

    // Return only groups that contain at least one changed category
    const filteredGroups = groups.filter((g) =>
      g.categories.some((c) => changedIds.has(c.id)),
    );

    return {
      status: 200,
      body: {
        data: {
          category_groups: filteredGroups,
          server_knowledge: state.serverKnowledge,
        },
      },
    };
  }

  return {
    status: 200,
    body: {
      data: {
        category_groups: groups,
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}

export function handleGetCategoryById(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
): RouteResult {
  const { planId, catId } = params;
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

  const category = state.findCategoryById(planId, catId);
  if (!category) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Category not found",
        },
      },
    };
  }

  return { status: 200, body: { data: { category } } };
}

export function handlePatchCategory(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
  body?: unknown,
): RouteResult {
  const { planId, catId } = params;
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

  const category = state.findCategoryById(planId, catId);
  if (!category) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Category not found",
        },
      },
    };
  }

  const payload = (body as { category?: Partial<CategoryData> } | undefined)
    ?.category;
  if (payload) {
    const patchableFields = [
      "goal_type",
      "goal_target",
      "goal_target_month",
      "goal_day",
      "goal_cadence",
      "goal_cadence_frequency",
      "goal_creation_month",
      "note",
    ] as const;
    for (const field of patchableFields) {
      if (field in payload) {
        (category as unknown as Record<string, unknown>)[field] =
          payload[field];
      }
    }
  }

  state.recordChange(planId, "categories", catId);

  return {
    status: 200,
    body: {
      data: { category, server_knowledge: state.serverKnowledge },
    },
  };
}

export function handleGetMonthCategory(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
): RouteResult {
  const { planId, month, catId } = params;
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

  const monthCatMap = state.monthCategories.get(planId);
  const key = `${month}::${catId}`;
  const monthCategory = monthCatMap?.get(key);

  if (monthCategory) {
    return { status: 200, body: { data: { category: monthCategory } } };
  }

  // Fall back to base category from groups
  const baseCategory = state.findCategoryById(planId, catId);
  if (!baseCategory) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Category not found",
        },
      },
    };
  }

  return { status: 200, body: { data: { category: baseCategory } } };
}

export function handlePatchMonthCategory(
  state: FakeYnabState,
  params: RouteParams,
  _query: QueryParams,
  body?: unknown,
): RouteResult {
  const { planId, month, catId } = params;
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

  const baseCategory = state.findCategoryById(planId, catId);
  if (!baseCategory) {
    return {
      status: 404,
      body: {
        error: {
          id: "404.2",
          name: "resource_not_found",
          detail: "Category not found",
        },
      },
    };
  }

  const payload = (body as { category?: { budgeted: number } } | undefined)
    ?.category;
  const budgeted = payload?.budgeted ?? 0;

  state.ensurePlanMaps(planId);
  const monthCatMap = state.monthCategories.get(planId);
  const key = `${month}::${catId}`;

  let monthCategory = monthCatMap?.get(key);
  if (monthCategory) {
    monthCategory.budgeted = budgeted;
    monthCategory.balance = budgeted + monthCategory.activity;
  } else {
    monthCategory = {
      ...baseCategory,
      budgeted,
      balance: budgeted + baseCategory.activity,
    };
    monthCatMap?.set(key, monthCategory);
  }

  // Also update the base category's budgeted field
  baseCategory.budgeted = budgeted;

  state.recordChange(planId, "categories", catId);

  return {
    status: 200,
    body: {
      data: {
        category: monthCategory,
        server_knowledge: state.serverKnowledge,
      },
    },
  };
}
