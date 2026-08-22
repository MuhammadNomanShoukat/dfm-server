import { query } from '../../db/pool.js';
import { ollamaChat } from './ollama.js';

export type ReportType = 'health' | 'feeding' | 'financial' | 'breeding' | 'performance';

export type ReportSection = {
  kind: 'recorded' | 'insight';
  title: string;
  body: string;
  facts?: Record<string, unknown>;
};

export type AiReport = {
  type: ReportType;
  title: string;
  generatedAt: string;
  sections: ReportSection[];
  provider: string;
  disclaimer: string;
};

const DISCLAIMER =
  'Recorded data comes from your farm database. AI insights are suggestions only — verify before acting.';

export async function generateReport(farmId: string, type: ReportType): Promise<AiReport> {
  const facts = await buildReportFacts(farmId, type);
  const recorded = buildRecordedSections(type, facts);
  let insightSections: ReportSection[] = [];
  let provider = 'rules';

  try {
    const system = `You are HerdOS farm analyst. Use ONLY the FACTS JSON. Write 2-3 short paragraphs for farm owners. Label recommendations clearly. Do not invent numbers.`;
    const user = `Report type: ${type}\nFACTS:\n${JSON.stringify(facts)}\n\nWrite actionable insights and opportunities.`;
    const text = await ollamaChat(system, user);
    insightSections = [{ kind: 'insight', title: 'AI insights & recommendations', body: text }];
    provider = 'ollama:llama3';
  } catch {
    insightSections = [{ kind: 'insight', title: 'Insights (records only)', body: buildFallbackInsight(type, facts) }];
  }

  return {
    type,
    title: reportTitle(type),
    generatedAt: new Date().toISOString(),
    sections: [...recorded, ...insightSections],
    provider,
    disclaimer: DISCLAIMER,
  };
}

function reportTitle(type: ReportType): string {
  const titles: Record<ReportType, string> = {
    health: 'Animal Health Report',
    feeding: 'Feeding Report',
    financial: 'Financial Report',
    breeding: 'Breeding Report',
    performance: 'Farm Performance Report',
  };
  return titles[type];
}

async function buildReportFacts(farmId: string, type: ReportType): Promise<Record<string, unknown>> {
  const base = { farmId, reportType: type, generatedAt: new Date().toISOString() };

  if (type === 'health' || type === 'performance') {
    const sick = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM animals WHERE farm_id = $1 AND status = 'sick' AND deleted_at IS NULL`,
      [farmId],
    );
    const weightLoss = await query<{ animal_code: string; drop_kg: string }>(
      `SELECT a.animal_code, (prev.weight_kg - curr.weight_kg)::text AS drop_kg
       FROM animals a
       JOIN LATERAL (
         SELECT weight_kg FROM animal_weight_records w WHERE w.animal_id = a.id
         ORDER BY recorded_at DESC LIMIT 1
       ) curr ON true
       JOIN LATERAL (
         SELECT weight_kg FROM animal_weight_records w WHERE w.animal_id = a.id
         ORDER BY recorded_at DESC OFFSET 1 LIMIT 1
       ) prev ON true
       WHERE a.farm_id = $1 AND prev.weight_kg > curr.weight_kg
         AND curr.weight_kg IS NOT NULL AND prev.weight_kg IS NOT NULL
       LIMIT 10`,
      [farmId],
    );
    return { ...base, sickCount: Number(sick.rows[0].n), weightLossAnimals: weightLoss.rows };
  }

  if (type === 'feeding') {
    const consumption = await query<{ month: string; qty: string }>(
      `SELECT to_char(date_trunc('month', consumed_at), 'YYYY-MM') AS month,
              SUM(quantity)::text AS qty
       FROM feed_consumptions WHERE farm_id = $1
         AND consumed_at >= date_trunc('month', CURRENT_DATE - interval '2 months')
       GROUP BY date_trunc('month', consumed_at) ORDER BY month`,
      [farmId],
    );
    return { ...base, monthlyConsumption: consumption.rows };
  }

  if (type === 'financial') {
    const breakdown = await query<{ category: string; amount: string }>(
      `SELECT category, SUM(amount)::text AS amount
       FROM finance_entries
       WHERE farm_id = $1 AND entry_type = 'expense'
         AND entry_date >= date_trunc('month', CURRENT_DATE)
       GROUP BY category ORDER BY SUM(amount) DESC`,
      [farmId],
    );
    const total = breakdown.rows.reduce((s, r) => s + Number(r.amount), 0);
    return { ...base, expenseBreakdown: breakdown.rows, monthExpenseTotal: total };
  }

  if (type === 'breeding') {
    const calving = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM breeding_records
       WHERE farm_id = $1 AND expected_calving_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30`,
      [farmId],
    );
    const pregnant = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM animals WHERE farm_id = $1 AND status = 'pregnant' AND deleted_at IS NULL`,
      [farmId],
    );
    return { ...base, calvingNext30Days: Number(calving.rows[0].n), pregnantCount: Number(pregnant.rows[0].n) };
  }

  const milk = await query<{ today: string; week: string }>(
    `SELECT COALESCE(SUM(quantity_liters) FILTER (WHERE recorded_at::date = CURRENT_DATE),0)::text AS today,
            COALESCE(SUM(quantity_liters) FILTER (WHERE recorded_at >= date_trunc('week', CURRENT_DATE)),0)::text AS week
     FROM milk_records WHERE farm_id = $1`,
    [farmId],
  );
  const tasks = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM tasks WHERE farm_id = $1 AND status IN ('open','in_progress')`,
    [farmId],
  );
  return {
    ...base,
    milkToday: Number(milk.rows[0].today),
    milkWeek: Number(milk.rows[0].week),
    openTasks: Number(tasks.rows[0].n),
  };
}

