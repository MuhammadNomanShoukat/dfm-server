import { query } from '../../db/pool.js';

export type WorkflowItem = {
  key: string;
  label: string;
  count: number;
  route: string;
  completed: boolean;
  priority: 'low' | 'normal' | 'high' | 'urgent';
};

export type AttentionAnimal = {
  id: string;
  animalCode: string;
  name: string | null;
  reason: string;
  severity: 'info' | 'warning' | 'error';
  lastActivity: string | null;
};

export async function loadActionDashboard(farmId: string, userId: string) {
  const [
    attentionAnimals,
    vaccinationsDue,
    expectedCalvings,
    belowTargetWeight,
    feedPurchaseEstimate,
    financialOverview,
    milkTrend,
    alerts,
    workflowCompletions,
    workflowCounts,
  ] = await Promise.all([
    loadAttentionAnimals(farmId),
    loadVaccinationsDue(farmId),
    loadExpectedCalvings(farmId),
    loadBelowTargetWeight(farmId),
    loadFeedPurchaseEstimate(farmId),
    loadFinancialOverview(farmId),
    loadMilkTrend(farmId),
    loadAlerts(farmId),
    loadWorkflowCompletions(farmId, userId),
    loadWorkflowCounts(farmId),
  ]);

  const completedKeys = new Set(workflowCompletions);
  const todaysWorkflow = buildTodaysWorkflow(workflowCounts, completedKeys);

  return {
    todaysWorkflow,
    attentionAnimals,
    vaccinationsDue,
    expectedCalvings,
    belowTargetWeight,
    feedPurchaseEstimate,
    financialOverview,
    milkTrend,
    alerts,
  };
}

async function loadAttentionAnimals(farmId: string): Promise<AttentionAnimal[]> {
  const sick = await query<{
    id: string;
    animal_code: string;
    name: string | null;
    updated_at: string;
  }>(
    `SELECT id, animal_code, name, updated_at::text
     FROM animals
     WHERE farm_id = $1 AND deleted_at IS NULL AND status = 'sick'
     ORDER BY updated_at DESC LIMIT 10`,
    [farmId],
  );

  const yieldDrop = await query<{
    id: string;
    animal_code: string;
    name: string | null;
    current: string;
    previous: string;
  }>(
    `WITH recent AS (
       SELECT animal_id, SUM(quantity_liters) AS qty
       FROM milk_records
       WHERE farm_id = $1 AND recorded_at >= now() - interval '7 days'
       GROUP BY animal_id
     ), prior AS (
       SELECT animal_id, SUM(quantity_liters) AS qty
       FROM milk_records
       WHERE farm_id = $1 AND recorded_at >= now() - interval '14 days'
         AND recorded_at < now() - interval '7 days'
       GROUP BY animal_id
     )
     SELECT a.id, a.animal_code, a.name, recent.qty::text AS current, prior.qty::text AS previous
     FROM recent
     JOIN prior ON prior.animal_id = recent.animal_id
     JOIN animals a ON a.id = recent.animal_id AND a.deleted_at IS NULL
     WHERE prior.qty > 0 AND recent.qty < prior.qty * 0.8
     LIMIT 5`,
    [farmId],
  );

  return [
    ...sick.rows.map((row) => ({
      id: row.id,
      animalCode: row.animal_code,
      name: row.name,
      reason: 'Health attention required',
      severity: 'error' as const,
      lastActivity: row.updated_at,
    })),
    ...yieldDrop.rows.map((row) => ({
      id: row.id,
      animalCode: row.animal_code,
      name: row.name,
      reason: `Yield drop: ${Number(row.current).toFixed(1)} L vs ${Number(row.previous).toFixed(1)} L last week`,
      severity: 'warning' as const,
      lastActivity: null,
    })),
  ];
}

async function loadVaccinationsDue(farmId: string) {
  const result = await query<{
    id: string;
    animal_id: string;
    animal_code: string;
    name: string | null;
    vaccine_name: string;
    next_due_on: string;
  }>(
    `SELECT v.id, v.animal_id, a.animal_code, a.name, v.vaccine_name, v.next_due_on::text
     FROM vaccinations v
     JOIN animals a ON a.id = v.animal_id AND a.deleted_at IS NULL
     WHERE v.farm_id = $1 AND v.next_due_on IS NOT NULL
       AND v.next_due_on <= CURRENT_DATE + 30
     ORDER BY v.next_due_on
     LIMIT 15`,
    [farmId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    animalId: row.animal_id,
    animalCode: row.animal_code,
    name: row.name,
    vaccine: row.vaccine_name,
    dueDate: row.next_due_on,
    status: row.next_due_on <= new Date().toISOString().slice(0, 10) ? 'overdue' : 'due_soon',
  }));
}

