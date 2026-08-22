import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';
import { ollamaChat } from './ollama.js';
import { generateReport, type ReportType } from './reports.service.js';
import { requirePlanFeature } from '../subscription/subscription.service.js';

export const aiRouter = Router();
aiRouter.use(requireAuth, requireFarm);

aiRouter.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const generated = await generateRuleAlerts(farmId);
    res.json({ items: generated });
  }),
);

const askSchema = z.object({
  question: z.string().min(3).max(800),
});

const REPORT_TYPES = ['health', 'feeding', 'financial', 'breeding', 'performance'] as const;

aiRouter.get(
  '/reports/:type',
  requirePlanFeature('aiReports'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const type = req.params.type as ReportType;
    if (!REPORT_TYPES.includes(type)) {
      res.status(400).json({ error: { code: 'INVALID_REPORT', message: 'Unknown report type.' } });
      return;
    }
    const report = await generateReport(farmId, type);
    res.json({ report });
  }),
);

aiRouter.get(
  '/reports',
  asyncHandler(async (_req, res) => {
    res.json({
      types: REPORT_TYPES.map((t) => ({ id: t, label: t.charAt(0).toUpperCase() + t.slice(1) })),
    });
  }),
);

aiRouter.post(
  '/ask',
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const { question } = askSchema.parse(req.body);
    const facts = await buildFacts(farmId);
    const system = `You are HerdOS, a dairy farm assistant. Answer only from FACTS JSON. If the facts do not contain the answer, say you do not know. Do not invent numbers. Be concise for farm operators.`;
    const user = `FACTS:\n${JSON.stringify(facts)}\n\nQUESTION:\n${question.slice(0, 800)}`;
    try {
      const answer = await ollamaChat(system, user);
      res.json({ answer, facts, provider: 'ollama:llama3' });
    } catch {
      res.json({
        answer: fallbackAnswer(facts, question),
        facts,
        provider: 'rules',
      });
    }
  }),
);

async function generateRuleAlerts(farmId: string) {
  const drop = await query<{ animal_code: string; name: string | null; current: string; previous: string }>(
    `WITH recent AS (
       SELECT animal_id, SUM(quantity_liters) AS qty
       FROM milk_records
       WHERE farm_id = $1 AND recorded_at >= now() - interval '7 days'
       GROUP BY animal_id
     ), prior AS (
       SELECT animal_id, SUM(quantity_liters) AS qty
       FROM milk_records
       WHERE farm_id = $1 AND recorded_at >= now() - interval '14 days' AND recorded_at < now() - interval '7 days'
       GROUP BY animal_id
     )
     SELECT a.animal_code, a.name, recent.qty::text AS current, prior.qty::text AS previous
     FROM recent
     JOIN prior ON prior.animal_id = recent.animal_id
     JOIN animals a ON a.id = recent.animal_id
     WHERE prior.qty > 0 AND recent.qty < prior.qty * 0.8`,
    [farmId],
  );

  const stock = await query<{ name: string; quantity: string; reorder_level: string }>(
    `SELECT t.name, i.quantity::text, i.reorder_level::text
     FROM feed_inventory i JOIN feed_types t ON t.id = i.feed_type_id
     WHERE i.farm_id = $1 AND i.quantity <= i.reorder_level`,
    [farmId],
  );

  const vax = await query<{ animal_code: string; vaccine_name: string; next_due_on: string }>(
    `SELECT a.animal_code, v.vaccine_name, v.next_due_on::text
     FROM vaccinations v JOIN animals a ON a.id = v.animal_id
     WHERE v.farm_id = $1 AND v.next_due_on <= CURRENT_DATE + 7`,
    [farmId],
  );

  const alerts = [
    ...drop.rows.map((row) => ({
      type: 'production_drop',
      severity: 'warning',
      title: `Yield drop ${row.animal_code}`,
      body: `${row.name ?? row.animal_code} produced ${row.current} L this week vs ${row.previous} L last week.`,
    })),
    ...stock.rows.map((row) => ({
      type: 'low_stock',
      severity: 'warning',
      title: `Low feed: ${row.name}`,
      body: `Stock ${row.quantity} is at or below reorder level ${row.reorder_level}.`,
    })),
    ...vax.rows.map((row) => ({
      type: 'vaccination_due',
      severity: 'info',
      title: `Vaccine due ${row.animal_code}`,
      body: `${row.vaccine_name} due ${row.next_due_on}.`,
    })),
  ];

  await query(`UPDATE ai_alerts SET is_open = false WHERE farm_id = $1`, [farmId]);
  for (const alert of alerts) {
    await query(
      `INSERT INTO ai_alerts (farm_id, alert_type, severity, title, body, facts)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`,
      [farmId, alert.type, alert.severity, alert.title, alert.body],
    );
  }
  return alerts;
}

async function buildFacts(farmId: string) {
  const dash = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM animals WHERE farm_id = $1 AND deleted_at IS NULL AND status NOT IN ('sold','dead')`, [farmId]);
  const milk = await query<{ today: string }>(
    `SELECT COALESCE(SUM(quantity_liters),0)::text AS today FROM milk_records WHERE farm_id = $1 AND recorded_at::date = CURRENT_DATE`,
    [farmId],
  );
  const sick = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM animals WHERE farm_id = $1 AND status = 'sick' AND deleted_at IS NULL`, [farmId]);
  const tasks = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tasks WHERE farm_id = $1 AND status IN ('open','in_progress')`, [farmId]);
  return {
    activeAnimals: Number(dash.rows[0].n),
    milkTodayLiters: Number(milk.rows[0].today),
    sickAnimals: Number(sick.rows[0].n),
    openTasks: Number(tasks.rows[0].n),
    generatedAt: new Date().toISOString(),
  };
}

function fallbackAnswer(facts: Awaited<ReturnType<typeof buildFacts>>, question: string): string {
  const q = question.toLowerCase();
  if (q.includes('milk')) {
    return `Today's recorded yield is ${facts.milkTodayLiters} litres (from farm records).`;
  }
  if (q.includes('sick') || q.includes('health')) {
    return `There are ${facts.sickAnimals} sick animals on this farm.`;
  }
  return `Active animals: ${facts.activeAnimals}. Milk today: ${facts.milkTodayLiters} L. Open tasks: ${facts.openTasks}. Local llama3 was not reachable, so this is a records-only answer.`;
}
