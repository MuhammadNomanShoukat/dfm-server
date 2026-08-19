import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireFarm);

const DEFAULT_WIDGETS = [
  'totalAnimals',
  'lactating',
  'dry',
  'pregnant',
  'sick',
  'milkToday',
  'milkWeek',
  'milkMonth',
  'revenue',
  'expenses',
  'profit',
  'feedConsumption',
  'upcomingVaccinations',
  'upcomingDeliveries',
  'aiAlerts',
];

dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const kpis = await loadKpis(farmId);
    const milkTrend = await query<{ day: string; liters: string }>(
      `SELECT to_char(recorded_at::date, 'YYYY-MM-DD') AS day,
              SUM(quantity_liters)::text AS liters
       FROM milk_records
       WHERE farm_id = $1 AND recorded_at >= now() - interval '30 days'
       GROUP BY recorded_at::date
       ORDER BY day`,
      [farmId],
    );
    const alerts = await query(
      `SELECT id, alert_type, severity, title, body, created_at
       FROM ai_alerts WHERE farm_id = $1 AND is_open = true
       ORDER BY created_at DESC LIMIT 8`,
      [farmId],
    );
    const layout = await query<{ widgets: string[] }>(
      `SELECT widgets FROM dashboard_layouts WHERE user_id = $1 AND farm_id = $2`,
      [req.auth?.userId, farmId],
    );
    res.json({
      kpis,
      milkTrend: milkTrend.rows,
      alerts: alerts.rows,
      widgets: layout.rows[0]?.widgets ?? DEFAULT_WIDGETS,
      catalog: DEFAULT_WIDGETS,
    });
  }),
);

const layoutSchema = z.object({
  widgets: z.array(z.string()).min(1).max(20),
});

dashboardRouter.put(
  '/layout',
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = layoutSchema.parse(req.body);
    const allowed = body.widgets.filter((id) => DEFAULT_WIDGETS.includes(id));
    await query(
      `INSERT INTO dashboard_layouts (user_id, farm_id, widgets)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id, farm_id) DO UPDATE SET widgets = EXCLUDED.widgets`,
      [req.auth?.userId, farmId, JSON.stringify(allowed)],
    );
    res.json({ widgets: allowed });
  }),
);

async function loadKpis(farmId: string) {
  const herd = await query<{
    total_animals: string;
    lactating: string;
    dry: string;
    pregnant: string;
    sick: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE deleted_at IS NULL AND status NOT IN ('sold','dead'))::text AS total_animals,
       COUNT(*) FILTER (WHERE status = 'lactating' AND deleted_at IS NULL)::text AS lactating,
       COUNT(*) FILTER (WHERE status = 'dry' AND deleted_at IS NULL)::text AS dry,
       COUNT(*) FILTER (WHERE status = 'pregnant' AND deleted_at IS NULL)::text AS pregnant,
       COUNT(*) FILTER (WHERE status = 'sick' AND deleted_at IS NULL)::text AS sick
     FROM animals WHERE farm_id = $1`,
    [farmId],
  );

  const milk = await query<{ today: string; week: string; month: string }>(
    `SELECT
       COALESCE(SUM(quantity_liters) FILTER (WHERE recorded_at::date = CURRENT_DATE), 0)::text AS today,
       COALESCE(SUM(quantity_liters) FILTER (WHERE recorded_at >= date_trunc('week', CURRENT_DATE)), 0)::text AS week,
       COALESCE(SUM(quantity_liters) FILTER (WHERE recorded_at >= date_trunc('month', CURRENT_DATE)), 0)::text AS month
     FROM milk_records WHERE farm_id = $1`,
    [farmId],
  );

  const money = await query<{ revenue: string; expenses: string }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE entry_type = 'income' AND entry_date >= date_trunc('month', CURRENT_DATE)), 0)::text AS revenue,
       COALESCE(SUM(amount) FILTER (WHERE entry_type = 'expense' AND entry_date >= date_trunc('month', CURRENT_DATE)), 0)::text AS expenses
     FROM finance_entries WHERE farm_id = $1`,
    [farmId],
  );

  const feed = await query<{ qty: string }>(
    `SELECT COALESCE(SUM(quantity), 0)::text AS qty
     FROM feed_consumptions
     WHERE farm_id = $1 AND consumed_at >= date_trunc('month', CURRENT_DATE)`,
    [farmId],
  );

  const vaccines = await query(
    `SELECT v.id, a.animal_code, a.name, v.vaccine_name, v.next_due_on
     FROM vaccinations v
     JOIN animals a ON a.id = v.animal_id
     WHERE v.farm_id = $1 AND v.next_due_on IS NOT NULL
       AND v.next_due_on <= CURRENT_DATE + 14
     ORDER BY v.next_due_on
     LIMIT 10`,
    [farmId],
  );

  const deliveries = await query(
    `SELECT b.id, a.animal_code, a.name, b.expected_calving_date
     FROM breeding_records b
     JOIN animals a ON a.id = b.animal_id
     WHERE b.farm_id = $1 AND b.event_kind IN ('artificial_insemination','natural_breeding','pregnancy_check')
       AND b.expected_calving_date IS NOT NULL
       AND b.expected_calving_date <= CURRENT_DATE + 21
     ORDER BY b.expected_calving_date
     LIMIT 10`,
    [farmId],
  );

  const row = herd.rows[0];
  const milkRow = milk.rows[0];
  const moneyRow = money.rows[0];
  const revenue = Number(moneyRow.revenue);
  const expenses = Number(moneyRow.expenses);

  return {
    totalAnimals: Number(row.total_animals),
    lactating: Number(row.lactating),
    dry: Number(row.dry),
    pregnant: Number(row.pregnant),
    sick: Number(row.sick),
    milkToday: Number(milkRow.today),
    milkWeek: Number(milkRow.week),
    milkMonth: Number(milkRow.month),
    revenue,
    expenses,
    profit: revenue - expenses,
    feedConsumption: Number(feed.rows[0].qty),
    upcomingVaccinations: vaccines.rows,
    upcomingDeliveries: deliveries.rows,
  };
}