async function loadExpectedCalvings(farmId: string) {
  const result = await query<{
    id: string;
    animal_id: string;
    animal_code: string;
    name: string | null;
    expected_calving_date: string;
  }>(
    `SELECT b.id, b.animal_id, a.animal_code, a.name, b.expected_calving_date::text
     FROM breeding_records b
     JOIN animals a ON a.id = b.animal_id AND a.deleted_at IS NULL
     WHERE b.farm_id = $1
       AND b.expected_calving_date IS NOT NULL
       AND b.expected_calving_date >= CURRENT_DATE - 7
       AND b.expected_calving_date <= CURRENT_DATE + 60
     ORDER BY b.expected_calving_date
     LIMIT 15`,
    [farmId],
  );
  const today = new Date();
  return result.rows.map((row) => {
    const due = new Date(row.expected_calving_date);
    const daysRemaining = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    return {
      id: row.id,
      animalId: row.animal_id,
      animalCode: row.animal_code,
      name: row.name,
      expectedDate: row.expected_calving_date,
      daysRemaining,
      status: daysRemaining <= 7 ? 'imminent' : 'upcoming',
    };
  });
}

async function loadBelowTargetWeight(farmId: string) {
  const result = await query<{
    id: string;
    animal_code: string;
    name: string | null;
    weight_kg: string;
    target_weight_kg: string;
    prev_weight: string | null;
  }>(
    `SELECT a.id, a.animal_code, a.name, a.weight_kg::text, a.target_weight_kg::text,
            (
              SELECT w.weight_kg::text FROM animal_weight_records w
              WHERE w.animal_id = a.id
              ORDER BY w.recorded_at DESC OFFSET 1 LIMIT 1
            ) AS prev_weight
     FROM animals a
     WHERE a.farm_id = $1 AND a.deleted_at IS NULL
       AND a.target_weight_kg IS NOT NULL AND a.weight_kg IS NOT NULL
       AND a.weight_kg < a.target_weight_kg
       AND a.status NOT IN ('sold', 'dead')
     ORDER BY (a.target_weight_kg - a.weight_kg) DESC
     LIMIT 10`,
    [farmId],
  );
  return result.rows.map((row) => {
    const current = Number(row.weight_kg);
    const target = Number(row.target_weight_kg);
    const prev = row.prev_weight ? Number(row.prev_weight) : null;
    let trend: 'down' | 'up' | 'stable' = 'stable';
    if (prev !== null) {
      if (current < prev) {
        trend = 'down';
      } else if (current > prev) {
        trend = 'up';
      }
    }
    return {
      id: row.id,
      animalCode: row.animal_code,
      name: row.name,
      currentWeight: current,
      targetWeight: target,
      difference: target - current,
      trend,
    };
  });
}

async function loadFeedPurchaseEstimate(farmId: string) {
  const stock = await query<{
    feed_type_id: string;
    name: string;
    quantity: string;
    reorder_level: string;
    unit_cost: string;
    unit: string;
  }>(
    `SELECT ft.id AS feed_type_id, ft.name, i.quantity::text, i.reorder_level::text,
            ft.unit_cost::text, ft.unit
     FROM feed_inventory i
     JOIN feed_types ft ON ft.id = i.feed_type_id
     WHERE i.farm_id = $1
     ORDER BY (i.quantity / NULLIF(i.reorder_level, 0)) ASC
     LIMIT 1`,
    [farmId],
  );

  if (!stock.rows[0]) {
    return null;
  }

  const row = stock.rows[0];
  const consumption = await query<{ daily: string }>(
    `SELECT COALESCE(SUM(quantity) / NULLIF(COUNT(DISTINCT consumed_at), 0), 0)::text AS daily
     FROM feed_consumptions
     WHERE farm_id = $1 AND feed_type_id = $2
       AND consumed_at >= CURRENT_DATE - 30`,
    [farmId, row.feed_type_id],
  );

  const daily = Math.max(Number(consumption.rows[0]?.daily ?? 0), 0.1);
  const currentStock = Number(row.quantity);
  const daysLeft = Math.floor(currentStock / daily);
  const purchaseDate = new Date();
  purchaseDate.setDate(purchaseDate.getDate() + Math.max(daysLeft - 3, 0));
  const reorderQty = Number(row.reorder_level) * 2;
  const estimatedCost = reorderQty * Number(row.unit_cost);

  return {
    feedType: row.name,
    currentStock,
    unit: row.unit,
    averageDailyConsumption: Math.round(daily * 10) / 10,
    estimatedQuantity: reorderQty,
    estimatedCost: Math.round(estimatedCost),
    estimatedPurchaseDate: purchaseDate.toISOString().slice(0, 10),
    currency: 'PKR',
  };
}

