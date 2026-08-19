import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { writeAudit } from '../../middleware/audit.js';
import { requireAccess, requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';
import { getIo } from '../../ws/io.js';

export const milkingRouter = Router();
milkingRouter.use(requireAuth, requireFarm);

const milkSchema = z.object({
  animalId: z.string().uuid(),
  recordedAt: z.string().optional(),
  shift: z.enum(['morning', 'evening', 'night']),
  quantityLiters: z.number().nonnegative(),
  fatPct: z.number().min(0).max(20).optional().nullable(),
  proteinPct: z.number().min(0).max(20).optional().nullable(),
  snfPct: z.number().min(0).max(20).optional().nullable(),
  temperatureC: z.number().min(0).max(50).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

milkingRouter.get(
  '/',
  requireAccess('animals_read'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const from = typeof req.query.from === 'string' ? req.query.from : null;
    const items = await query(
      `SELECT m.*, a.animal_code, a.name AS animal_name, u.full_name AS operator_name
       FROM milk_records m
       JOIN animals a ON a.id = m.animal_id
       LEFT JOIN users u ON u.id = m.operator_id
       WHERE m.farm_id = $1
         AND ($2::date IS NULL OR m.recorded_at::date >= $2::date)
       ORDER BY m.recorded_at DESC
       LIMIT 400`,
      [farmId, from],
    );
    res.json({ items: items.rows });
  }),
);

milkingRouter.post(
  '/',
  requireAccess('milking_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = milkSchema.parse(req.body);
    const inserted = await query(
      `INSERT INTO milk_records (
         farm_id, animal_id, recorded_at, shift, quantity_liters, fat_pct, protein_pct, snf_pct, temperature_c, operator_id, notes
       ) VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        farmId,
        body.animalId,
        body.recordedAt ?? null,
        body.shift,
        body.quantityLiters,
        body.fatPct ?? null,
        body.proteinPct ?? null,
        body.snfPct ?? null,
        body.temperatureC ?? null,
        req.auth?.userId,
        body.notes ?? null,
      ],
    );
    await query(
      `INSERT INTO animal_events (farm_id, animal_id, event_type, title, details, created_by)
       VALUES ($1,$2,'milk','Milking recorded',$3::jsonb,$4)`,
      [farmId, body.animalId, JSON.stringify({ liters: body.quantityLiters, shift: body.shift }), req.auth?.userId],
    );
    await writeAudit(req, 'milk.create', 'milk_record', inserted.rows[0].id as string, `${body.quantityLiters} L`);
    getIo()?.to(`farm:${farmId}`).emit('dashboard:invalidate');
    res.status(201).json({ item: inserted.rows[0] });
  }),
);
