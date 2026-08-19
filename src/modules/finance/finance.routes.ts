import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { writeAudit } from '../../middleware/audit.js';
import { requireAccess, requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';

export const financeRouter = Router();
financeRouter.use(requireAuth, requireFarm);

financeRouter.get(
  '/',
  requireAccess('finance_read'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const items = await query(
      `SELECT * FROM finance_entries WHERE farm_id = $1 ORDER BY entry_date DESC, created_at DESC LIMIT 400`,
      [farmId],
    );
    const summary = await query<{ income: string; expense: string }>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE entry_type = 'income'), 0)::text AS income,
         COALESCE(SUM(amount) FILTER (WHERE entry_type = 'expense'), 0)::text AS expense
       FROM finance_entries
       WHERE farm_id = $1 AND entry_date >= date_trunc('month', CURRENT_DATE)`,
      [farmId],
    );
    const income = Number(summary.rows[0].income);
    const expense = Number(summary.rows[0].expense);
    res.json({
      items: items.rows,
      pnl: { income, expense, profit: income - expense },
    });
  }),
);

const schema = z.object({
  entryType: z.enum(['income', 'expense']),
  category: z.string().min(1).max(60),
  amount: z.number().nonnegative(),
  entryDate: z.string(),
  description: z.string().max(500).optional().nullable(),
});

financeRouter.post(
  '/',
  requireAccess('finance_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = schema.parse(req.body);
    const inserted = await query(
      `INSERT INTO finance_entries (farm_id, entry_type, category, amount, entry_date, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [farmId, body.entryType, body.category, body.amount, body.entryDate, body.description ?? null, req.auth?.userId],
    );
    await writeAudit(req, 'finance.create', 'finance_entry', inserted.rows[0].id as string, body.category);
    res.status(201).json({ item: inserted.rows[0] });
  }),
);