function buildRecordedSections(type: ReportType, facts: Record<string, unknown>): ReportSection[] {
  switch (type) {
    case 'health': {
      const loss = facts.weightLossAnimals as { animal_code: string; drop_kg: string }[] | undefined;
      const lossText =
        loss && loss.length > 0
          ? `${loss.length} animal(s) show weight loss: ${loss.map((a) => a.animal_code).join(', ')}.`
          : 'No repeated weight loss detected in recent records.';
      return [
        {
          kind: 'recorded',
          title: 'Recorded health status',
          body: `${facts.sickCount} sick animal(s) on record. ${lossText}`,
          facts: { sickCount: facts.sickCount, weightLossAnimals: facts.weightLossAnimals },
        },
      ];
    }
    case 'feeding': {
      const rows = facts.monthlyConsumption as { month: string; qty: string }[] | undefined;
      let body = 'No feed consumption records this period.';
      if (rows && rows.length >= 2) {
        const curr = Number(rows[rows.length - 1].qty);
        const prev = Number(rows[rows.length - 2].qty);
        const pct = prev > 0 ? Math.round(((curr - prev) / prev) * 100) : 0;
        body = `Feed consumption ${pct >= 0 ? 'increased' : 'decreased'} by ${Math.abs(pct)}% this month vs previous (${curr} vs ${prev} kg).`;
      } else if (rows?.length === 1) {
        body = `This month: ${rows[0].qty} kg consumed (recorded).`;
      }
      return [{ kind: 'recorded', title: 'Recorded feed consumption', body, facts: { monthlyConsumption: rows } }];
    }
    case 'financial': {
      const breakdown = facts.expenseBreakdown as { category: string; amount: string }[] | undefined;
      const total = Number(facts.monthExpenseTotal ?? 0);
      let body = 'No expense records this month.';
      if (breakdown && breakdown.length > 0 && total > 0) {
        const top = breakdown[0];
        const pct = Math.round((Number(top.amount) / total) * 100);
        body = `${top.category} represents ${pct}% of total farm expenses this month (₨ ${total.toLocaleString()}).`;
      }
      return [{ kind: 'recorded', title: 'Recorded finances', body, facts: { expenseBreakdown: breakdown, total } }];
    }
    case 'breeding':
      return [
        {
          kind: 'recorded',
          title: 'Recorded breeding status',
          body: `${facts.calvingNext30Days} animal(s) expected to calve within 30 days. ${facts.pregnantCount} currently marked pregnant.`,
          facts: { calvingNext30Days: facts.calvingNext30Days, pregnantCount: facts.pregnantCount },
        },
      ];
    default:
      return [
        {
          kind: 'recorded',
          title: 'Key metrics (recorded)',
          body: `Milk today: ${facts.milkToday} L. Weekly: ${facts.milkWeek} L. Open tasks: ${facts.openTasks}.`,
          facts: { milkToday: facts.milkToday, milkWeek: facts.milkWeek, openTasks: facts.openTasks },
        },
      ];
  }
}

function buildFallbackInsight(type: ReportType, facts: Record<string, unknown>): string {
  if (type === 'health' && Number(facts.sickCount) > 0) {
    return `Review sick animals promptly. Consider scheduling a vet visit for animals with repeated weight loss.`;
  }
  if (type === 'breeding' && Number(facts.calvingNext30Days) > 0) {
    return `Prepare calving pens and monitor ${facts.calvingNext30Days} expected calving(s) in the next 30 days.`;
  }
  return 'Local AI was unavailable. Review the recorded data above and consult your farm manager for next steps.';
}