async function loadFinancialOverview(farmId: string) {
  const totals = await query<{
    total_revenue: string;
    total_expenses: string;
    month_revenue: string;
    month_expenses: string;
    prev_revenue: string;
    prev_expenses: string;
  }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE entry_type = 'income'), 0)::text AS total_revenue,
       COALESCE(SUM(amount) FILTER (WHERE entry_type = 'expense'), 0)::text AS total_expenses,
       COALESCE(SUM(amount) FILTER (WHERE entry_type = 'income'
         AND entry_date >= date_trunc('month', CURRENT_DATE)), 0)::text AS month_revenue,
       COALESCE(SUM(amount) FILTER (WHERE entry_type = 'expense'
         AND entry_date >= date_trunc('month', CURRENT_DATE)), 0)::text AS month_expenses,
       COALESCE(SUM(amount) FILTER (WHERE entry_type = 'income'
         AND entry_date >= date_trunc('month', CURRENT_DATE - interval '1 month')
         AND entry_date < date_trunc('month', CURRENT_DATE)), 0)::text AS prev_revenue,
       COALESCE(SUM(amount) FILTER (WHERE entry_type = 'expense'
         AND entry_date >= date_trunc('month', CURRENT_DATE - interval '1 month')
         AND entry_date < date_trunc('month', CURRENT_DATE)), 0)::text AS prev_expenses
     FROM finance_entries WHERE farm_id = $1`,
    [farmId],
  );

  const trend = await query<{ month: string; revenue: string; expenses: string }>(
    `SELECT to_char(date_trunc('month', entry_date), 'YYYY-MM') AS month,
            COALESCE(SUM(amount) FILTER (WHERE entry_type = 'income'), 0)::text AS revenue,
            COALESCE(SUM(amount) FILTER (WHERE entry_type = 'expense'), 0)::text AS expenses
     FROM finance_entries
     WHERE farm_id = $1 AND entry_date >= date_trunc('month', CURRENT_DATE - interval '5 months')
     GROUP BY date_trunc('month', entry_date)
     ORDER BY month`,
    [farmId],
  );

  const row = totals.rows[0];
  const monthRevenue = Number(row.month_revenue);
  const monthExpenses = Number(row.month_expenses);
  const prevRevenue = Number(row.prev_revenue);
  const prevExpenses = Number(row.prev_expenses);

  const pctChange = (current: number, previous: number): number | null => {
    if (previous === 0) {
      return current > 0 ? 100 : null;
    }
    return Math.round(((current - previous) / previous) * 1000) / 10;
  };

  return {
    totalRevenue: Number(row.total_revenue),
    totalExpenses: Number(row.total_expenses),
    monthRevenue,
    monthExpenses,
    prevMonthRevenue: prevRevenue,
    prevMonthExpenses: prevExpenses,
    revenueChangePct: pctChange(monthRevenue, prevRevenue),
    expenseChangePct: pctChange(monthExpenses, prevExpenses),
    netPosition: Number(row.total_revenue) - Number(row.total_expenses),
    monthNet: monthRevenue - monthExpenses,
    revenueTrend: trend.rows.map((r) => ({ month: r.month, amount: Number(r.revenue) })),
    expenseTrend: trend.rows.map((r) => ({ month: r.month, amount: Number(r.expenses) })),
    currency: 'PKR',
  };
}

async function loadMilkTrend(farmId: string) {
  const result = await query<{ day: string; liters: string }>(
    `SELECT to_char(recorded_at::date, 'YYYY-MM-DD') AS day,
            SUM(quantity_liters)::text AS liters
     FROM milk_records
     WHERE farm_id = $1 AND recorded_at >= now() - interval '30 days'
     GROUP BY recorded_at::date
     ORDER BY day`,
    [farmId],
  );
  return result.rows;
}

async function loadAlerts(farmId: string) {
  const result = await query(
    `SELECT id, alert_type, severity, title, body, created_at
     FROM ai_alerts WHERE farm_id = $1 AND is_open = true
     ORDER BY created_at DESC LIMIT 8`,
    [farmId],
  );
  return result.rows;
}

async function loadWorkflowCompletions(farmId: string, userId: string): Promise<string[]> {
  const result = await query<{ workflow_key: string }>(
    `SELECT workflow_key FROM workflow_completions
     WHERE user_id = $1 AND farm_id = $2 AND completed_on = CURRENT_DATE`,
    [userId, farmId],
  );
  return result.rows.map((r) => r.workflow_key);
}

async function loadWorkflowCounts(farmId: string) {
  const [sick, vaccines, calvings, lowWeight, milkToday, openTasks, expensesToday] = await Promise.all([
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM animals
       WHERE farm_id = $1 AND deleted_at IS NULL AND status = 'sick'`,
      [farmId],
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM vaccinations v
       JOIN animals a ON a.id = v.animal_id AND a.deleted_at IS NULL
       WHERE v.farm_id = $1 AND v.next_due_on <= CURRENT_DATE + 14`,
      [farmId],
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM breeding_records
       WHERE farm_id = $1 AND expected_calving_date IS NOT NULL
         AND expected_calving_date <= CURRENT_DATE + 30`,
      [farmId],
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM animals
       WHERE farm_id = $1 AND deleted_at IS NULL
         AND target_weight_kg IS NOT NULL AND weight_kg IS NOT NULL
         AND weight_kg < target_weight_kg AND status NOT IN ('sold','dead')`,
      [farmId],
    ),
    query<{ n: string; has: string }>(
      `SELECT COUNT(*)::text AS n,
              CASE WHEN EXISTS (
                SELECT 1 FROM milk_records WHERE farm_id = $1 AND recorded_at::date = CURRENT_DATE
              ) THEN '1' ELSE '0' END AS has
       FROM milk_records WHERE farm_id = $1 AND recorded_at::date = CURRENT_DATE`,
      [farmId],
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM tasks
       WHERE farm_id = $1 AND status IN ('open','in_progress')
         AND (due_at IS NULL OR due_at::date <= CURRENT_DATE)`,
      [farmId],
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM finance_entries
       WHERE farm_id = $1 AND entry_type = 'expense' AND entry_date = CURRENT_DATE`,
      [farmId],
    ),
  ]);

  return {
    attention: Number(sick.rows[0].n),
    vaccinations: Number(vaccines.rows[0].n),
    calvings: Number(calvings.rows[0].n),
    lowWeight: Number(lowWeight.rows[0].n),
    milkRecorded: milkToday.rows[0].has === '1',
    milkLiters: Number(milkToday.rows[0].n),
    pendingTasks: Number(openTasks.rows[0].n),
    expensesToday: Number(expensesToday.rows[0].n),
  };
}

function buildTodaysWorkflow(
  counts: Awaited<ReturnType<typeof loadWorkflowCounts>>,
  completed: Set<string>,
): WorkflowItem[] {
  const items: WorkflowItem[] = [
    {
      key: 'attention',
      label: `Check ${counts.attention} animal${counts.attention === 1 ? '' : 's'} requiring attention`,
      count: counts.attention,
      route: '/animals?status=sick',
      completed: completed.has('attention') || counts.attention === 0,
      priority: counts.attention > 0 ? 'urgent' : 'normal',
    },
    {
      key: 'vaccinations',
      label: `Give vaccination to ${counts.vaccinations} animal${counts.vaccinations === 1 ? '' : 's'}`,
      count: counts.vaccinations,
      route: '/health',
      completed: completed.has('vaccinations') || counts.vaccinations === 0,
      priority: counts.vaccinations > 0 ? 'high' : 'normal',
    },
    {
      key: 'calvings',
      label: `Check expected calving for ${counts.calvings} animal${counts.calvings === 1 ? '' : 's'}`,
      count: counts.calvings,
      route: '/breeding',
      completed: completed.has('calvings') || counts.calvings === 0,
      priority: counts.calvings > 0 ? 'high' : 'normal',
    },
    {
      key: 'feeding',
      label: 'Feed animals',
      count: 0,
      route: '/feed',
      completed: completed.has('feeding'),
      priority: 'normal',
    },
    {
      key: 'milk',
      label: counts.milkRecorded
        ? `Milk recorded today (${counts.milkLiters} entries)`
        : 'Record today\'s milk production',
      count: counts.milkLiters,
      route: '/milking',
      completed: completed.has('milk') || counts.milkRecorded,
      priority: counts.milkRecorded ? 'low' : 'high',
    },
    {
      key: 'low_weight',
      label: `Check ${counts.lowWeight} animal${counts.lowWeight === 1 ? '' : 's'} below target weight`,
      count: counts.lowWeight,
      route: '/animals?filter=low_weight',
      completed: completed.has('low_weight') || counts.lowWeight === 0,
      priority: counts.lowWeight > 0 ? 'high' : 'normal',
    },
    {
      key: 'expenses',
      label: 'Review today\'s expenses',
      count: counts.expensesToday,
      route: '/finance',
      completed: completed.has('expenses'),
      priority: 'normal',
    },
    {
      key: 'tasks',
      label: `Review ${counts.pendingTasks} pending task${counts.pendingTasks === 1 ? '' : 's'}`,
      count: counts.pendingTasks,
      route: '/tasks',
      completed: completed.has('tasks') || counts.pendingTasks === 0,
      priority: counts.pendingTasks > 0 ? 'high' : 'normal',
    },
  ];
  return items;
}
